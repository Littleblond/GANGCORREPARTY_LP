-- Origem da venda (UTM + referrer da chegada) gravada junto com o pedido.
--
-- Motivo: `fbc` so diz que a pessoa veio de um link do Facebook/Instagram — o
-- Meta cola `fbclid` tambem em post organico e link da bio, entao ele nao separa
-- pago de organico. A atribuicao do Gerenciador separa, mas demora horas e perde
-- parte das vendas. Com a UTM no pedido, "essa venda veio do anuncio?" vira uma
-- consulta ao banco, na hora.
--
-- Todas nullable e sem default: nao encostam em valor, lote nem faturamento.
-- Idempotente — rodar duas vezes nao quebra.
--
-- ORDEM: rodar isto ANTES de deployar `checkout-create`. Invertido, todo INSERT
-- de pedido falha por coluna inexistente e a venda para.

alter table public.gcp_orders
  add column if not exists utm_source       text,
  add column if not exists utm_medium       text,
  add column if not exists utm_campaign     text,
  add column if not exists utm_content      text,
  add column if not exists utm_term         text,
  add column if not exists landing_referrer text;

-- Relatorio de origem costuma filtrar por campanha e por periodo.
create index if not exists gcp_orders_utm_campaign_idx
  on public.gcp_orders (utm_campaign)
  where utm_campaign is not null;
