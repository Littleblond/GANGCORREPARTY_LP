-- Pagamento que chega com valor divergente (ou com o lote esgotado) NAO pode
-- ser marcado 'failed' e esquecido: o dinheiro entrou na InfinitePay e o
-- comprador fica sem ingresso, sem ninguem ser avisado. Passa a ficar
-- 'processing' = precisa de revisao humana, e aparece como pendencia no CRM.
-- (Corpo identico a 20260722180000_gcp_tickets_and_validation, so muda isso.)
create or replace function public.gcp_confirm_payment(
  p_event_key text, p_order_nsu uuid, p_txn_nsu text, p_amount integer, p_paid_amount integer,
  p_method text, p_installments integer, p_slug text, p_receipt text, p_payload jsonb
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.gcp_orders%rowtype;
  v_item  record;
  v_rows  integer;
  i       integer;
begin
  insert into public.gcp_payment_events(provider, event_key, order_nsu, transaction_nsu, payload, processing_status)
  values ('infinitepay', p_event_key, p_order_nsu, p_txn_nsu, p_payload, 'received')
  on conflict (event_key) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return 'duplicate_event'; end if;

  select * into v_order from public.gcp_orders where order_nsu = p_order_nsu for update;
  if not found then
    update public.gcp_payment_events set processing_status='error', processed_at=now() where event_key=p_event_key;
    return 'order_not_found';
  end if;

  if v_order.status = 'paid' then
    update public.gcp_payment_events set processing_status='ignored', processed_at=now() where event_key=p_event_key;
    return 'already_paid';
  end if;

  -- valor divergente: guarda o que a InfinitePay confirmou e marca pra revisao.
  if v_order.expected_amount is distinct from p_amount then
    update public.gcp_orders set
      status='processing', paid_amount=p_paid_amount, payment_method=p_method,
      installments=p_installments, invoice_slug=p_slug, transaction_nsu=p_txn_nsu,
      receipt_url=coalesce(p_receipt, receipt_url), updated_at=now()
    where id=v_order.id;
    update public.gcp_payment_events set processing_status='error', processed_at=now() where event_key=p_event_key;
    return 'amount_mismatch';
  end if;

  if p_txn_nsu is not null and exists(
       select 1 from public.gcp_orders where transaction_nsu = p_txn_nsu and id <> v_order.id) then
    update public.gcp_payment_events set processing_status='error', processed_at=now() where event_key=p_event_key;
    return 'txn_reused';
  end if;

  for v_item in
    select lot_id, quantity from public.gcp_order_items where order_id = v_order.id and lot_id is not null
  loop
    update public.gcp_ticket_lots
       set qty_sold = qty_sold + v_item.quantity
     where id = v_item.lot_id
       and (qty_total is null or qty_sold + v_item.quantity <= qty_total);
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      -- pagou e o lote estourou: tambem e revisao humana, nao 'failed' silencioso.
      update public.gcp_orders set
        status='processing', paid_amount=p_paid_amount, payment_method=p_method,
        installments=p_installments, invoice_slug=p_slug, transaction_nsu=p_txn_nsu,
        receipt_url=coalesce(p_receipt, receipt_url), updated_at=now()
      where id=v_order.id;
      update public.gcp_payment_events set processing_status='error', processed_at=now() where event_key=p_event_key;
      return 'sold_out';
    end if;
    for i in 1..v_item.quantity loop
      insert into public.gcp_tickets(order_id, code)
      values (v_order.id, replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''));
    end loop;
  end loop;

  update public.gcp_orders set
    status='paid', paid_amount=p_paid_amount, payment_method=p_method,
    installments=p_installments, invoice_slug=p_slug, transaction_nsu=p_txn_nsu,
    receipt_url=coalesce(p_receipt, receipt_url), paid_at=now(), updated_at=now()
  where id=v_order.id;

  update public.gcp_payment_events set processing_status='processed', processed_at=now() where event_key=p_event_key;
  return 'paid';
end $$;
revoke all on function public.gcp_confirm_payment(text,uuid,text,integer,integer,text,integer,text,text,jsonb) from public, anon, authenticated;

-- quantidade que a pessoa queria comprar quando caiu no link estatico
-- (fallback/cupom). Sem isso a reconciliacao manual nao sabe se o PIX de
-- R$100 no extrato corresponde a 1 ou 2 ingressos.
alter table public.gcp_fallback_leads add column if not exists quantidade integer not null default 1;
