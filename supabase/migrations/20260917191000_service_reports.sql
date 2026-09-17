-- As funções do servidor também podem chamar os relatórios (ex.: diagnósticos).
grant execute on function public.report_refunds(date, date), public.report_subscriptions(date, date),
  public.report_reshipments(date, date), public.report_supplier_issues(date, date),
  public.order_lookup(text), public.data_check() to service_role;
grant select on public.v_reshipment_cases, public.v_supplier_issue_cases, public.v_subscription_cases to service_role;
