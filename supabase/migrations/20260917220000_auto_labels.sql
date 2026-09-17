-- Auto-labels do Commslayer.
--
-- A API não tem relatório de auto-labels (só de labels manuais). O dado existe
-- em cada ticket: o campo `labels` traz os auto-labels (ex.: "subscription",
-- "cancel-order") junto com os manuais. Então:
--   · o webhook do Commslayer avisa a função commslayer-events a cada ticket
--     criado ou alterado, e ela guarda só o necessário (nada de cliente);
--   · a cada 10 min a mesma função confere os tickets mais recentes pela API,
--     para cobrir aviso perdido (o webhook desliga sozinho após falhas seguidas);
--   · depois de 90 dias o ticket vira contagem diária e é apagado — o banco não
--     cresce sem parar.

create table if not exists public.cl_conversations (
  id                        bigint primary key,
  display_id                bigint,
  created_at                timestamptz not null,
  updated_at                timestamptz,
  status                    text,
  labels                    text[] not null default '{}',
  contact_reason_id         bigint,
  contact_reason            text,
  contact_reason_parent_id  bigint,
  source                    text not null,          -- 'webhook' ou 'api'
  received_at               timestamptz not null default now()
);
create index if not exists cl_conversations_created_idx on public.cl_conversations (created_at);

-- Labels criados à mão no Commslayer (lista de /labels). O que não está aqui é auto-label.
create table if not exists public.cl_manual_labels (
  title text primary key,
  seen_at timestamptz not null default now()
);

-- Contagem diária de tickets com mais de 90 dias (dia no fuso da conta: Nova York).
create table if not exists public.cl_label_daily (
  day     date not null,
  label   text not null,            -- '' = linha com o total de tickets do dia
  tickets int  not null,
  primary key (day, label)
);

-- Estado: cursor do histórico, saúde do webhook, última conferência.
create table if not exists public.cl_state (
  k text primary key,
  v jsonb not null,
  updated_at timestamptz not null default now()
);

-- Registro curto dos avisos recebidos (tipo e formato, sem valores). Guarda 7 dias.
create table if not exists public.cl_events_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  event       text,
  shape       text,
  stored      boolean not null
);
create index if not exists cl_events_log_at_idx on public.cl_events_log (at);

alter table public.cl_conversations enable row level security;
alter table public.cl_manual_labels enable row level security;
alter table public.cl_label_daily   enable row level security;
alter table public.cl_state         enable row level security;
alter table public.cl_events_log    enable row level security;

grant select, insert, update, delete on
  public.cl_conversations, public.cl_manual_labels, public.cl_label_daily, public.cl_state, public.cl_events_log
to service_role;
grant usage, select on sequence public.cl_events_log_id_seq to service_role;

/* ------------------------------------------------------------ gravação -- */

