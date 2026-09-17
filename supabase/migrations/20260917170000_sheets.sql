-- =========================================================================
-- Espelho da planilha "Quasi — Master Tracking Spreadsheet".
--
-- Quatro abas viram quatro tabelas. Quem escreve nelas é só a função
-- `sheets-sync` (chamada pelo script da planilha); o dashboard só lê, e só
-- através das funções de relatório abaixo, com usuário logado.
--
-- Cada linha da planilha tem uma chave (row_key) derivada do seu conteúdo.
-- A sincronização insere o que é novo, apaga o que sumiu e só atualiza o número
-- da linha quando alguém move linhas: nada é reescrito à toa.
-- =========================================================================

create table if not exists public.sheet_refunds (
  row_key             text primary key,
  row_number          int  not null,
  order_number        text,
  refund_date         date,
  refund_date_raw     text,
  date_corrected      boolean not null default false,  -- dia e mês estavam trocados
  reason              text,
  resolution          text,
  refund_type         text,                            -- full | partial
  total_amount        numeric(12,2),
  refund_pct          numeric(7,4),
  refunded_amount     numeric(12,2),
  ticket_link         text,
  refund_status       text,
  subscription_status text,
  issues              text[] not null default '{}',
  synced_at           timestamptz not null default now()
);
create index if not exists sheet_refunds_date_idx  on public.sheet_refunds (refund_date);
create index if not exists sheet_refunds_order_idx on public.sheet_refunds (order_number);

create table if not exists public.sheet_subscriptions (
  row_key      text primary key,
  row_number   int  not null,
  entry_date   date,
  email        text,
  management   text,
  reason_raw   text,
  reason_group text,
  requests     text,
  completed    text,
  outcome      text,
  issues       text[] not null default '{}',
  synced_at    timestamptz not null default now()
);
create index if not exists sheet_subscriptions_date_idx  on public.sheet_subscriptions (entry_date);
create index if not exists sheet_subscriptions_email_idx on public.sheet_subscriptions (email);

create table if not exists public.sheet_reshipments (
  row_key          text primary key,
  row_number       int  not null,
  entry_date       date,
  agent            text,
  order_number     text,
  reason           text,
  description      text,
  customer_request text,
  new_order_number text,
  status           text,
  messaged         text,
  issues           text[] not null default '{}',
  synced_at        timestamptz not null default now()
);
create index if not exists sheet_reshipments_date_idx      on public.sheet_reshipments (entry_date);
create index if not exists sheet_reshipments_order_idx     on public.sheet_reshipments (order_number);
create index if not exists sheet_reshipments_new_order_idx on public.sheet_reshipments (new_order_number);

create table if not exists public.sheet_supplier_issues (
  row_key             text primary key,
  row_number          int  not null,
  entry_date          date,
  agent               text,
  order_number        text,
  reason              text,
  description         text,
  reshipment_tracking text,
  status              text,
  issues              text[] not null default '{}',
  synced_at           timestamptz not null default now()
);
create index if not exists sheet_supplier_issues_date_idx  on public.sheet_supplier_issues (entry_date);
create index if not exists sheet_supplier_issues_order_idx on public.sheet_supplier_issues (order_number);

-- Histórico das sincronizações: é daqui que sai a tela "Data check".
create table if not exists public.sheet_sync_runs (
  id            bigint generated always as identity primary key,
  tab           text not null,
  sheet_name    text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  content_hash  text,
  unchanged     boolean not null default false,
  rows_received int,
  inserted      int,
  updated       int,
  deleted       int,
  rows_stored   int,
  sheet_stats   jsonb,
  ok            boolean,
  error         text
);
create index if not exists sheet_sync_runs_tab_idx on public.sheet_sync_runs (tab, id desc);

