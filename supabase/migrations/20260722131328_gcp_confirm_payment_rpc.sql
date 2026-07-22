-- Coracao da seguranca: confirmacao atomica e idempotente do pagamento.
-- Chamada SO pelo service_role (webhook / payment_check). Nunca pelo anon.
create or replace function public.gcp_confirm_payment(
  p_event_key    text,
  p_order_nsu    uuid,
  p_txn_nsu      text,
  p_amount       integer,   -- valor-base cobrado (campo 'amount' da InfinitePay)
  p_paid_amount  integer,   -- valor efetivamente pago (pode ser > amount por taxa/juros)
  p_method       text,
  p_installments integer,
  p_slug         text,
  p_receipt      text,
  p_payload      jsonb
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.gcp_orders%rowtype;
  v_item  record;
  v_rows  integer;
begin
  -- 1) Idempotencia do evento: se o event_key ja existe, e repeticao -> nao reprocessa.
  insert into public.gcp_payment_events(provider, event_key, order_nsu, transaction_nsu, payload, processing_status)
  values ('infinitepay', p_event_key, p_order_nsu, p_txn_nsu, p_payload, 'received')
  on conflict (event_key) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'duplicate_event';
  end if;

  -- 2) Trava a linha do pedido (serializa concorrencia webhook x payment_check).
  select * into v_order from public.gcp_orders where order_nsu = p_order_nsu for update;
  if not found then
    update public.gcp_payment_events set processing_status='error', processed_at=now() where event_key=p_event_key;
    return 'order_not_found';
  end if;

  -- 3) Ja pago? idempotente, nao rebaixa nem duplica beneficio.
  if v_order.status = 'paid' then
    update public.gcp_payment_events set processing_status='ignored', processed_at=now() where event_key=p_event_key;
    return 'already_paid';
  end if;

  -- 4) Valor tem que bater com o esperado calculado no servidor (anti-adulteracao de preco).
  if v_order.expected_amount is distinct from p_amount then
    update public.gcp_orders set status='failed', updated_at=now() where id=v_order.id;
    update public.gcp_payment_events set processing_status='error', processed_at=now() where event_key=p_event_key;
    return 'amount_mismatch';
  end if;

  -- 5) Transacao nao pode ter sido usada em outro pedido (anti-reuso).
  if p_txn_nsu is not null and exists(
       select 1 from public.gcp_orders where transaction_nsu = p_txn_nsu and id <> v_order.id) then
    update public.gcp_payment_events set processing_status='error', processed_at=now() where event_key=p_event_key;
    return 'txn_reused';
  end if;

  -- 6) Estoque atomico por item: so incrementa se ainda ha vaga (trava o teto de verdade).
  for v_item in
    select lot_id, quantity from public.gcp_order_items where order_id = v_order.id and lot_id is not null
  loop
    update public.gcp_ticket_lots
       set qty_sold = qty_sold + v_item.quantity
     where id = v_item.lot_id
       and (qty_total is null or qty_sold + v_item.quantity <= qty_total);
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      -- Pagou mas o lote esgotou numa corrida -> marca pra reembolso manual, NAO libera.
      update public.gcp_orders set status='failed', updated_at=now() where id=v_order.id;
      update public.gcp_payment_events set processing_status='error', processed_at=now() where event_key=p_event_key;
      return 'sold_out';
    end if;
  end loop;

  -- 7) Marca pago (unico ponto que vira 'paid').
  update public.gcp_orders set
    status='paid', paid_amount=p_paid_amount, payment_method=p_method,
    installments=p_installments, invoice_slug=p_slug, transaction_nsu=p_txn_nsu,
    receipt_url=coalesce(p_receipt, receipt_url), paid_at=now(), updated_at=now()
  where id=v_order.id;

  update public.gcp_payment_events set processing_status='processed', processed_at=now() where event_key=p_event_key;
  return 'paid';
end $$;

-- Trancar: ninguem publico chama essa RPC. So service_role (que bypassa GRANTs).
revoke all on function public.gcp_confirm_payment(text,uuid,text,integer,integer,text,integer,text,text,jsonb) from public, anon, authenticated;
