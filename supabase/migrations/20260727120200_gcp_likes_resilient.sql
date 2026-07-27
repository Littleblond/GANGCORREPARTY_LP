-- Likes resilientes: corrida_inscricoes e de OUTRO app deste projeto.
-- As versoes anteriores faziam select count(*) direto nela; se a tabela nao
-- existir (ou o role nao puder ler), a funcao quebra e o contador some da LP.
-- Agora a soma dos inscritos e opcional: sem a tabela, devolve base + clicks.

-- Conta inscritos do 5KM se a tabela existir; qualquer erro vira 0.
create or replace function public.gcp_inscritos_count()
returns bigint
language plpgsql security definer set search_path = public
as $$
declare v_n bigint := 0;
begin
  if to_regclass('public.corrida_inscricoes') is null then
    return 0;
  end if;
  execute 'select count(*) from public.corrida_inscricoes' into v_n;
  return coalesce(v_n, 0);
exception when others then
  return 0;
end $$;
revoke all on function public.gcp_inscritos_count() from public, anon, authenticated;

-- Leitura publica: base + cliques + inscritos (se houver).
create or replace function public.gcp_get_likes()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_total integer;
begin
  select l.base + l.clicks + public.gcp_inscritos_count()
    into v_total
    from public.gcp_likes l
   where l.id = 1;
  return coalesce(v_total, 0);
end $$;

-- Incrementa 1 clique (chamado pela Edge Function add-like). Devolve o novo total.
-- Atomico (update ... returning) pra aguentar cliques concorrentes.
create or replace function public.gcp_add_like()
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_clicks integer;
begin
  update public.gcp_likes set clicks = clicks + 1 where id = 1 returning clicks into v_clicks;
  if v_clicks is null then
    insert into public.gcp_likes(id, clicks, base) values (1, 1, 123)
      on conflict (id) do update set clicks = public.gcp_likes.clicks + 1;
  end if;
  return public.gcp_get_likes();
end $$;

-- Grants (mesma regra da migration anterior): leitura publica, escrita so service_role.
revoke all on function public.gcp_add_like() from public, anon, authenticated;
grant execute on function public.gcp_add_like() to service_role;
grant execute on function public.gcp_get_likes() to anon, authenticated;
