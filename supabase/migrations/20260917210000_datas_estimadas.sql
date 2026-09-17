-- Datas estimadas para o histórico sem data.
--
-- Combinado com o time: as linhas antigas de Subscriptions, Reshipments e
-- Supplier issues (sem coluna de data até 17/09/2026) são espalhadas em partes
-- iguais entre 08/07/2026 (primeira linha do Refund Tracker) e 16/09/2026, na
-- ordem da planilha — a de cima é a mais antiga. Ex.: 1.000 linhas em 5 dias = 200
-- por dia; quando não divide exato, a diferença entre dias é no máximo 1.
--
-- A data estimada fica numa coluna própria (est_date): a data real (entry_date)
-- nunca é tocada e sempre vence. Nada disso volta para a planilha. Os relatórios
-- usam "dia" = data real ou, na falta dela, a estimada, e contam à parte quantas
-- são estimadas para a tela avisar.

alter table public.sheet_subscriptions   add column if not exists est_date date;
alter table public.sheet_reshipments     add column if not exists est_date date;
alter table public.sheet_supplier_issues add column if not exists est_date date;

create or replace function public.sheet_estimate_dates(p_tab text)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_table text := _sheet_tabela(p_tab);
  v_inicio constant date := date '2026-07-08';
  v_dias   constant int  := (date '2026-09-16' - date '2026-07-08') + 1;   -- 71 dias
  v_n int;
begin
  if v_table is null or p_tab = 'refunds' then return 0; end if;
  execute format($f$
    with h as (
      select row_key, row_number() over (order by row_number) - 1 as i, count(*) over () as n
        from %1$I where entry_date is null
    ), alvo as (
      select t.row_key, h.row_key is not null as sem_data,
             case when h.row_key is null then null else $1 + ((h.i * $2) / h.n)::int end as est
        from %1$I t left join h on h.row_key = t.row_key
    )
    update %1$I t set est_date = alvo.est
      from alvo
     where alvo.row_key = t.row_key and t.est_date is distinct from alvo.est
  $f$, v_table) using v_inicio, v_dias;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.sheet_estimate_dates(text) from public, anon, authenticated;
grant execute on function public.sheet_estimate_dates(text) to service_role;

-- Aplica ao fim de cada sincronização (mesma transação e mesmo lock).
create or replace function public.sheet_sync_commit(p_run bigint, p_tab text, p_keys jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_table text := _sheet_tabela(p_tab);
  v_ins int; v_upd int; v_del int; v_stored int; v_est int;
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
  v_est := sheet_estimate_dates(p_tab);
  execute format('select count(*) from %I', v_table) into v_stored;

  return jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'deleted', v_del, 'stored', v_stored, 'estimated_changed', v_est);
end $$;

-- Casos únicos, agora com "dia" (real ou estimado) e a marca de estimado.
drop view if exists public.v_reshipment_cases;
drop view if exists public.v_supplier_issue_cases;
drop view if exists public.v_subscription_cases;

create view public.v_reshipment_cases with (security_invoker = true) as
  select distinct on (coalesce(order_number, row_key)) *,
         coalesce(entry_date, est_date) as dia, (entry_date is null and est_date is not null) as estimated
  from public.sheet_reshipments
  order by coalesce(order_number, row_key), row_number desc;

create view public.v_supplier_issue_cases with (security_invoker = true) as
  select distinct on (coalesce(order_number, row_key)) *,
         coalesce(entry_date, est_date) as dia, (entry_date is null and est_date is not null) as estimated
  from public.sheet_supplier_issues
  order by coalesce(order_number, row_key), row_number desc;

create view public.v_subscription_cases with (security_invoker = true) as
  select distinct on (coalesce(lower(email), row_key)) *,
         coalesce(entry_date, est_date) as dia, (entry_date is null and est_date is not null) as estimated
  from public.sheet_subscriptions
  order by coalesce(lower(email), row_key), row_number desc;

grant select on public.v_reshipment_cases, public.v_supplier_issue_cases, public.v_subscription_cases to authenticated, service_role;

