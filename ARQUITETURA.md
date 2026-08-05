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

O modal tem seletor de **quantidade** (1 a 6, `#buy-qtd`); o valor vai no `quantity` do `checkout-create`, que recalcula tudo no servidor. Antes ia `1` fixo: quem queria 2 acabava abrindo dois checkouts soltos ou pagando um valor que não batia com o pedido.

### Fallback de link estático (degrade)
Se `checkout-create` falhar (backend fora, 502 do provedor, rede), `doBuy` registra o contato em `submit-lead` com `kind="checkout_fallback"` (nome/WhatsApp/CPF/quantidade, tabela `gcp_fallback_leads`) e **mesmo assim** redireciona pro `CHECKOUT_URL` estático — a venda nunca quebra. Esse caminho **não cria pedido nem ingresso**: o pagamento cai direto na InfinitePay e precisa de **reconciliação manual** (cruzar `gcp_fallback_leads` com o extrato). `obrigado.html` é a página desse caminho.

**Exceção com quantidade > 1:** o link estático tem preço de UM ingresso. Nesse caso o lead é registrado mas **não há redirect** — a pessoa vê um aviso e tenta de novo. Mandar quem quer 2+ pro link de 1 gera pagamento sem pedido correspondente. Pelo mesmo motivo o cupom trava a quantidade em 1.

### Cupom `FIMDAERA` (15% OFF) — front-only
Última seção da LP (`#cupom`, logo antes do rodapé). O código é normalizado (sem acento/caixa/espaço) e comparado com `CUPOM_CODIGO`. Válido → marca `cupomOn`, muda o texto/preço do modal e chama `openBuy()`.

No submit com cupom, `doBuy` **pula o `checkout-create`** (o backend calcula o preço cheio a partir de `gcp_ticket_lots`) e usa o mesmo caminho do fallback: registra o contato em `submit-lead` (`kind="checkout_fallback"`) e redireciona pro `CUPOM_CHECKOUT_URL` — link estático da InfinitePay já com o valor com desconto. Consequência igual à do fallback: **não cria pedido nem ingresso**, exige reconciliação manual em `gcp_fallback_leads`.

Config em `index.html`: `CUPOM_CODIGO`, `CUPOM_OFF` (só vitrine), `CUPOM_CHECKOUT_URL`. Qualquer um vazio → a seção é removida do DOM. Para desligar o cupom, limpe `CUPOM_CODIGO`.

## Backend seguro (`supabase/`)
### Tabelas (`supabase/migrations/`)
- `gcp_ticket_lots` — catálogo/lotes = **fonte de verdade do preço** (nunca confia no front).
- `gcp_orders` — pedidos (order_nsu UUID, public_token anti-enumeração, status, expected/paid_amount em centavos, transaction_nsu único).
- `gcp_order_items` — snapshot de preço/qtd.
- `gcp_payment_events` — auditoria + idempotência (event_key único).
- **RLS ligado sem policy em todas** → só `service_role` (Edge Functions) acessa. Frontend anon não lê pedido.

### RPC `gcp_confirm_payment`
Único ponto que marca `paid`. Atômico (`for update`), idempotente (event_key), valida valor, bloqueia reuso de transação, trava estoque. `revoke` de anon/authenticated.

`amount_mismatch` e `sold_out` deixam o pedido em **`processing`** (não `failed`): nesses dois casos a InfinitePay já confirmou dinheiro e o comprador está sem ingresso — é pendência humana e aparece no filtro **Revisar** do CRM. `failed` fica só pra pedido que nunca recebeu pagamento.

### Edge Functions (`supabase/functions/`)
- `checkout-create` — valida entrada, **calcula preço no servidor**, cria pedido pending, chama `POST https://api.checkout.infinitepay.io/links`, devolve só `{checkout_url, order_nsu, public_token}`.
- `infinitepay-webhook` — não confia no corpo; confirma via `POST .../payment_check` e libera pela RPC; idempotente; 503 p/ retry. **Toda** chamada que não vira pagamento (`invalid_json`, `invalid_payload`, `verify_unavailable`) é gravada em `gcp_payment_events` com `event_key` `raw:<motivo>:<uuid>` e status `error`. Sem isso um webhook fora do formato sumia com 400 sem deixar rastro e era impossível saber se a InfinitePay tinha chamado.
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
