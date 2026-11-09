create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Lê os bancos às 10h13 e 20h13 (Brasília) = 13h13 e 23h13 UTC.
select cron.schedule(
  'sincronizar-banco',
  '13 13,23 * * *',
  $$ select net.http_get('https://henuvivpnmisntwvgjbu.supabase.co/functions/v1/telegram-webhook?acao=sincronizar', timeout_milliseconds := 120000) $$
);
