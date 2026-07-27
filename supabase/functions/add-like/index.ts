// add-like — incrementa o contador de likes do line-up.
// A RPC gcp_add_like e revogada de anon/authenticated: escrever no contador so
// passa por aqui, com rate limit por IP (antes, qualquer script inflava o numero).
// Leitura (gcp_get_likes) continua RPC publica — e so um numero.
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (b: unknown, s: number, h: Record<string, string>) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...h } });

// throttle best-effort por isolate (mesmo padrao das outras functions)
const hits = new Map<string, number[]>();
function rateLimited(ip: string, max = 10, windowMs = 60000) {
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
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) return json({ error: "rate_limited" }, 429, cors);

  const db = createClient(SB_URL, SB_SR, { auth: { persistSession: false } });
  const { data, error } = await db.rpc("gcp_add_like");
  if (error) return json({ error: "server_error" }, 500, cors);

  return json({ total: Number(data) || 0 }, 200, cors);
});
