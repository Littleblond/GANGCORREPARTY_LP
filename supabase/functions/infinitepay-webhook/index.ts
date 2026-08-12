// infinitepay-webhook — recebe aviso de pagamento da InfinitePay.
// Como a InfinitePay NAO assina o webhook, NUNCA confiamos no corpo recebido:
// confirmamos via payment_check e só então liberamos, de forma atômica e idempotente.
import { createClient } from "npm:@supabase/supabase-js@2";

const HANDLE  = Deno.env.get("INFINITEPAY_HANDLE") ?? "nathalialouise";
const IP_BASE = Deno.env.get("INFINITEPAY_API_BASE_URL") ?? "https://api.checkout.infinitepay.io";
const SB_URL  = Deno.env.get("SUPABASE_URL")!;
const SB_SR   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// --- Meta Conversions API (opcional: sem as duas vars, nao faz nada) ---
const META_PIXEL_ID   = Deno.env.get("META_PIXEL_ID") ?? "";
const META_CAPI_TOKEN = Deno.env.get("META_CAPI_TOKEN") ?? "";
const META_TEST_CODE  = Deno.env.get("META_TEST_EVENT_CODE") ?? ""; // so pra Testar Eventos
const APP_URL         = Deno.env.get("APP_URL") ?? "https://gangcorreparty-lp.vercel.app";

const sha256 = async (v: string) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