-- Área de preparo: a função grava as linhas recebidas aqui em blocos e depois
-- aplica tudo de uma vez numa transação.
create table if not exists public.sheet_sync_staging (
  run_id     bigint not null,
  row_key    text   not null,
  row_number int    not null,
  rec        jsonb  not null
);
create index if not exists sheet_sync_staging_run_idx on public.sheet_sync_staging (run_id, row_key);

/* -------------------------------------------------------------- acesso -- */

alter table public.sheet_refunds         enable row level security;
alter table public.sheet_subscriptions   enable row level security;
alter table public.sheet_reshipments     enable row level security;
alter table public.sheet_supplier_issues enable row level security;
alter table public.sheet_sync_runs       enable row level security;
alter table public.sheet_sync_staging    enable row level security;

revoke all on public.sheet_refunds, public.sheet_subscriptions, public.sheet_reshipments,
  public.sheet_supplier_issues, public.sheet_sync_runs, public.sheet_sync_staging from anon;

-- Usuário logado (o time) pode ler as quatro tabelas e o histórico de sincronização.
-- A área de preparo não tem policy: ninguém lê por fora.
do $$
declare t text;
begin
  foreach t in array array['sheet_refunds','sheet_subscriptions','sheet_reshipments','sheet_supplier_issues','sheet_sync_runs'] loop
    execute format('drop policy if exists "time le" on public.%I', t);
    execute format('create policy "time le" on public.%I for select to authenticated using (true)', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

/* ------------------------------------------------------ casos únicos -- */
-- Regra combinada: quando o mesmo pedido (ou e-mail) aparece mais de uma vez,
-- vale a linha mais nova, que é a mais de baixo. Reembolsos NÃO passam por isso:
-- ali cada linha é um reembolso.

create or replace view public.v_reshipment_cases with (security_invoker = true) as
  select distinct on (coalesce(order_number, row_key)) *
  from public.sheet_reshipments
  order by coalesce(order_number, row_key), row_number desc;

create or replace view public.v_supplier_issue_cases with (security_invoker = true) as
  select distinct on (coalesce(order_number, row_key)) *
  from public.sheet_supplier_issues
  order by coalesce(order_number, row_key), row_number desc;

create or replace view public.v_subscription_cases with (security_invoker = true) as
  select distinct on (coalesce(lower(email), row_key)) *
  from public.sheet_subscriptions
  order by coalesce(lower(email), row_key), row_number desc;

/* ------------------------------------------------- aplicar sincronização -- */

create or replace function public.sheet_sync_commit(p_run bigint, p_tab text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text;
  v_ins int; v_upd int; v_del int; v_stored int;
begin
  v_table := case p_tab
    when 'refunds'         then 'sheet_refunds'
    when 'subscriptions'   then 'sheet_subscriptions'
    when 'reshipments'     then 'sheet_reshipments'
    when 'supplier_issues' then 'sheet_supplier_issues'
  end;
  if v_table is null then raise exception 'aba desconhecida: %', p_tab; end if;

  -- Duas sincronizações da mesma aba nunca se misturam.
  perform pg_advisory_xact_lock(hashtext('sheet_sync:' || p_tab));

  execute format(
    'delete from %I t where not exists (select 1 from sheet_sync_staging s where s.run_id = $1 and s.row_key = t.row_key)',
    v_table) using p_run;
  get diagnostics v_del = row_count;

  execute format(
    'update %I t set row_number = s.row_number, synced_at = now()
       from sheet_sync_staging s
      where s.run_id = $1 and s.row_key = t.row_key and t.row_number <> s.row_number',
    v_table) using p_run;
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
end;
$$;

revoke all on function public.sheet_sync_commit(bigint, text) from public, anon, authenticated;

/* ------------------------------------------------------------ relatórios -- */
-- Todos devolvem um JSON pronto para a tela: uma chamada por aba, em milissegundos.

create or replace function public._contagem(p jsonb) returns jsonb language sql immutable as $$ select coalesce(p, '[]'::jsonb) $$;

create or replace function public.report_refunds(p_from date, p_to date)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with r as (select * from sheet_refunds where refund_date between p_from and p_to),
  p as (select * from sheet_refunds where refund_date between p_from - (p_to - p_from + 1) and p_from - 1)
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'count', count(*),
        'refunded', coalesce(sum(refunded_amount), 0),
        'order_value', coalesce(sum(total_amount), 0),
        'partial', count(*) filter (where refund_type = 'partial'),
        'full', count(*) filter (where refund_type = 'full'),
        'kept', coalesce(sum(total_amount - refunded_amount) filter (where refund_type = 'partial'), 0),
        'need_verify', count(*) filter (where refund_status ilike 'need%')) from r),
    'previous', (select jsonb_build_object(
        'count', count(*),
        'refunded', coalesce(sum(refunded_amount), 0),
        'partial', count(*) filter (where refund_type = 'partial'),
        'full', count(*) filter (where refund_type = 'full'),
        'kept', coalesce(sum(total_amount - refunded_amount) filter (where refund_type = 'partial'), 0),
        'need_verify', count(*) filter (where refund_status ilike 'need%')) from p),
    'by_day', _contagem((select jsonb_agg(jsonb_build_object('date', d, 'count', c, 'refunded', s) order by d)
        from (select refund_date d, count(*) c, coalesce(sum(refunded_amount), 0) s from r group by 1) x)),
    'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', c, 'amount', s) order by c desc)
        from (select coalesce(reason, 'No reason') k, count(*) c, coalesce(sum(refunded_amount), 0) s from r group by 1) x)),
    'by_resolution', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', c, 'amount', s) order by c desc)
        from (select coalesce(resolution, 'No resolution') k, count(*) c, coalesce(sum(refunded_amount), 0) s from r group by 1) x)),
    'by_subscription', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', c) order by c desc)
        from (select coalesce(subscription_status, 'Not filled') k, count(*) c from r group by 1) x)),
    'verify_list', _contagem((select jsonb_agg(jsonb_build_object('row', row_number, 'order', order_number, 'date', refund_date,
                          'amount', refunded_amount, 'reason', reason) order by row_number desc)
        from (select * from r where refund_status ilike 'need%' order by row_number desc limit 50) x)),
    'undated', (select count(*) from sheet_refunds where refund_date is null)
  );
