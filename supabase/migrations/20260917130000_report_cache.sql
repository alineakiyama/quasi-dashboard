-- Cache dos relatórios do Commslayer.
--
-- Cada relatório do Commslayer leva de 2 a 4 segundos. A função `reports` guarda
-- aqui a resposta de cada combinação de relatório + período + opções, e entrega
-- do cache enquanto ela estiver fresca. Assim, 30 pessoas abrindo "Last 7 days"
-- às 8h geram uma chamada ao Commslayer, não trinta.
--
-- Ninguém acessa esta tabela pela API pública: RLS ligado e nenhuma policy.
-- Só a própria função, com a chave de serviço, lê e escreve.

create table if not exists public.report_cache (
  key        text primary key,
  report     text        not null,
  payload    jsonb       not null,
  fetched_at timestamptz not null default now()
);

alter table public.report_cache enable row level security;

revoke all on table public.report_cache from anon, authenticated;

-- Limpeza: entradas de períodos antigos que ninguém mais pede.
create index if not exists report_cache_fetched_at_idx on public.report_cache (fetched_at);
