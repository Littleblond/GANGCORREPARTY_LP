// checkout-create — cria pedido interno + link de pagamento InfinitePay.
// Preço e estoque SEMPRE calculados no servidor. Nunca confia no front.
import { createClient } from "npm:@supabase/supabase-js@2";

const HANDLE  = Deno.env.get("INFINITEPAY_HANDLE") ?? "nathalialouise";
const IP_BASE = Deno.env.get("INFINITEPAY_API_BASE_URL") ?? "https://api.checkout.infinitepay.io";
const APP_URL = Deno.env.get("APP_URL") ?? "https://gangcorreparty-lp.vercel.app";
const SB_URL  = Deno.env.get("SUPABASE_URL")!;
const SB_SR   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FN_URL  = `${SB_URL}/functions/v1`;
const MAX_ORDER_CENTS = 500000; // teto de segurança por pedido: R$ 5.000

const ALLOWED = new Set([APP_URL, "http://localhost:8802", "http://localhost:8801", "http://localhost:5500"]);
function corsHeaders(origin: string | null) {
  const o = origin && ALLOWED.has(origin) ? origin : APP_URL;
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (b: unknown, s = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...h } });

// throttle best-effort por isolate (hardening real = store por-IP dedicado)
const hits = new Map<string, number[]>();
function rateLimited(ip: string, max = 8, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
// remove caracteres de controle sem usar regex de control-char no fonte
const clean = (s: unknown, max: number) =>
  String(s ?? "")
    .split("")
    .filter((c) => { const n = c.charCodeAt(0); return n >= 32 && n !== 127; })
    .join("")
    .trim()
    .slice(0, max);
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) return json({ error: "rate_limited" }, 429, cors);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400, cors); }

  // Validação estrita da entrada. O 20 aqui é só sanidade de tipo/faixa (barra
  // payload absurdo antes de bater no banco); o teto REAL é lot.max_per_order
  // (default 6), checado logo depois de ler o lote ativo.
  const quantity = Number(body?.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20)
    return json({ error: "invalid_quantity" }, 400, cors);

  const name  = clean(body?.customer?.name, 120);
  const email = clean(body?.customer?.email, 160).toLowerCase();
  const phone = clean(body?.customer?.phone, 40).replace(/[^\d+]/g, "");
  const cpf   = clean(body?.customer?.cpf, 20).replace(/[^\d]/g, "");
  if (name.length < 2) return json({ error: "invalid_name" }, 400, cors);
  if (email && !isEmail(email)) return json({ error: "invalid_email" }, 400, cors);
  if (phone.length < 8) return json({ error: "invalid_phone" }, 400, cors);

  const lotId = body?.lot_id ? clean(body.lot_id, 60) : null;

  // Cookies do Meta Pixel + user-agent/IP. Guardados no pedido pra CAPI mandar
  // o Purchase com dados de casamento no webhook (server-side). Puramente
  // opcionais: pedido sem eles funciona igual, só atribui pior.
  const fbp = clean(body?.fbp, 100);
  const fbc = clean(body?.fbc, 255);
  const client_ua = clean(req.headers.get("user-agent"), 400);
  const client_ip = ip === "unknown" ? null : ip;

  // Origem da visita. O fbc so diz "veio do Facebook/Instagram" — nao separa
  // anuncio pago de post organico. A UTM separa, e sem depender da atribuicao
  // do Meta. Puramente opcional, igual fbp/fbc: pedido sem isso funciona igual.
  const utm_source       = clean(body?.utm_source, 100);
  const utm_medium       = clean(body?.utm_medium, 100);
  const utm_campaign     = clean(body?.utm_campaign, 200);
  const utm_content      = clean(body?.utm_content, 200);
  const utm_term         = clean(body?.utm_term, 200);
  const landing_referrer = clean(body?.landing_referrer, 400);

  const db = createClient(SB_URL, SB_SR, { auth: { persistSession: false } });

  // preço e disponibilidade: fonte de verdade = banco (price_cents do lote ativo).
  // O PRECO_LOTE do index.html é só vitrine e precisa espelhar este valor.
  let lotQuery = db.from("gcp_ticket_lots").select("*").eq("active", true);
  lotQuery = lotId ? lotQuery.eq("id", lotId) : lotQuery.order("sort", { ascending: true });
  const { data: lots, error: lotErr } = await lotQuery.limit(1);
  if (lotErr) return json({ error: "server_error" }, 500, cors);
  const lot = lots?.[0];
  if (!lot) return json({ error: "sales_closed" }, 409, cors);
  if (quantity > lot.max_per_order) return json({ error: "over_max_per_order" }, 400, cors);
  if (lot.qty_total !== null && lot.qty_sold + quantity > lot.qty_total)
    return json({ error: "sold_out" }, 409, cors);

  const expected = lot.price_cents * quantity;
  if (expected > MAX_ORDER_CENTS) return json({ error: "amount_too_high" }, 400, cors);

  // cria pedido pending
  const order_nsu = crypto.randomUUID();
  const public_token = crypto.randomUUID();
  const { data: order, error: insErr } = await db.from("gcp_orders").insert({
    order_nsu, public_token,
    customer_name: name, customer_email: email || null, customer_phone: phone, customer_cpf: cpf || null,
    status: "pending", expected_amount: expected,
    fbp: fbp || null, fbc: fbc || null, client_ua: client_ua || null, client_ip,
    utm_source: utm_source || null, utm_medium: utm_medium || null,
    utm_campaign: utm_campaign || null, utm_content: utm_content || null,
    utm_term: utm_term || null, landing_referrer: landing_referrer || null,
  }).select("id").single();
  if (insErr || !order) return json({ error: "server_error" }, 500, cors);

  // itens não bloqueiam a chamada à InfinitePay — correm em paralelo e são
  // conferidos antes de responder (pedido sem itens não pode ir pro checkout)
  const itemsIns = db.from("gcp_order_items").insert({
    order_id: order.id, lot_id: lot.id,
    description_snapshot: lot.name, unit_price: lot.price_cents,
    quantity, total_price: expected,
  });

  // cria o link na InfinitePay (com timeout)
  const redirect_url = `${APP_URL}/pagamento-concluido.html?order=${order_nsu}&t=${public_token}`;
  const webhook_url  = `${FN_URL}/infinitepay-webhook`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  let payUrl = "";
  try {
    const [r, itemsRes] = await Promise.all([
      fetch(`${IP_BASE}/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          handle: HANDLE, order_nsu, redirect_url, webhook_url,
          items: [{ quantity, price: lot.price_cents, description: lot.name }],
        }),
      }),
      itemsIns,
    ]);
    if (itemsRes.error) throw new Error("items_insert_failed");
    const data = await r.json().catch(() => ({}));
    payUrl = data?.url ?? "";
    if (!r.ok || !payUrl) throw new Error("no_url");
  } catch (_e) {
    clearTimeout(timer);
    await db.from("gcp_orders").update({ status: "failed" }).eq("id", order.id);
    return json({ error: "payment_provider_unavailable" }, 502, cors);
  }
  clearTimeout(timer);

  // grava o link em background — o comprador não espera esse update pra ser redirecionado
  const saveLink = db.from("gcp_orders")
    .update({ payment_link: payUrl, status: "payment_link_created" })
    .eq("id", order.id)
    .then(() => {});
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(saveLink); else await saveLink;

  // devolve só o necessário pro redirect
  return json({ checkout_url: payUrl, order_nsu, public_token }, 200, cors);
});
