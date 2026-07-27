-- Likes: fecha a escrita direta pelo anon.
-- Antes, gcp_add_like tinha grant execute pra anon e o front chamava a RPC com
-- a publishable key — sem rate limit, qualquer script inflava o contador.
-- Agora so a Edge Function add-like (service_role, rate limit por IP) escreve.
-- Obs: funcao nova nasce com EXECUTE pra PUBLIC, por isso o revoke inclui public.
revoke all on function public.gcp_add_like() from public, anon, authenticated;
grant execute on function public.gcp_add_like() to service_role;

-- Leitura continua publica (devolve so um numero, sem dado pessoal).
grant execute on function public.gcp_get_likes() to anon, authenticated;
