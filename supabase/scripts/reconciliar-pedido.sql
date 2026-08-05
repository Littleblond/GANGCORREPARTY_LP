-- Liberacao manual de pedido que recebeu pagamento mas nao fechou sozinho
-- (webhook nunca chegou, valor divergente, etc).
--
-- PRE-REQUISITO: confirmar no painel da InfinitePay que o valor entrou mesmo.
-- Este script CONFIA em voce: ele cria ingresso e conta estoque.
--
-- O editor SQL do Supabase nao aceita variavel de psql: troque na mao, com
-- localizar/substituir, ANTES de rodar:
--   __ORDER_ID__  -> id do pedido (uuid) em gcp_orders, entre aspas simples
--   __QTD__       -> quantos ingressos essa pessoa pagou (numero)
--   __VALOR__     -> valor recebido em centavos (R$ 50,00 = 5000)
--   __METODO__    -> 'pix' ou 'credit_card', entre aspas simples
--   __TXN__       -> id/end-to-end da transacao no extrato, entre aspas simples

begin;

-- 1) alinha o item ao que foi pago de fato
update public.gcp_order_items
   set quantity = __QTD__, total_price = unit_price * __QTD__
 where order_id = __ORDER_ID__;

-- 2) fecha o pedido (o and status <> 'paid' impede rodar duas vezes)
update public.gcp_orders
   set expected_amount = (select total_price from public.gcp_order_items where order_id = __ORDER_ID__),
       status          = 'paid',
       paid_amount     = __VALOR__,
       payment_method  = __METODO__,
       transaction_nsu = nullif(__TXN__, ''),
       paid_at         = now(),
       updated_at      = now()
 where id = __ORDER_ID__
   and status <> 'paid';

-- 3) gera so os ingressos que faltam pra chegar em __QTD__
insert into public.gcp_tickets(order_id, code)
select __ORDER_ID__,
       replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')
  from generate_series(1, __QTD__ - (select count(*) from public.gcp_tickets where order_id = __ORDER_ID__));

-- 4) conta no estoque do lote
update public.gcp_ticket_lots
   set qty_sold = qty_sold + __QTD__
 where id = (select lot_id from public.gcp_order_items where order_id = __ORDER_ID__);

commit;

-- 5) links pra mandar pro comprador (um por ingresso)
select 'https://gangcorreparty-lp.vercel.app/ingresso.html?tk=' || code as link
  from public.gcp_tickets where order_id = __ORDER_ID__;
