// infinitepay-webhook — recebe aviso de pagamento da InfinitePay.
// Como a InfinitePay NAO assina o webhook, NUNCA confiamos no corpo recebido:
// confirmamos via payment_check e só então liberamos, de forma atômica e idempotente.
import { createClient } from "npm:@supabase/supabase-js@2";

const HANDLE  = Deno.env.get("INFINITEPAY_HANDLE") ?? "nathalialouise";
const IP_BASE = Deno.env.get("INFINITEPAY_API_BASE_URL") ?? "https://api.checkout.infinitepay.io";
const SB_URL  = Deno.env.get("SUPABASE_URL")!;
const SB_SR   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  // validação de formato/tipos dos campos obrigatórios
  const order_nsu = str(b?.order_nsu);
  const transaction_nsu = str(b?.transaction_nsu);
  const slug = str(b?.invoice_slug ?? b?.slug);
  if (!isUuid(order_nsu) || !transaction_nsu || !slug)
    return json({ error: "invalid_payload" }, 400);

  const receipt_url = str(b?.receipt_url);
  const event_key = `wh:${order_nsu}:${transaction_nsu}`;

  const db = createClient(SB_URL, SB_SR, { auth: { persistSession: false } });

  // Confirmação obrigatória na fonte (não confia no corpo do webhook).
  const chk = await paymentCheck(order_nsu, transaction_nsu, slug);
  if (chk === null) {
    // provedor indisponível -> devolve erro pra InfinitePay reenviar depois (idempotência cobre)
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

  // paid / already_paid / duplicate_event -> ok, para de reenviar.
  // amount_mismatch / txn_reused / sold_out / order_not_found -> registrado; responde 200 pra nao entrar em loop de retry.
  return json({ success: true, result }, 200);
});
