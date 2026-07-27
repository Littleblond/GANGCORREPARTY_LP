// submit-lead — porta unica dos formularios (5KM e patrocinio).
// Valida no servidor, honeypot, tempo minimo, rate limit por IP e por identificador.
// Insere via RPC (service_role). O acesso direto anon as RPCs e revogado.
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
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const digits = (s: string) => s.replace(/[^\d+]/g, "");

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

  // Honeypot: campo invisivel. Bot preenche -> fingimos sucesso e nao inserimos.
  if (clean(b?.website, 100) !== "") return json({ ok: true }, 200, cors);
  // Tempo minimo de preenchimento (ms). Rapido demais = bot -> sucesso falso.
  const ff = Number(b?.ff);
  if (Number.isFinite(ff) && ff < 2500) return json({ ok: true }, 200, cors);

  const KINDS = new Set(["sponsor", "inscricao", "checkout_fallback"]);
  const kind = KINDS.has(b?.kind) ? String(b.kind) : null;
  if (!kind) return json({ error: "invalid_kind" }, 400, cors);

  const nome = clean(b?.nome, 120);
  if (nome.length < 2) return json({ error: "invalid_name" }, 400, cors);

  // checkout_fallback nao usa RPC: grava direto em gcp_fallback_leads (service_role).
  let ident = "";
  let rpc = "", args: Record<string, unknown> = {};
  let fallback: { nome: string; whatsapp: string; cpf: string | null } | null = null;
  if (kind === "checkout_fallback") {
    // Venda que caiu no link estatico da InfinitePay: sem pedido, sem ingresso.
    // So o contato, pra reconciliar na mao depois. Email/termo nao se aplicam.
    const whatsapp = digits(clean(b?.whatsapp, 40));
    const cpf = clean(b?.cpf, 20).replace(/[^\d]/g, "");
    if (whatsapp.length < 8) return json({ error: "invalid_phone" }, 400, cors);
    ident = whatsapp;
    fallback = { nome, whatsapp, cpf: cpf || null };
  } else if (kind === "inscricao") {
    const whatsapp = digits(clean(b?.whatsapp, 40));
    const email = clean(b?.email, 160).toLowerCase();
    if (!isEmail(email)) return json({ error: "invalid_email" }, 400, cors);
    if (whatsapp.length < 8) return json({ error: "invalid_phone" }, 400, cors);
    if (b?.termo !== true) return json({ error: "termo_required" }, 400, cors);
    ident = email;
    rpc = "add_inscricao";
    args = { p_nome: nome, p_whatsapp: whatsapp, p_email: email, p_termo: true };
  } else {
    const telefone = digits(clean(b?.telefone, 40));
    const empresa = clean(b?.empresa, 120);
    if (telefone.length < 8) return json({ error: "invalid_phone" }, 400, cors);
    if (empresa.length < 2) return json({ error: "invalid_company" }, 400, cors);
    ident = telefone;
    rpc = "add_lead";
    args = { p_nome: nome, p_telefone: telefone, p_empresa: empresa };
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "0";
  const ipHash = await sha256(ip);
  const identHash = await sha256(kind + ":" + ident);

  const db = createClient(SB_URL, SB_SR, { auth: { persistSession: false } });

  // Rate limit: por IP (janela curta) e por identificador (janela diaria).
  const since1m = new Date(Date.now() - 60_000).toISOString();
  const since1d = new Date(Date.now() - 86_400_000).toISOString();
  const { count: ipCount } = await db.from("gcp_form_hits")
    .select("*", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", since1m);
  if ((ipCount ?? 0) >= 6) return json({ error: "rate_limited" }, 429, cors);
  const { count: identCount } = await db.from("gcp_form_hits")
    .select("*", { count: "exact", head: true }).eq("ident_hash", identHash).gte("created_at", since1d);
  if ((identCount ?? 0) >= 5) return json({ error: "rate_limited" }, 429, cors);

  await db.from("gcp_form_hits").insert({ kind, ip_hash: ipHash, ident_hash: identHash });

  const { error } = fallback
    ? await db.from("gcp_fallback_leads").insert(fallback)
    : await db.rpc(rpc, args);
  if (error) return json({ error: "server_error" }, 500, cors);

  return json({ ok: true }, 200, cors);
});
