// order-status — status REAL do pedido pra página de sucesso.
// Exige order_nsu + public_token (anti-enumeração). Nunca marca pago; só lê.
import { createClient } from "npm:@supabase/supabase-js@2";

const APP_URL = Deno.env.get("APP_URL") ?? "https://gangcorreparty-lp.vercel.app";
const SB_URL  = Deno.env.get("SUPABASE_URL")!;
const SB_SR   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED = new Set([APP_URL, "http://localhost:8802", "http://localhost:8801", "http://localhost:5500"]);
function corsHeaders(origin: string | null) {
  const o = origin && ALLOWED.has(origin) ? origin : APP_URL;
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (b: unknown, s: number, h: Record<string, string>) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...h } });
const isUuid = (s: unknown) =>
  typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const hits = new Map<string, number[]>();
function rateLimited(ip: string, max = 30, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) return json({ error: "rate_limited" }, 429, cors);

  let order_nsu = "", token = "";
  if (req.method === "GET") {
    const u = new URL(req.url);
    order_nsu = u.searchParams.get("order") ?? "";
    token = u.searchParams.get("t") ?? "";
  } else if (req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    order_nsu = String(b?.order_nsu ?? "");
    token = String(b?.public_token ?? b?.t ?? "");
  } else {
    return json({ error: "method_not_allowed" }, 405, cors);
  }

  if (!isUuid(order_nsu) || !isUuid(token)) return json({ error: "not_found" }, 404, cors);

  const db = createClient(SB_URL, SB_SR, { auth: { persistSession: false } });
  const { data: order } = await db
    .from("gcp_orders")
    .select("status, expected_amount, paid_amount, payment_method, receipt_url")
    .eq("order_nsu", order_nsu)
    .eq("public_token", token)
    .maybeSingle();

  // token errado ou pedido inexistente -> mesma resposta genérica (anti-enumeração)
  if (!order) return json({ error: "not_found" }, 404, cors);

  return json({
    status: order.status,
    paid: order.status === "paid",
    amount: order.expected_amount,
    paid_amount: order.paid_amount,
    method: order.payment_method,
    receipt_url: order.status === "paid" ? order.receipt_url : null,
  }, 200, cors);
});