$$;

create or replace function public.report_subscriptions(p_from date, p_to date)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with c as (select * from v_subscription_cases where entry_date between p_from and p_to),
  p as (select * from v_subscription_cases where entry_date between p_from - (p_to - p_from + 1) and p_from - 1),
  todos as (select * from v_subscription_cases)
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'count', count(*),
        'cancellations', count(*) filter (where management ilike 'cancel%'),
        'changes', count(*) filter (where management is not null and management not ilike 'cancel%'),
        'saved', count(*) filter (where outcome in ('Retained', 'Paused', 'Skipped')),
        'lost', count(*) filter (where outcome = 'Cancelled'),
        'no_reason', count(*) filter (where reason_group = 'No reason given')) from c),
    'previous', (select jsonb_build_object(
        'count', count(*),
        'cancellations', count(*) filter (where management ilike 'cancel%'),
        'changes', count(*) filter (where management is not null and management not ilike 'cancel%'),
        'saved', count(*) filter (where outcome in ('Retained', 'Paused', 'Skipped'))) from p),
    'by_day', _contagem((select jsonb_agg(jsonb_build_object('date', d, 'count', n) order by d)
        from (select entry_date d, count(*) n from c group by 1) x)),
    'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(reason_group, 'No reason given') k, count(*) n from c group by 1) x)),
    'by_management', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(management, 'Not filled') k, count(*) n from c group by 1) x)),
    'by_outcome', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(outcome, 'Not recorded') k, count(*) n from c group by 1) x)),
    'all_time', (select jsonb_build_object(
        'count', count(*),
        'undated', count(*) filter (where entry_date is null),
        'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
            from (select coalesce(reason_group, 'No reason given') k, count(*) n from todos group by 1) x))) from todos)
  );
