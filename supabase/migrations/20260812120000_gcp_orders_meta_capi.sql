-- Colunas de rastreio do Meta (Conversions API) em gcp_orders.
--
-- REGRA 3 DOS SISTEMAS RG: NAO rodar `supabase db push`. Este arquivo existe pra
-- ficar versionado; a execucao e MANUAL, colada no SQL Editor do painel.
--
-- REGRA 1 ("o GCP nao se altera"): isto NAO mexe em valor, lote, pedido nem
-- faturamento. Sao 4 colunas novas, todas NULL, so pra atribuicao de anuncio.
-- Nenhum numero do evento muda.
--
-- ORDEM OBRIGATORIA DE SUBIDA:
--   1) rodar este SQL
--   2) so entao deployar a Edge Function `checkout-create`
-- Invertido, todo INSERT de pedido falha (coluna inexistente) e a venda para.

alter table public.gcp_orders
  add column if not exists fbp        text,   -- cookie _fbp do navegador
  add column if not exists fbc        text,   -- cookie _fbc (clique no anuncio)
  add column if not exists client_ua  text,   -- user-agent, melhora o casamento
  add column if not exists client_ip  text;   -- IP de origem, idem

comment on column public.gcp_orders.fbp is 'Meta Pixel _fbp — casamento da Conversions API';
comment on column public.gcp_orders.fbc is 'Meta Pixel _fbc (fbclid) — atribui a venda ao anuncio';
comment on column public.gcp_orders.client_ua is 'User-agent do comprador — casamento da CAPI';
comment on column public.gcp_orders.client_ip is 'IP do comprador — casamento da CAPI';
