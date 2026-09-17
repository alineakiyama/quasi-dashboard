-- Lista de labels manuais vem do relatório de Labels (o /labels da API traz
-- também os auto-labels). Troca a lista inteira de uma vez, já no formato padrão.
create or replace function public.cl_set_manual_labels(p_titles text[])
returns int
language plpgsql security definer set search_path = public
as $$
declare v int;
begin
  delete from cl_manual_labels where title <> all (select _cl_label(t) from unnest(p_titles) t);
  insert into cl_manual_labels (title, seen_at)
  select distinct _cl_label(t), now() from unnest(p_titles) t where trim(t) <> ''
  on conflict (title) do update set seen_at = now();
  select count(*) into v from cl_manual_labels;
  return v;
end $$;
revoke all on function public.cl_set_manual_labels(text[]) from public, anon, authenticated;
grant execute on function public.cl_set_manual_labels(text[]) to service_role;

delete from public.cl_manual_labels;

-- Conserta os poucos labels que a versão com defeito gravou ("-ub-cription"):
-- troca pelo label correto cuja forma com "s" virando hífen é igual.
with bons as (
  select distinct l from public.cl_conversations, unnest(labels) l where l !~ '(^-|-t$|[[:space:]])' and l not like '%-t-%'
), conserto as (
  select c.id, array(
    select distinct coalesce(
      (select b.l from bons b where regexp_replace(b.l, 's', '-', 'g') = regexp_replace(_cl_label(x), 's', '-', 'g') limit 1),
      _cl_label(x))
    from unnest(c.labels) x) novos
  from public.cl_conversations c
)
update public.cl_conversations c set labels = conserto.novos
  from conserto where conserto.id = c.id and c.labels::text <> conserto.novos::text;
