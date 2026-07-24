-- Gang Corre Party — contador de like (line-up)
-- Conta cliques anônimos + somado ao total de inscritos do 5KM, com base inicial de 123.
-- Zero dado pessoal: a tabela guarda APENAS o número de cliques anônimos na seção.
-- Namespaced gcp_ pra não colidir com os outros apps neste projeto.

-- 1) Contador único de cliques anônimos (1 linha).
create table if not exists public.gcp_likes (
  id         integer primary key default 1 check (id = 1),
  clicks     integer not null default 0 check (clicks >= 0),
  base       integer not null default 123  check (base >= 0),   -- base inicial (social proof)
  updated_at timestamptz not null default now()
);

-- garante a linha única existir
insert into public.gcp_likes(id, clicks, base) values (1, 0, 123)
  on conflict (id) do nothing;

-- updated_at automático
create or replace function public.gcp_likes_touch()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists gcp_likes_touch on public.gcp_likes;
create trigger gcp_likes_touch before update on public.gcp_likes
  for each row execute function public.gcp_likes_touch();

-- RLS ligado, SEM policies: anon/publishable NÃO lê nem escreve direto.
alter table public.gcp_likes enable row level security;


-- 2) Leitura pública: base + cliques + total de inscritos do 5KM.
--    (security definer => bypassa RLS; leitura só, sem expor nada além do número)
--    Soma inscritos contando corrida_inscricoes, se a tabela existir neste projeto.
create or replace function public.gcp_get_likes()
returns integer
language sql security definer set search_path = public
as $$
  select l.base
       + l.clicks
       + (select count(*) from public.corrida_inscricoes)
  from public.gcp_likes l
  where l.id = 1;
$$;
-- permite anon ler o total (é só um número, sem dado pessoal)
grant execute on function public.gcp_get_likes() to anon, authenticated;


-- 3) Incrementa 1 clique (chamado pelo botão). Devolve o novo total.
--    Atômico (for update) pra aguentar acessos concorrentes sem perder cliques.
create or replace function public.gcp_add_like()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_clicks integer;
begin
  update public.gcp_likes set clicks = clicks + 1 where id = 1 returning clicks into v_clicks;
  return (select l.base + l.clicks + (select count(*) from public.corrida_inscricoes)
          from public.gcp_likes l where l.id = 1);
end $$;
grant execute on function public.gcp_add_like() to anon, authenticated;