create or replace function public.report_subscriptions(p_from date, p_to date)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with c as (select * from v_subscription_cases where dia between p_from and p_to),
  p as (select * from v_subscription_cases where dia between p_from - (p_to - p_from + 1) and p_from - 1),
  todos as (select * from v_subscription_cases)
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'count', count(*), 'estimated', count(*) filter (where estimated),
        'cancellations', count(*) filter (where management ilike 'cancel%'),
        'changes', count(*) filter (where management is not null and management not ilike 'cancel%'),
        'saved', count(*) filter (where outcome in ('Retained', 'Paused', 'Skipped')),
        'lost', count(*) filter (where outcome = 'Cancelled'),
        'no_reason', count(*) filter (where reason_group = 'No reason given')) from c),
    'previous', (select jsonb_build_object(
        'count', count(*), 'estimated', count(*) filter (where estimated),
        'cancellations', count(*) filter (where management ilike 'cancel%'),
        'changes', count(*) filter (where management is not null and management not ilike 'cancel%'),
        'saved', count(*) filter (where outcome in ('Retained', 'Paused', 'Skipped'))) from p),
    'by_day', _contagem((select jsonb_agg(jsonb_build_object('date', d, 'count', n) order by d)
        from (select dia d, count(*) n from c group by 1) x)),
    'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(reason_group, 'No reason given') k, count(*) n from c group by 1) x)),
    'by_management', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(management, 'Not filled') k, count(*) n from c group by 1) x)),
    'by_outcome', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(outcome, 'Not recorded') k, count(*) n from c group by 1) x)),
    'all_time', (select jsonb_build_object(
        'count', count(*), 'estimated', count(*) filter (where estimated),
        'undated', count(*) filter (where dia is null),
        'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
            from (select coalesce(reason_group, 'No reason given') k, count(*) n from todos group by 1) x))) from todos)
  );
$$;

create or replace function public.report_reshipments(p_from date, p_to date)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with c as (select * from v_reshipment_cases where dia between p_from and p_to),
  p as (select * from v_reshipment_cases where dia between p_from - (p_to - p_from + 1) and p_from - 1),
  todos as (select * from v_reshipment_cases)
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'count', count(*), 'estimated', count(*) filter (where estimated),
        'issued', count(*) filter (where status = 'Issued Reshipment'),
        'delivered', count(*) filter (where status in ('Fulfilled', 'Delivered')),
        'not_messaged', count(*) filter (where messaged is null or messaged not ilike 'messaged%'),
        'refund_requests', count(*) filter (where customer_request = 'Refund')) from c),
    'previous', (select jsonb_build_object(
        'count', count(*), 'estimated', count(*) filter (where estimated),
        'issued', count(*) filter (where status = 'Issued Reshipment'),
        'delivered', count(*) filter (where status in ('Fulfilled', 'Delivered')),
        'not_messaged', count(*) filter (where messaged is null or messaged not ilike 'messaged%'),
        'refund_requests', count(*) filter (where customer_request = 'Refund')) from p),
    'by_day', _contagem((select jsonb_agg(jsonb_build_object('date', d, 'count', n) order by d)
        from (select dia d, count(*) n from c group by 1) x)),
    'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(reason, 'No reason') k, count(*) n from c group by 1) x)),
    'by_status', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(status, 'No status') k, count(*) n from c group by 1) x)),
    'by_request', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(customer_request, 'Not filled') k, count(*) n from c group by 1) x)),
    'by_agent', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(agent, 'Unassigned') k, count(*) n from c group by 1) x)),
    'all_time', (select jsonb_build_object(
        'count', count(*), 'estimated', count(*) filter (where estimated),
        'undated', count(*) filter (where dia is null),
        'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
            from (select coalesce(reason, 'No reason') k, count(*) n from todos group by 1) x)),
        'by_status', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
            from (select coalesce(status, 'No status') k, count(*) n from todos group by 1) x))) from todos)
  );
$$;

create or replace function public.report_supplier_issues(p_from date, p_to date)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with c as (select * from v_supplier_issue_cases where dia between p_from and p_to),
  p as (select * from v_supplier_issue_cases where dia between p_from - (p_to - p_from + 1) and p_from - 1),
  todos as (select * from v_supplier_issue_cases)
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'count', count(*), 'estimated', count(*) filter (where estimated),
        'unfulfilled', count(*) filter (where reason = 'Unfulfilled'),
        'lost', count(*) filter (where reason = 'Lost in transit'),
        'quality', count(*) filter (where reason in ('Unbranded Sealing Mask Received', 'Damaged Item', 'Wrong item received', 'Item missing')),
        'not_messaged', count(*) filter (where status is null or status not ilike 'messaged%')) from c),
    'previous', (select jsonb_build_object(
        'count', count(*), 'estimated', count(*) filter (where estimated),
        'unfulfilled', count(*) filter (where reason = 'Unfulfilled'),
        'lost', count(*) filter (where reason = 'Lost in transit'),
        'quality', count(*) filter (where reason in ('Unbranded Sealing Mask Received', 'Damaged Item', 'Wrong item received', 'Item missing')),
        'not_messaged', count(*) filter (where status is null or status not ilike 'messaged%')) from p),
    'by_day', _contagem((select jsonb_agg(jsonb_build_object('date', d, 'count', n) order by d)
        from (select dia d, count(*) n from c group by 1) x)),
    'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(reason, 'No reason') k, count(*) n from c group by 1) x)),
    'by_agent', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(agent, 'Unassigned') k, count(*) n from c group by 1) x)),
    'all_time', (select jsonb_build_object(
        'count', count(*), 'estimated', count(*) filter (where estimated),
        'undated', count(*) filter (where dia is null),
        'not_messaged', count(*) filter (where status is null or status not ilike 'messaged%'),
        'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
            from (select coalesce(reason, 'No reason') k, count(*) n from todos group by 1) x))) from todos)
  );
