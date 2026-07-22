-- Gang Corre Party — schema de pagamentos InfinitePay
-- Namespaced gcp_ para nao colidir com os outros apps neste projeto.
-- RLS ligado em TODAS, SEM policies publicas: so o service_role (Edge Functions) acessa.
-- Frontend anon/publishable NAO le pedidos.

-- 1) Catalogo/lotes = fonte de verdade do preco (servidor nunca confia no front)
create table if not exists public.gcp_ticket_lots (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null,
  description   text,
  price_cents   integer     not null check (price_cents > 0),
  qty_total     integer     check (qty_total is null or qty_total >= 0), -- null = ilimitado
  qty_sold      integer     not null default 0 check (qty_sold >= 0),
  max_per_order integer     not null default 6 check (max_per_order > 0),
  active        boolean     not null default false,
  sort          integer     not null default 0,
  created_at    timestamptz not null default now()
);

-- 2) Pedidos
create table if not exists public.gcp_orders (
  id              uuid primary key default gen_random_uuid(),
  order_nsu       uuid        not null default gen_random_uuid(),
  public_token    uuid        not null default gen_random_uuid(), -- auth da pagina de status (anti-enumeracao)
  customer_name   text,
  customer_email  text,
  customer_phone  text,
  status          text        not null default 'pending'
                   check (status in ('pending','payment_link_created','processing','paid','failed','expired','cancelled','refunded')),
  currency        text        not null default 'BRL',
  expected_amount integer     not null check (expected_amount > 0), -- centavos, calculado no servidor
  paid_amount     integer,
  payment_method  text,
  installments    integer,
  invoice_slug    text,
  transaction_nsu text,
  receipt_url     text,
  payment_link    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  paid_at         timestamptz
);
create unique index if not exists gcp_orders_order_nsu_key on public.gcp_orders(order_nsu);
-- transaction_nsu unico so quando nao-nulo: impede reuso de transacao em dois pedidos
create unique index if not exists gcp_orders_txn_nsu_key on public.gcp_orders(transaction_nsu) where transaction_nsu is not null;

-- 3) Itens (snapshot de preco/qtd no momento da compra)
create table if not exists public.gcp_order_items (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid    not null references public.gcp_orders(id) on delete cascade,
  lot_id               uuid    references public.gcp_ticket_lots(id),
  description_snapshot text    not null,
  unit_price           integer not null check (unit_price > 0),
  quantity             integer not null check (quantity > 0),
  total_price          integer not null check (total_price > 0)
);
create index if not exists gcp_order_items_order_id_idx on public.gcp_order_items(order_id);

-- 4) Eventos de pagamento (auditoria + idempotencia)
create table if not exists public.gcp_payment_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text        not null default 'infinitepay',
  event_key         text        not null, -- chave de idempotencia (ex: txn_nsu+order_nsu)
  order_nsu         uuid,
  transaction_nsu   text,
  payload           jsonb,
  processing_status text        not null default 'received'
                     check (processing_status in ('received','processed','ignored','error')),
  received_at       timestamptz not null default now(),
  processed_at      timestamptz
);
create unique index if not exists gcp_payment_events_event_key_key on public.gcp_payment_events(event_key);
create index if not exists gcp_payment_events_order_nsu_idx on public.gcp_payment_events(order_nsu);

-- updated_at automatico nos pedidos
create or replace function public.gcp_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists gcp_orders_touch on public.gcp_orders;
create trigger gcp_orders_touch before update on public.gcp_orders
  for each row execute function public.gcp_touch_updated_at();

-- RLS ligado, sem policies publicas => anon/publishable nao le nem escreve.
-- Edge Functions usam service_role (bypassa RLS).
alter table public.gcp_ticket_lots     enable row level security;
alter table public.gcp_orders          enable row level security;
alter table public.gcp_order_items     enable row level security;
alter table public.gcp_payment_events  enable row level security;
