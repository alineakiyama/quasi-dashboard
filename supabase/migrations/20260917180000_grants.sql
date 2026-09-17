-- Permissões explícitas.
--
-- O projeto foi criado com "Automatically expose new tables" desligado, que é o
-- certo para segurança: tabela nova nasce sem acesso para ninguém. O efeito
-- colateral é que nem a chave de serviço (usada só dentro das funções) consegue
-- ler ou gravar sem um GRANT. Sem isto, o cache dos relatórios e a sincronização
-- da planilha falham com "permission denied".

grant usage on schema public to service_role, authenticated;

-- Funções do servidor: leem e gravam tudo.
grant select, insert, update, delete on
  public.report_cache,
  public.sheet_refunds, public.sheet_subscriptions, public.sheet_reshipments, public.sheet_supplier_issues,
  public.sheet_sync_runs, public.sheet_sync_staging
to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on function public.sheet_sync_commit(bigint, text) to service_role;

-- Time logado: só leitura, e só do que os relatórios usam.
grant select on public.v_reshipment_cases, public.v_supplier_issue_cases, public.v_subscription_cases to authenticated;
grant execute on function public._contagem(jsonb) to authenticated, service_role;