$$;

create or replace function public.report_reshipments(p_from date, p_to date)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with c as (select * from v_reshipment_cases where entry_date between p_from and p_to),
  p as (select * from v_reshipment_cases where entry_date between p_from - (p_to - p_from + 1) and p_from - 1),
  todos as (select * from v_reshipment_cases)
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'count', count(*),
        'issued', count(*) filter (where status = 'Issued Reshipment'),
        'delivered', count(*) filter (where status in ('Fulfilled', 'Delivered')),
        'not_messaged', count(*) filter (where messaged is null or messaged not ilike 'messaged%'),
        'refund_requests', count(*) filter (where customer_request = 'Refund')) from c),
    'previous', (select jsonb_build_object(
        'count', count(*),
        'issued', count(*) filter (where status = 'Issued Reshipment'),
        'delivered', count(*) filter (where status in ('Fulfilled', 'Delivered')),
        'not_messaged', count(*) filter (where messaged is null or messaged not ilike 'messaged%'),
        'refund_requests', count(*) filter (where customer_request = 'Refund')) from p),
    'by_day', _contagem((select jsonb_agg(jsonb_build_object('date', d, 'count', n) order by d)
        from (select entry_date d, count(*) n from c group by 1) x)),
    'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(reason, 'No reason') k, count(*) n from c group by 1) x)),
    'by_status', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(status, 'No status') k, count(*) n from c group by 1) x)),
    'by_request', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(customer_request, 'Not filled') k, count(*) n from c group by 1) x)),
    'by_agent', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(agent, 'Unassigned') k, count(*) n from c group by 1) x)),
    'all_time', (select jsonb_build_object(
        'count', count(*),
        'undated', count(*) filter (where entry_date is null),
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
  with c as (select * from v_supplier_issue_cases where entry_date between p_from and p_to),
  p as (select * from v_supplier_issue_cases where entry_date between p_from - (p_to - p_from + 1) and p_from - 1),
  todos as (select * from v_supplier_issue_cases)
  select jsonb_build_object(
    'totals', (select jsonb_build_object(
        'count', count(*),
        'unfulfilled', count(*) filter (where reason = 'Unfulfilled'),
        'lost', count(*) filter (where reason = 'Lost in transit'),
        'quality', count(*) filter (where reason in ('Unbranded Sealing Mask Received', 'Damaged Item', 'Wrong item received', 'Item missing')),
        'not_messaged', count(*) filter (where status is null or status not ilike 'messaged%')) from c),
    'previous', (select jsonb_build_object(
        'count', count(*),
        'unfulfilled', count(*) filter (where reason = 'Unfulfilled'),
        'lost', count(*) filter (where reason = 'Lost in transit'),
        'quality', count(*) filter (where reason in ('Unbranded Sealing Mask Received', 'Damaged Item', 'Wrong item received', 'Item missing')),
        'not_messaged', count(*) filter (where status is null or status not ilike 'messaged%')) from p),
    'by_day', _contagem((select jsonb_agg(jsonb_build_object('date', d, 'count', n) order by d)
        from (select entry_date d, count(*) n from c group by 1) x)),
    'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(reason, 'No reason') k, count(*) n from c group by 1) x)),
    'by_agent', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
        from (select coalesce(agent, 'Unassigned') k, count(*) n from c group by 1) x)),
    'all_time', (select jsonb_build_object(
        'count', count(*),
        'undated', count(*) filter (where entry_date is null),
        'not_messaged', count(*) filter (where status is null or status not ilike 'messaged%'),
        'by_reason', _contagem((select jsonb_agg(jsonb_build_object('key', k, 'count', n) order by n desc)
            from (select coalesce(reason, 'No reason') k, count(*) n from todos group by 1) x))) from todos)
  );
$$;

/* ------------------------------------------------------ busca por pedido -- */
-- Junta numa resposta só tudo o que a planilha tem sobre um pedido (ou e-mail).