-- Recebe tickets (do webhook ou da API) e grava o mais recente de cada um.
create or replace function public.cl_upsert(p_rows jsonb, p_source text)
returns int
language plpgsql security definer set search_path = public
as $$
declare v int;
begin
  insert into cl_conversations as t
    (id, display_id, created_at, updated_at, status, labels, contact_reason_id, contact_reason, contact_reason_parent_id, source, received_at)
  select distinct on ((r->>'id')::bigint)
         (r->>'id')::bigint,
         nullif(r->>'display_id', '')::bigint,
         (r->>'created_at')::timestamptz,
         nullif(r->>'updated_at', '')::timestamptz,
         r->>'status',
         coalesce(array(select lower(trim(x)) from jsonb_array_elements_text(coalesce(r->'labels', '[]')) x where trim(x) <> ''), '{}'),
         nullif(r#>>'{contact_reason,id}', '')::bigint,
         r#>>'{contact_reason,name}',
         nullif(r#>>'{contact_reason,parent_id}', '')::bigint,
         p_source,
         now()
    from jsonb_array_elements(p_rows) r
   where r ? 'id' and r ? 'created_at' and (r->>'created_at') is not null
   order by (r->>'id')::bigint, nullif(r->>'updated_at', '')::timestamptz desc nulls last
  on conflict (id) do update set
    display_id = excluded.display_id,
    updated_at = excluded.updated_at,
    status = excluded.status,
    labels = excluded.labels,
    contact_reason_id = excluded.contact_reason_id,
    contact_reason = excluded.contact_reason,
    contact_reason_parent_id = excluded.contact_reason_parent_id,
    source = excluded.source,
    received_at = now()
  where t.updated_at is null or excluded.updated_at is null or excluded.updated_at >= t.updated_at;
  get diagnostics v = row_count;
  return v;
end $$;

-- Tickets com mais de 90 dias viram contagem diária. Dias já resumidos não mudam.
create or replace function public.cl_rollup()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_corte date := (now() at time zone 'America/New_York')::date - 90;
  v int;
begin
  insert into cl_label_daily (day, label, tickets)
  select d, l, n from (
    select (created_at at time zone 'America/New_York')::date d, '' l, count(*)::int n
      from cl_conversations where (created_at at time zone 'America/New_York')::date < v_corte group by 1
    union all
    select (c.created_at at time zone 'America/New_York')::date, lab, count(*)::int
      from cl_conversations c, unnest(c.labels) lab
     where (c.created_at at time zone 'America/New_York')::date < v_corte group by 1, 2
  ) x
  on conflict (day, label) do update set tickets = cl_label_daily.tickets + excluded.tickets;

  delete from cl_conversations where (created_at at time zone 'America/New_York')::date < v_corte;
  get diagnostics v = row_count;
  delete from cl_events_log where at < now() - interval '7 days';
  delete from sheet_sync_runs r
   where r.finished_at < now() - interval '30 days'
     and r.id not in (select max(id) from sheet_sync_runs where ok group by tab);
  return v;
end $$;

revoke all on function public.cl_upsert(jsonb, text), public.cl_rollup() from public, anon, authenticated;
grant execute on function public.cl_upsert(jsonb, text), public.cl_rollup() to service_role;

/* ------------------------------------------------------------ relatório -- */

-- Auto-labels de um período (e do período de comparação), no fuso de Nova York.
-- "Tickets" = tickets criados no período. Um ticket com dois auto-labels conta
-- nos dois; a porcentagem de cada label é sobre a soma, como no portal.
create or replace function public.report_auto_labels(p_from date, p_to date, p_cfrom date default null, p_cto date default null)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with corte as (select (now() at time zone 'America/New_York')::date - 90 as d),
  brutos as (
    select (c.created_at at time zone 'America/New_York')::date dia, c.labels
      from cl_conversations c
     where c.created_at >= (least(p_from, coalesce(p_cfrom, p_from))::timestamp at time zone 'America/New_York')
       and c.created_at <  ((greatest(p_to, coalesce(p_cto, p_to)) + 1)::timestamp at time zone 'America/New_York')
  ),
  por_label as (
    select 'cur' per, lab label, count(*)::int n from brutos, unnest(labels) lab
     where dia between p_from and p_to and lab not in (select title from cl_manual_labels) group by 2
    union all
    select 'prev', lab, count(*)::int from brutos, unnest(labels) lab
     where p_cfrom is not null and dia between p_cfrom and p_cto and lab not in (select title from cl_manual_labels) group by 2
    union all
    select 'cur', label, sum(tickets)::int from cl_label_daily
     where label <> '' and day between p_from and p_to and day < (select d from corte)
       and label not in (select title from cl_manual_labels) group by 2
    union all
    select 'prev', label, sum(tickets)::int from cl_label_daily
     where p_cfrom is not null and label <> '' and day between p_cfrom and p_cto and day < (select d from corte)
       and label not in (select title from cl_manual_labels) group by 2
  ),
  juntos as (
    select label, sum(n) filter (where per = 'cur')::int cur, sum(n) filter (where per = 'prev')::int prev
      from por_label group by label
  )
  select jsonb_build_object(
    'labels', coalesce((select jsonb_agg(jsonb_build_object('label', label, 'count', coalesce(cur, 0), 'previous', prev)
                         order by coalesce(cur, 0) desc, label) from juntos), '[]'),
    'tickets', (select count(*) from brutos where dia between p_from and p_to)
             + coalesce((select sum(tickets) from cl_label_daily where label = '' and day between p_from and p_to and day < (select d from corte)), 0),
    'tickets_previous', case when p_cfrom is null then null else
               (select count(*) from brutos where dia between p_cfrom and p_cto)
             + coalesce((select sum(tickets) from cl_label_daily where label = '' and day between p_cfrom and p_cto and day < (select d from corte)), 0) end,
    'coverage_from', (select (v->>'from')::date from cl_state where k = 'coverage'),
    'last_event_at', (select max(received_at) from cl_conversations),
    'webhook', (select v from cl_state where k = 'webhook')
  );
$$;

revoke all on function public.report_auto_labels(date, date, date, date) from public, anon, authenticated;
grant execute on function public.report_auto_labels(date, date, date, date) to service_role;
