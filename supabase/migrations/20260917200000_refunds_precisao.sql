-- Valores de reembolso com a precisão da planilha.
--
-- numeric(12,2) arredondava cada linha para centavos antes de somar; a planilha
-- soma os valores crus. Resultado: 27.750,94 no portal contra 27.750,75 no SUM()
-- da planilha. Guardando o valor exato, as duas somas batem e o arredondamento
-- fica só na exibição.
alter table public.sheet_refunds
  alter column total_amount    type numeric(16,6),
  alter column refunded_amount type numeric(16,6);

-- Reprocessa a aba inteira na próxima sincronização (valores e correção de datas).
truncate public.sheet_refunds;
update public.sheet_sync_runs set content_hash = null where tab = 'refunds';
