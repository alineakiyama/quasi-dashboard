-- Mesmo label chega em dois formatos: "Damaged Item" (webhook) e "damaged-item" (API).
-- Padroniza em minúsculas com hífen, sem repetir, e corrige o que já foi gravado.

create or replace function public._cl_label(p text) returns text
language sql immutable as $$ select regexp_replace(lower(trim(p)), '[s_]+', '-', 'g') $$;

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
         coalesce(array(select distinct _cl_label(x) from jsonb_array_elements_text(coalesce(r->'labels', '[]')) x where trim(x) <> ''), '{}'),
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


update public.cl_conversations
   set labels = coalesce(array(select distinct _cl_label(x) from unnest(labels) x where trim(x) <> ''), '{}')
 where labels::text <> coalesce(array(select distinct _cl_label(x) from unnest(labels) x where trim(x) <> ''), '{}')::text;

update public.cl_manual_labels set title = _cl_label(title) where title <> _cl_label(title);

grant execute on function public._cl_label(text) to service_role;