$$;

create or replace function public.data_check()
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select jsonb_build_object(
    'refunds', jsonb_build_object(
      'last_run', (select to_jsonb(x) from (select * from sheet_sync_runs where tab = 'refunds' and not unchanged order by id desc limit 1) x),
      'last_check', (select max(finished_at) from sheet_sync_runs where tab = 'refunds' and ok),
      'stored', (select count(*) from sheet_refunds),
      'undated', (select count(*) from sheet_refunds where refund_date is null),
      'corrected', (select count(*) from sheet_refunds where date_corrected),
      'refunded_sum', (select coalesce(sum(refunded_amount), 0) from sheet_refunds),
      'with_issues', (select count(*) from sheet_refunds where cardinality(issues) > 0),
      'issues', _contagem((select jsonb_agg(jsonb_build_object('row', row_number, 'issues', issues) order by row_number)
          from (select * from sheet_refunds where cardinality(issues) > 0 order by row_number limit 50) x)),
      'corrections', _contagem((select jsonb_agg(jsonb_build_object('row', row_number, 'raw', refund_date_raw, 'used', refund_date) order by row_number)
          from (select * from sheet_refunds where date_corrected order by row_number limit 50) x))),
    'subscriptions', jsonb_build_object(
      'last_run', (select to_jsonb(x) from (select * from sheet_sync_runs where tab = 'subscriptions' and not unchanged order by id desc limit 1) x),
      'last_check', (select max(finished_at) from sheet_sync_runs where tab = 'subscriptions' and ok),
      'stored', (select count(*) from sheet_subscriptions),
      'cases', (select count(*) from v_subscription_cases),
      'undated', (select count(*) from sheet_subscriptions where entry_date is null and est_date is null),
      'estimated', (select count(*) from sheet_subscriptions where entry_date is null and est_date is not null),
      'with_issues', (select count(*) from sheet_subscriptions where cardinality(issues) > 0),
      'issues', _contagem((select jsonb_agg(jsonb_build_object('row', row_number, 'issues', issues) order by row_number)
          from (select * from sheet_subscriptions where cardinality(issues) > 0 order by row_number limit 50) x))),
    'reshipments', jsonb_build_object(
      'last_run', (select to_jsonb(x) from (select * from sheet_sync_runs where tab = 'reshipments' and not unchanged order by id desc limit 1) x),
      'last_check', (select max(finished_at) from sheet_sync_runs where tab = 'reshipments' and ok),
      'stored', (select count(*) from sheet_reshipments),
      'cases', (select count(*) from v_reshipment_cases),
      'undated', (select count(*) from sheet_reshipments where entry_date is null and est_date is null),
      'estimated', (select count(*) from sheet_reshipments where entry_date is null and est_date is not null),
      'with_issues', (select count(*) from sheet_reshipments where cardinality(issues) > 0),
      'issues', _contagem((select jsonb_agg(jsonb_build_object('row', row_number, 'issues', issues) order by row_number)
          from (select * from sheet_reshipments where cardinality(issues) > 0 order by row_number limit 50) x))),
    'supplier_issues', jsonb_build_object(
      'last_run', (select to_jsonb(x) from (select * from sheet_sync_runs where tab = 'supplier_issues' and not unchanged order by id desc limit 1) x),
      'last_check', (select max(finished_at) from sheet_sync_runs where tab = 'supplier_issues' and ok),
      'stored', (select count(*) from sheet_supplier_issues),
      'cases', (select count(*) from v_supplier_issue_cases),
      'undated', (select count(*) from sheet_supplier_issues where entry_date is null and est_date is null),
      'estimated', (select count(*) from sheet_supplier_issues where entry_date is null and est_date is not null),
      'with_issues', (select count(*) from sheet_supplier_issues where cardinality(issues) > 0),
      'issues', _contagem((select jsonb_agg(jsonb_build_object('row', row_number, 'issues', issues) order by row_number)
          from (select * from sheet_supplier_issues where cardinality(issues) > 0 order by row_number limit 50) x)))
  );
$$;

select sheet_estimate_dates('subscriptions'), sheet_estimate_dates('reshipments'), sheet_estimate_dates('supplier_issues');
