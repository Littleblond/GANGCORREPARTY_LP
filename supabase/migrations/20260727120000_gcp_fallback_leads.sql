-- Leads da venda que caiu no fallback de link estatico.
-- Quando checkout-create falha, o front redireciona pro CHECKOUT_URL da
-- InfinitePay: nao existe pedido nem ingresso nesse caminho. Guardamos o
-- contato aqui pra RECONCILIACAO MANUAL (cruzar com o extrato da InfinitePay).
create table if not exists public.gcp_fallback_leads (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  whatsapp   text not null,
  cpf        text,
  created_at timestamptz not null default now()
);
create index if not exists gcp_fallback_leads_created_idx on public.gcp_fallback_leads(created_at desc);

-- RLS ligado, SEM policies: so o service_role (submit-lead) escreve/le.
alter table public.gcp_fallback_leads enable row level security;

-- checkout-create ja insere customer_cpf em gcp_orders, mas nenhuma migration
-- criava a coluna. Idempotente: se ja existir no banco, nao faz nada.
alter table public.gcp_orders add column if not exists customer_cpf text;
