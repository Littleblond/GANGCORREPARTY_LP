// validate-ticket — portaria. Staff autentica com token; valida ingresso use-once.
// So confirma via RPC atomica (gcp_validate_ticket). Nunca marca 2x o mesmo ingresso.
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
const clean = (s: unknown, max: number) =>
  String(s ?? "").split("").filter((c) => { const n = c.charCodeAt(0); return n >= 32 && n !== 127; }).join("").trim().slice(0, max);

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "invalid_json" }, 400, cors); }

  const staffToken = clean(b?.token, 200);
  const code = clean(b?.code, 200);
  const operator = clean(b?.operator, 60) || "portaria";
  if (!staffToken || !code) return json({ error: "invalid_payload" }, 400, cors);

  const db = createClient(SB_URL, SB_SR, { auth: { persistSession: false } });

  // Autentica o operador pelo hash do token
  const tokenHash = await sha256(staffToken);
  const { data: staff } = await db.from("gcp_staff_tokens")
    .select("id").eq("token_hash", tokenHash).eq("active", true).maybeSingle();
  if (!staff) return json({ error: "unauthorized" }, 401, cors);

  // Validacao atomica use-once
  const { data: result, error } = await db.rpc("gcp_validate_ticket", { p_code: code, p_operator: operator });
  if (error) return json({ error: "server_error" }, 500, cors);

  return json(result, 200, cors);
});
