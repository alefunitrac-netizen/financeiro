-- =====================================================================
-- Canal Telegram: o usuário pode ter WhatsApp, Telegram ou os dois.
-- =====================================================================

-- Usuário pode não ter WhatsApp (só Telegram).
alter table public.usuarios alter column whatsapp drop not null;

-- Id numérico do Telegram de quem pode usar o bot.
alter table public.usuarios add column telegram_id bigint unique;

-- Código de uso único para ligar o Telegram (link t.me/<bot>?start=<codigo>). Some depois de usado.
alter table public.usuarios add column codigo_vinculo text unique
  check (codigo_vinculo ~ '^[A-Za-z0-9_-]{16,64}$');

alter table public.usuarios add constraint usuarios_tem_canal
  check (whatsapp is not null or telegram_id is not null or codigo_vinculo is not null);

-- Mensagens passam a ser de qualquer canal: o id externo só é único dentro do canal.
alter table public.mensagens rename column wamid to id_externo;
alter table public.mensagens add column canal text not null default 'whatsapp'
  check (canal in ('whatsapp', 'telegram'));
alter table public.mensagens alter column canal drop default;
alter table public.mensagens drop constraint mensagens_wamid_key;
alter table public.mensagens add constraint mensagens_canal_id_externo_key unique (canal, id_externo);
