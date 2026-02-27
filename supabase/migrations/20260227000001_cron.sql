create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'refresh-covers',
  '0 6 * * *',
  $$
  select net.http_post(
    url     := 'https://pnllxhnhuaqcprqihfzi.supabase.co/functions/v1/refresh',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
