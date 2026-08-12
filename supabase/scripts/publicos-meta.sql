-- =====================================================================
-- PUBLICOS PERSONALIZADOS DO META — so LEITURA, nao altera nada.
-- Rodar no SQL Editor do painel Supabase e clicar em "Download CSV".
-- Cabecalhos ja no nome que o Meta reconhece sozinho no upload.
--
-- Telefone sai no formato E.164 (+55DDDNUMERO). O Meta casa MUITO melhor
-- assim do que com numero solto.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) COMPRADORES  ->  Publico "GCP | Compradores"
--    Uso: EXCLUIR de todas as campanhas (nao paga pra vender de novo)
--         + origem do Lookalike de maior qualidade.
-- ---------------------------------------------------------------------
select
  split_part(trim(split_part(customer_name, '(', 1)), ' ', 1)                    as fn,
  nullif(split_part(trim(split_part(customer_name, '(', 1)), ' ',
    array_length(string_to_array(trim(split_part(customer_name,'(',1)), ' '), 1)), '') as ln,
  '+' || case
           when left(regexp_replace(customer_phone, '\D', '', 'g'), 2) = '55'
             then regexp_replace(customer_phone, '\D', '', 'g')
           else '55' || regexp_replace(customer_phone, '\D', '', 'g')
         end                                                                     as phone,
  lower(nullif(customer_email, ''))                                              as email,
  'BR'                                                                           as country
from public.gcp_orders
where status = 'paid'
  and length(regexp_replace(customer_phone, '\D', '', 'g')) >= 10;


-- ---------------------------------------------------------------------
-- 2) CARRINHO ABANDONADO  ->  Publico "GCP | Abandonou checkout"
--    Os ~71 que preencheram tudo e nao pagaram. Publico mais quente que existe.
--    Uso: campanha de retarget com urgencia de lote.
-- ---------------------------------------------------------------------
select
  split_part(trim(split_part(customer_name, '(', 1)), ' ', 1)                    as fn,
  '+' || case
           when left(regexp_replace(customer_phone, '\D', '', 'g'), 2) = '55'
             then regexp_replace(customer_phone, '\D', '', 'g')
           else '55' || regexp_replace(customer_phone, '\D', '', 'g')
         end                                                                     as phone,
  lower(nullif(customer_email, ''))                                              as email,
  'BR'                                                                           as country
from public.gcp_orders
where status in ('pending', 'payment_link_created', 'processing', 'failed')
  and length(regexp_replace(customer_phone, '\D', '', 'g')) >= 10
  -- quem abandonou mas depois comprou nao entra
  and regexp_replace(customer_phone, '\D', '', 'g') not in (
    select regexp_replace(customer_phone, '\D', '', 'g')
    from public.gcp_orders where status = 'paid'
  );


-- ---------------------------------------------------------------------
-- 3) INSCRITOS DO 5KM QUE NAO COMPRARAM  ->  "GCP | 5KM sem ingresso"
--    Levantaram a mao, deram os dados, vao no corre — mas nao pagaram a festa.
--    Uso: retarget com o angulo "ja que tu vem correr, fica pro rolê".
-- ---------------------------------------------------------------------
select
  split_part(trim(nome), ' ', 1)                                                 as fn,
  nullif(split_part(trim(nome), ' ',
    array_length(string_to_array(trim(nome), ' '), 1)), '')                       as ln,
  '+' || case
           when left(regexp_replace(whatsapp, '\D', '', 'g'), 2) = '55'
             then regexp_replace(whatsapp, '\D', '', 'g')
           else '55' || regexp_replace(whatsapp, '\D', '', 'g')
         end                                                                     as phone,
  lower(nullif(email, ''))                                                       as email,
  to_char(nascimento, 'YYYYMMDD')                                                as dob,
  'BR'                                                                           as country
from public.corrida_inscricoes
where length(regexp_replace(whatsapp, '\D', '', 'g')) >= 10
  and regexp_replace(whatsapp, '\D', '', 'g') not in (
    select regexp_replace(customer_phone, '\D', '', 'g')
    from public.gcp_orders where status = 'paid'
  );


-- ---------------------------------------------------------------------
-- 4) CONFERENCIA — rodar antes pra saber o tamanho de cada publico.
--    Meta exige >= 100 CORRESPONDENCIAS pra ativar. Como o casamento fica
--    em ~50-70%, um publico com menos de ~180 linhas provavelmente nao liga
--    sozinho: nesse caso, juntar tudo num CSV so.
-- ---------------------------------------------------------------------
select 'compradores' as publico, count(*) from public.gcp_orders where status = 'paid'
union all
select 'abandonou', count(*) from public.gcp_orders
  where status in ('pending','payment_link_created','processing','failed')
union all
select 'inscritos 5km', count(*) from public.corrida_inscricoes;
