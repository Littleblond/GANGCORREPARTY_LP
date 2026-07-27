# Gang Corre Party — Arquitetura

Site **estático** (Vercel) + backend **Supabase** (Postgres + Edge Functions). Sem Next.js, sem Node server, sem ORM.

## Frontend (raiz do repo)
- `index.html` — landing page (LP). CSS/JS inline. Vídeo hero em `assets/`.
- `termo.html` — termo de participação/dados.
- `obrigado.html` — página pós-compra do **fallback estático** (link direto InfinitePay → grupo VIP).
- `pagamento-concluido.html` — página de sucesso do **fluxo normal** (faz polling no `order-status`, só mostra confirmado quando o servidor confirma).
- `ingresso.html` — página do ingresso (`?tk=<code>`): busca `ticket-qr` e mostra nome, status e QR pra portaria.
- `vercel.json` — headers de segurança (CSP, X-Frame-Options, etc.).
- Deploy: push no `main` → Vercel auto-deploy.

## Fluxo de venda (seguro, ATIVO na LP)
Caminho normal: botão da festa → modal `openBuy` (nome/WhatsApp/CPF) → `doBuy` (`index.html`, ~linha 1062) chama `POST .../functions/v1/checkout-create` → backend calcula preço, cria pedido `pending` e devolve `checkout_url` → InfinitePay → `pagamento-concluido.html` (polling em `order-status`) → webhook confirma → `paid` + ingressos gerados.

O gatilho de data continua em `index.html` (`LOTE_ABRE`): antes disso o botão abre o grupo VIP, depois vira compra.

### Fallback de link estático (degrade)
Se `checkout-create` falhar (backend fora, 502 do provedor, rede), `doBuy` registra o contato em `submit-lead` com `kind="checkout_fallback"` (nome/WhatsApp/CPF, tabela `gcp_fallback_leads`) e **mesmo assim** redireciona pro `CHECKOUT_URL` estático — a venda nunca quebra. Esse caminho **não cria pedido nem ingresso**: o pagamento cai direto na InfinitePay e precisa de **reconciliação manual** (cruzar `gcp_fallback_leads` com o extrato). `obrigado.html` é a página desse caminho.

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
- `ticket-qr` — GET `?tk=<ticket.code>`: devolve `{name, ticket_status, svg}` do ingresso. Só se o pedido estiver `paid`; senão `not_found`. Leitura pura (não marca usado).
- `validate-ticket` — portaria: staff autentica por token (hash no banco) e valida use-once via RPC atômica.
- `submit-lead` — porta única dos formulários (`inscricao`, `sponsor`) + `checkout_fallback` (lead da venda que caiu no link estático).
- `add-like` — incremento do contador de likes do line-up, com rate limit por IP (a RPC de escrita é revogada de anon).

Config via env (secrets das functions): `INFINITEPAY_HANDLE` (ver `.env.example`). `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` são injetados automaticamente. **InfinitePay não exige token** p/ `/links` e `/payment_check` (confirmado ao vivo).

## Serviços externos
Supabase (`asppjvxeqpfsonknukla`) · InfinitePay (checkout) · Vercel (hosting) · WhatsApp (grupo, link).

## Testado (2026-07-22)
Confirmação de pagamento: `paid`, `duplicate_event`, `already_paid`, `amount_mismatch`, `txn_reused`, `sold_out`, 404 anti-enumeração, 400 validação. Anon não lê inscritos/pedidos, não escreve direto, não forja pagamento.

## Pendências (roadmap)
E-mail/WhatsApp após PAID (precisa provider) · UI de seleção de lotes · consentimentos LGPD separados · preço do front (`PRECO_LOTE`) ainda é manual: espelhar `gcp_ticket_lots.price_cents` do lote ativo · reconciliação automática dos leads de `checkout_fallback`.
