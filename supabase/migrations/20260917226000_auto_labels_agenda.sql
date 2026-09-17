-- Conferência dos auto-labels a cada 10 minutos (pg_cron + pg_net).
-- A chave da função fica no Vault (secret "cl_events_key"), gravada fora do
-- repositório; aqui só se lê pelo nome.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'cl-reconcile';

select cron.schedule('cl-reconcile', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://gpjawqxnururaoqwkdnp.supabase.co/functions/v1/commslayer-events?action=reconcile&k='
           || (select decrypted_secret from vault.decrypted_secrets where name = 'cl_events_key'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
