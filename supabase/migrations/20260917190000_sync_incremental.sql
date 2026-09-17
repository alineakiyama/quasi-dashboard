-- Sincronização incremental.
--
-- Antes, cada sincronização gravava TODAS as linhas da aba na área de preparo —
-- 25 mil linhas de Subscriptions a cada edição, ~24 s. Agora a função pergunta
-- quais chaves já existem, prepara só as linhas novas e manda o resto apenas
-- como lista de chaves (para saber o que apagar e o que mudou de linha).

drop function if exists public.sheet_sync_commit(bigint, text);

create or replace function public._sheet_tabela(p_tab text)
returns text language sql immutable as $$
  select case p_tab
    when 'refunds'         then 'sheet_refunds'
    when 'subscriptions'   then 'sheet_subscriptions'
    when 'reshipments'     then 'sheet_reshipments'
    when 'supplier_issues' then 'sheet_supplier_issues'
  end
$$;

-- Todas as chaves de uma aba, num valor só (não sofre o limite de linhas da API).
create or replace function public.sheet_keys(p_tab text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_table text := _sheet_tabela(p_tab); v jsonb;
begin
  if v_table is null then raise exception 'aba desconhecida: %', p_tab; end if;
  execute format('select coalesce(jsonb_agg(row_key), ''[]'') from %I', v_table) into v;
  return v;
end $$;

-- p_keys: [[row_key, row_number], ...] com TODAS as linhas atuais da planilha.
create or replace function public.sheet_sync_commit(p_run bigint, p_tab text, p_keys jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_table text := _sheet_tabela(p_tab);
  v_ins int; v_upd int; v_del int; v_stored int;
begin
  if v_table is null then raise exception 'aba desconhecida: %', p_tab; end if;
  perform pg_advisory_xact_lock(hashtext('sheet_sync:' || p_tab));

  create temp table _chaves on commit drop as
    select e->>0 as row_key, (e->>1)::int as row_number from jsonb_array_elements(p_keys) e;
  create index on _chaves (row_key);
  analyze _chaves;

  execute format('delete from %I t where not exists (select 1 from _chaves k where k.row_key = t.row_key)', v_table);
  get diagnostics v_del = row_count;

  execute format('update %I t set row_number = k.row_number, synced_at = now()
                    from _chaves k where k.row_key = t.row_key and t.row_number <> k.row_number', v_table);
  get diagnostics v_upd = row_count;

  execute format(
    'insert into %1$I
       select (jsonb_populate_record(null::%1$I, s.rec)).*
         from sheet_sync_staging s
        where s.run_id = $1
          and not exists (select 1 from %1$I t where t.row_key = s.row_key)',
    v_table) using p_run;
  get diagnostics v_ins = row_count;

  delete from sheet_sync_staging where run_id = p_run;
  execute format('select count(*) from %I', v_table) into v_stored;

  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'deleted', v_del, 'stored', v_stored);
end $$;

revoke all on function public.sheet_keys(text), public.sheet_sync_commit(bigint, text, jsonb), public._sheet_tabela(text) from public, anon, authenticated;
grant execute on function public.sheet_keys(text), public.sheet_sync_commit(bigint, text, jsonb), public._sheet_tabela(text) to service_role;
