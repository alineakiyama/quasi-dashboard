-- Corrige _cl_label: a versão anterior perdeu a barra invertida da expressão e
-- trocava a letra "s" por hífen. Os tickets gravados são regravados pela
-- conferência (API), que traz os labels originais.

create or replace function public._cl_label(p text) returns text
language sql immutable as $$ select regexp_replace(lower(trim(p)), '[[:space:]_]+', '-', 'g') $$;

-- Força a conferência a sobrescrever: a API manda o mesmo updated_at já gravado.
update public.cl_conversations set updated_at = null;
delete from public.cl_manual_labels;