create or replace function public.order_lookup(p_query text)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with q as (
    select lower(trim(p_query)) as txt,
           regexp_replace(lower(trim(p_query)), '^#|\.0$', '', 'g') as pedido
  )
  select jsonb_build_object(
    'refunds', _contagem((select jsonb_agg(to_jsonb(r) - 'row_key' - 'synced_at' order by r.row_number desc)
        from sheet_refunds r, q where length(q.pedido) >= 3 and lower(r.order_number) = q.pedido)),
    'reshipments', _contagem((select jsonb_agg(to_jsonb(r) - 'row_key' - 'synced_at' order by r.row_number desc)
        from sheet_reshipments r, q where length(q.pedido) >= 3
          and (lower(r.order_number) = q.pedido or lower(r.new_order_number) = q.pedido))),
    'supplier_issues', _contagem((select jsonb_agg(to_jsonb(r) - 'row_key' - 'synced_at' order by r.row_number desc)
        from sheet_supplier_issues r, q where length(q.pedido) >= 3 and lower(r.order_number) = q.pedido)),
    'subscriptions', _contagem((select jsonb_agg(to_jsonb(r) - 'row_key' - 'synced_at' order by r.row_number desc)
        from sheet_subscriptions r, q where position('@' in q.txt) > 0 and lower(r.email) = q.txt))
  );
$$;

/* ------------------------------------------------------------ conferência -- */

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
      'undated', (select count(*) from sheet_subscriptions where entry_date is null),
      'with_issues', (select count(*) from sheet_subscriptions where cardinality(issues) > 0),
      'issues', _contagem((select jsonb_agg(jsonb_build_object('row', row_number, 'issues', issues) order by row_number)
          from (select * from sheet_subscriptions where cardinality(issues) > 0 order by row_number limit 50) x))),
    'reshipments', jsonb_build_object(
      'last_run', (select to_jsonb(x) from (select * from sheet_sync_runs where tab = 'reshipments' and not unchanged order by id desc limit 1) x),
      'last_check', (select max(finished_at) from sheet_sync_runs where tab = 'reshipments' and ok),
      'stored', (select count(*) from sheet_reshipments),
      'cases', (select count(*) from v_reshipment_cases),
      'undated', (select count(*) from sheet_reshipments where entry_date is null),
      'with_issues', (select count(*) from sheet_reshipments where cardinality(issues) > 0),
      'issues', _contagem((select jsonb_agg(jsonb_build_object('row', row_number, 'issues', issues) order by row_number)
          from (select * from sheet_reshipments where cardinality(issues) > 0 order by row_number limit 50) x))),
    'supplier_issues', jsonb_build_object(
      'last_run', (select to_jsonb(x) from (select * from sheet_sync_runs where tab = 'supplier_issues' and not unchanged order by id desc limit 1) x),
      'last_check', (select max(finished_at) from sheet_sync_runs where tab = 'supplier_issues' and ok),
      'stored', (select count(*) from sheet_supplier_issues),
      'cases', (select count(*) from v_supplier_issue_cases),
      'undated', (select count(*) from sheet_supplier_issues where entry_date is null),
      'with_issues', (select count(*) from sheet_supplier_issues where cardinality(issues) > 0),
      'issues', _contagem((select jsonb_agg(jsonb_build_object('row', row_number, 'issues', issues) order by row_number)
          from (select * from sheet_supplier_issues where cardinality(issues) > 0 order by row_number limit 50) x)))
  );
$$;

revoke all on function public.report_refunds(date, date), public.report_subscriptions(date, date),
  public.report_reshipments(date, date), public.report_supplier_issues(date, date),
  public.order_lookup(text), public.data_check() from public, anon;
grant execute on function public.report_refunds(date, date), public.report_subscriptions(date, date),
  public.report_reshipments(date, date), public.report_supplier_issues(date, date),
  public.order_lookup(text), public.data_check() to authenticated;
