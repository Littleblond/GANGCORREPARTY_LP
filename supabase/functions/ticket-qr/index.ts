// ticket-qr — pagina do ingresso (ingresso.html). Recebe o code do ticket e
// devolve nome + status + QR em SVG. Leitura pura: NUNCA marca o ingresso como
// usado (isso e so da validate-ticket, na portaria).
// So responde se o pedido estiver 'paid'. Qualquer outro caso -> not_found
// (mesmo anti-vazamento do order-status: nao diferencia inexistente de nao-pago).
import { createClient } from "npm:@supabase/supabase-js@2";
import QR from "npm:qrcode@1";

const APP_URL = Deno.env.get("APP_URL") ?? "https://gangcorreparty-lp.vercel.app";
const SB_URL  = Deno.env.get("SUPABASE_URL")!;
const SB_SR   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED = new Set([APP_URL, "http://localhost:8802", "http://localhost:8801", "http://localhost:5500"]);
function corsHeaders(origin: string | null) {
  const o = origin && ALLOWED.has(origin) ? origin : APP_URL;
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (b: unknown, s: number, h: Record<string, string>) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...h } });

// remove caracteres de controle sem usar regex de control-char no fonte
const clean = (s: unknown, max: number) =>
  String(s ?? "")
    .split("")
    .filter((c) => { const n = c.charCodeAt(0); return n >= 32 && n !== 127; })
    .join("")
    .trim()
    .slice(0, max);

// code gerado pela gcp_confirm_payment: 2 uuids sem hifen (64 hex). Aceita
// tambem formato com hifen pra nao travar se o gerador mudar.
const isCode = (s: string) => /^[0-9a-f-]{20,80}$/i.test(s);

// throttle best-effort por isolate (mesmo padrao da order-status)
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
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) return json({ error: "rate_limited" }, 429, cors);

  const code = clean(new URL(req.url).searchParams.get("tk"), 100);
  if (!isCode(code)) return json({ error: "not_found" }, 404, cors);

  const db = createClient(SB_URL, SB_SR, { auth: { persistSession: false } });

  const { data: ticket, error: tErr } = await db
    .from("gcp_tickets")
    .select("order_id, status")
    .eq("code", code)
    .maybeSingle();
  if (tErr) return json({ error: "server_error" }, 500, cors);
  if (!ticket) return json({ error: "not_found" }, 404, cors);

  const { data: order, error: oErr } = await db
    .from("gcp_orders")
    .select("status, customer_name")
    .eq("id", ticket.order_id)
    .maybeSingle();
  if (oErr) return json({ error: "server_error" }, 500, cors);
  // pedido nao pago = mesma resposta de inexistente (nao vaza pedido pendente)
  if (!order || order.status !== "paid") return json({ error: "not_found" }, 404, cors);

  // So o primeiro nome, igual a validate-ticket: o link do ingresso e privado,
  // mas nao ha motivo pra devolver o nome completo pra tela do QR.
  const name = clean(order.customer_name, 120).split(" ")[0] ?? "";

  let svg = "";
  try {
    svg = await QR.toString(code, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  } catch (_e) {
    return json({ error: "server_error" }, 500, cors);
  }

  return json({ name, ticket_status: ticket.status, svg }, 200, cors);
});
