# Gang Corre Party — Arquitetura

Site **estático** (Vercel) + backend **Supabase** (Postgres + Edge Functions). Sem Next.js, sem Node server, sem ORM.

## Frontend (raiz do repo)
- `index.html` — landing page (LP). CSS/JS inline. Vídeo hero em `assets/`.
- `termo.html` — termo de participação/dados.
- `obrigado.html` — página pós-compra do **fluxo interino** (link estático InfinitePay → grupo VIP).
- `pagamento-concluido.html` — página de sucesso do **fluxo seguro** (faz polling no `order-status`, só mostra confirmado quando o servidor confirma).
- `vercel.json` — headers de segurança (CSP, X-Frame-Options, etc.).
- Deploy: push no `main` → Vercel auto-deploy.

## Dois fluxos de venda
1. **Interino (ativo p/ 1º lote):** botão da festa → link estático InfinitePay (R$50) → `obrigado.html`. Gatilho por data em `index.html` (`LOTE_ABRE`, vira sozinho quinta 19h). Sem controle de estoque automático (manual no painel).
2. **Seguro (pronto, ainda não ligado ao site):** backend completo abaixo. Será plugado nos próximos lotes.

## Backend seguro (`supabase/`)
### Tabelas (`supabase/migrations/`)
- `gcp_ticket_lots` — catálogo/lotes = **fonte de verdade do preço** (nunca confia no front).
- `gcp_orders` — pedidos (order_nsu UUID, public_token anti-enumeração, status, expected/paid_amount em centavos, transaction_nsu único).
- `gcp_order_items` — snapshot de preço/qtd.
- `gcp_payment_events` — auditoria + idempotência (event_key único).
- **RLS ligado sem policy em todas** → só `service_role` (Edge Functions) acessa. Frontend anon não lê pedido.

### RPC `gcp_confirm_payment`
Único ponto que marca `paid`. Atômico (`for update`), idempotente (event_key), valida valor, bloqueia reuso de transação, trava estoque. `revoke` de anon/authenticated.

### Edge Functions (`supabase/functions/`)
- `checkout-create` — valida entrada, **calcula preço no servidor**, cria pedido pending, chama `POST https://api.checkout.infinitepay.io/links`, devolve só `{checkout_url, order_nsu, public_token}`.
- `infinitepay-webhook` — não confia no corpo; confirma via `POST .../payment_check` e libera pela RPC; idempotente; 503 p/ retry.
- `order-status` — status real, exige `order_nsu + public_token`.

Config via env (secrets das functions): `INFINITEPAY_HANDLE` (ver `.env.example`). `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` são injetados automaticamente. **InfinitePay não exige token** p/ `/links` e `/payment_check` (confirmado ao vivo).

## Serviços externos
Supabase (`asppjvxeqpfsonknukla`) · InfinitePay (checkout) · Vercel (hosting) · WhatsApp (grupo, link).

## Testado (2026-07-22)
Confirmação de pagamento: `paid`, `duplicate_event`, `already_paid`, `amount_mismatch`, `txn_reused`, `sold_out`, 404 anti-enumeração, 400 validação. Anon não lê inscritos/pedidos, não escreve direto, não forja pagamento.

## Pendências (roadmap)
Anti-spam nos forms (H1) · QR Code de ingresso + validação na portaria · e-mail/WhatsApp após PAID (precisa provider) · UI de seleção de lotes · consentimentos LGPD separados.
