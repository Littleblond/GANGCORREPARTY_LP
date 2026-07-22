-- Fixa search_path da trigger fn (fecha o WARN function_search_path_mutable)
create or replace function public.gcp_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin new.updated_at = now(); return new; end $$;