// O Meta exige normalizar ANTES de hashear, senao nao casa:
// minusculo, sem espaco, telefone so digito com codigo do pais.
const normPhone = (v: string) => {
  const d = String(v ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("55")) return d;
  // numero brasileiro digitado sem o 55 (DDD + 8 ou 9 digitos)
  if (d.length === 10 || d.length === 11) return "55" + d;
  return d;
};
const normText = (v: string) =>
  String(v ?? "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

async function sendPurchaseToMeta(order: any, valueCents: number) {
  if (!META_PIXEL_ID || !META_CAPI_TOKEN) return;

  const user_data: Record<string, unknown> = {};
  const ph = normPhone(order?.customer_phone ?? "");
  if (ph) user_data.ph = [await sha256(ph)];
  const em = normText(order?.customer_email ?? "");
  if (em) user_data.em = [await sha256(em)];

  // "Fulano de Tal (+ Beltrano)" -> so o comprador interessa pro casamento
  const nome = normText(String(order?.customer_name ?? "").split("(")[0]);
  const partes = nome.split(/\s+/).filter(Boolean);
  if (partes.length) user_data.fn = [await sha256(partes[0])];
  if (partes.length > 1) user_data.ln = [await sha256(partes[partes.length - 1])];

  // fbp/fbc vao em texto puro (NAO hasheados) — regra do Meta.
  if (order?.fbp) user_data.fbp = order.fbp;
  if (order?.fbc) user_data.fbc = order.fbc;
  if (order?.client_ip) user_data.client_ip_address = order.client_ip;
  if (order?.client_ua) user_data.client_user_agent = order.client_ua;

  const payload: Record<string, unknown> = {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(Date.now() / 1000),
      // MESMO id usado no pixel do navegador (pagamento-concluido.html):
      // e o que faz o Meta contar UMA venda em vez de duas.
      event_id: order.order_nsu,
      event_source_url: `${APP_URL}/pagamento-concluido.html`,
      action_source: "website",
      user_data,
      custom_data: {
        currency: "BRL",
        value: Number((valueCents / 100).toFixed(2)),
        content_type: "product",
        content_ids: ["gcp-ingresso"],
        content_name: "Ingresso Gang Corre Party",
      },
    }],
  };
  if (META_TEST_CODE) payload.test_event_code = META_TEST_CODE;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    await fetch(
      `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(META_CAPI_TOKEN)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, signal: ac.signal, body: JSON.stringify(payload) },
    );
  } catch { /* rastreio NUNCA pode derrubar a confirmacao de pagamento */ }
  finally { clearTimeout(timer); }
}

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const isUuid = (s: unknown) =>
  typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const str = (v: unknown) => (typeof v === "string" ? v : "");

async function paymentCheck(order_nsu: string, transaction_nsu: string, slug: string) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(`${IP_BASE}/payment_check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ac.signal,
      body: JSON.stringify({ handle: HANDLE, order_nsu, transaction_nsu, slug }),
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Toda chamada que não vira pagamento fica registrada aqui. Sem isso, um webhook
// com payload fora do formato esperado sumia com 400 e não deixava rastro nenhum
// no banco — era impossível saber se a InfinitePay tinha chamado ou não.
async function logRaw(
  db: any, motivo: string, payload: unknown,
  order_nsu?: string, transaction_nsu?: string,
) {
  try {
    await db.from("gcp_payment_events").insert({
      provider: "infinitepay",
      event_key: `raw:${motivo}:${crypto.randomUUID()}`,
      order_nsu: isUuid(order_nsu) ? order_nsu : null,
      transaction_nsu: transaction_nsu || null,
      payload: payload ?? null,
      processing_status: "error",
      processed_at: new Date().toISOString(),
    });
  } catch { /* log nunca pode derrubar o webhook */ }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const db = createClient(SB_URL, SB_SR, { auth: { persistSession: false } });

  // le como texto ANTES de parsear: depois de req.json() o corpo ja foi
  // consumido e nao daria pra guardar o payload cru que quebrou.
  const raw = await req.text().catch(() => "");
  let b: any;
  try {
    b = JSON.parse(raw);
  } catch {
    await logRaw(db, "invalid_json", { _raw: raw.slice(0, 4000) });
    return json({ error: "invalid_json" }, 400);
  }

  // validação de formato/tipos dos campos obrigatórios
  const order_nsu = str(b?.order_nsu);
  const transaction_nsu = str(b?.transaction_nsu);
  const slug = str(b?.invoice_slug ?? b?.slug);
  if (!isUuid(order_nsu) || !transaction_nsu || !slug) {
    await logRaw(db, "invalid_payload", b, order_nsu, transaction_nsu);
    return json({ error: "invalid_payload" }, 400);
  }

  const receipt_url = str(b?.receipt_url);
  const event_key = `wh:${order_nsu}:${transaction_nsu}`;

  // Confirmação obrigatória na fonte (não confia no corpo do webhook).
  const chk = await paymentCheck(order_nsu, transaction_nsu, slug);
  if (chk === null) {
    // provedor indisponível -> devolve erro pra InfinitePay reenviar depois (idempotência cobre).
    // Registra pra dar pra ver se o reenvio realmente acontece.
    await logRaw(db, "verify_unavailable", b, order_nsu, transaction_nsu);
    return json({ error: "verify_unavailable" }, 503);
  }
  if (chk?.success !== true || chk?.paid !== true) {
    // webhook chegou mas o pagamento não está confirmado na fonte: registra e encerra sem liberar
    await db.from("gcp_payment_events").insert({
      provider: "infinitepay", event_key: `${event_key}:unpaid:${Date.now()}`,
      order_nsu, transaction_nsu, payload: b, processing_status: "ignored",
      processed_at: new Date().toISOString(),
    });
    return json({ success: true, note: "not_paid" }, 200);
  }

  // Valores autoritativos vêm do payment_check, não do webhook.
  const amount = Number(chk.amount);
  const paid_amount = Number(chk.paid_amount ?? chk.amount);
  const method = str(chk.capture_method) || null;
  const installments = Number.isInteger(chk.installments) ? chk.installments : null;

  const { data: result, error } = await db.rpc("gcp_confirm_payment", {
    p_event_key: event_key,
    p_order_nsu: order_nsu,
    p_txn_nsu: transaction_nsu,
    p_amount: amount,
    p_paid_amount: paid_amount,
    p_method: method,
    p_installments: installments,
    p_slug: slug,
    p_receipt: receipt_url || null,
    p_payload: b,
  });

  if (error) return json({ error: "server_error" }, 500);

  // Conversions API: SO no "paid". Em already_paid/duplicate_event a InfinitePay
  // esta reenviando um webhook que ja foi processado — mandar de novo inflaria a
  // receita no Gerenciador. Roda em background: a resposta pra InfinitePay nao espera.
  if (result === "paid" && META_PIXEL_ID && META_CAPI_TOKEN) {
    const capi = (async () => {
      try {
        const { data: order } = await db
          .from("gcp_orders")
          .select("order_nsu, customer_name, customer_email, customer_phone, fbp, fbc, client_ip, client_ua")
          .eq("order_nsu", order_nsu)
          .maybeSingle();
        if (order) await sendPurchaseToMeta(order, paid_amount);
      } catch { /* nunca derruba o webhook */ }
    })();
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(capi); else await capi;
  }

  // paid / already_paid / duplicate_event -> ok, para de reenviar.
  // amount_mismatch / txn_reused / sold_out / order_not_found -> registrado; responde 200 pra nao entrar em loop de retry.
  return json({ success: true, result }, 200);
});
