-- Ingressos: 1 por unidade comprada. code aleatorio (nao sequencial, nao dado pessoal).
create table if not exists public.gcp_tickets (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.gcp_orders(id) on delete cascade,
  code       text not null unique,
  status     text not null default 'valid' check (status in ('valid','used','void')),
  used_at    timestamptz,
  used_by    text,
  created_at timestamptz not null default now()
);
create index if not exists gcp_tickets_order_idx on public.gcp_tickets(order_id);
alter table public.gcp_tickets enable row level security; -- so service_role

-- Tokens da equipe de portaria (staff). Guarda so o HASH; plaintext nunca no banco.
create table if not exists public.gcp_staff_tokens (
  id         uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  label      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.gcp_staff_tokens enable row level security;

-- Atualiza a RPC de confirmacao: alem de marcar pago, GERA os ingressos (atomico, 1x).
-- (corpo identico a 20260722131328_gcp_confirm_payment_rpc, + geracao de tickets no loop de estoque)
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

  if v_order.expected_amount is distinct from p_amount then
    update public.gcp_orders set status='failed', updated_at=now() where id=v_order.id;
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
      update public.gcp_orders set status='failed', updated_at=now() where id=v_order.id;
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

-- Validacao de ingresso use-once (atomica). So service_role chama.
create or replace function public.gcp_validate_ticket(p_code text, p_operator text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ticket public.gcp_tickets%rowtype;
  v_order  public.gcp_orders%rowtype;
  v_rows   integer;
begin
  select * into v_ticket from public.gcp_tickets where code = p_code for update;
  if not found then return jsonb_build_object('result','not_found'); end if;

  select * into v_order from public.gcp_orders where id = v_ticket.order_id;
  if v_order.status <> 'paid' then return jsonb_build_object('result','not_paid'); end if;

  if v_ticket.status = 'used' then
    return jsonb_build_object('result','already_used','used_at',v_ticket.used_at,'nome',split_part(coalesce(v_order.customer_name,''),' ',1));
  end if;
  if v_ticket.status = 'void' then return jsonb_build_object('result','void'); end if;

  update public.gcp_tickets set status='used', used_at=now(), used_by=p_operator
   where id = v_ticket.id and status='valid';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then return jsonb_build_object('result','already_used'); end if;

  return jsonb_build_object('result','ok','nome',split_part(coalesce(v_order.customer_name,''),' ',1));
end $$;
revoke all on function public.gcp_validate_ticket(text,text) from public, anon, authenticated;
