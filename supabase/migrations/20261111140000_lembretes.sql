-- Lembretes que o bot manda sozinho: fatura perto de vencer, resumo da semana, saldo negativo.

-- "parar lembretes" / "ligar lembretes"
alter table public.usuarios add column lembretes boolean not null default true;

-- Cada aviso tem uma chave ("fatura:<conta>:<vencimento>:dia", "semana:2026-11-09") e só sai uma vez,
-- mesmo que a rodada agendada rode duas vezes.
create table public.avisos_enviados (
  usuario_id  uuid not null references public.usuarios(id) on delete cascade,
  chave       text not null check (length(chave) between 1 and 200),
  enviado_em  timestamptz not null default now(),
  primary key (usuario_id, chave)
);

alter table public.avisos_enviados enable row level security;
revoke all on public.avisos_enviados from anon, authenticated;

-- Todo dia às 8h07 (Brasília) = 11h07 UTC.
select cron.schedule(
  'lembretes',
  '7 11 * * *',
  $$ select net.http_get('https://henuvivpnmisntwvgjbu.supabase.co/functions/v1/telegram-webhook?acao=lembretes', timeout_milliseconds := 120000) $$
);
