-- =====================================================================
-- Open Finance (Pluggy / Meu Pluggy, uso pessoal)
-- =====================================================================

-- Cada banco conectado no Meu Pluggy vira um "item" na Pluggy. A API não lista os itens do
-- Meu Pluggy, então guardamos aqui o itemId copiado do painel.
create table public.conexoes_banco (
  id                       uuid primary key default gen_random_uuid(),
  usuario_id               uuid not null references public.usuarios(id) on delete cascade,
  provedor                 text not null default 'pluggy' check (provedor in ('pluggy')),
  item_id                  text not null unique,
  instituicao              text,
  status                   text,
  consentimento_expira_em  timestamptz,
  ultima_sincronizacao     timestamptz,
  ultimo_erro              text,
  ativa                    boolean not null default true,
  criado_em                timestamptz not null default now()
);
create index conexoes_banco_usuario_idx on public.conexoes_banco (usuario_id);

-- Saldo das contas vindas do banco (para o comando de saldo e alertas).
alter table public.contas add column saldo_centavos bigint;
alter table public.contas add column saldo_atualizado_em timestamptz;

-- A mesma conta do banco nunca entra duas vezes. Unique "de verdade" (não parcial)
-- para o upsert com ON CONFLICT funcionar; NULLs continuam permitidos.
alter table public.contas add constraint contas_usuario_external_id_key unique (usuario_id, external_id);

drop index public.transacoes_external_id_uq;
alter table public.transacoes add constraint transacoes_usuario_external_id_key unique (usuario_id, external_id);

-- Quando o banco confirma um lançamento seu, guardamos a descrição que veio do banco,
-- sem perder a sua.
alter table public.transacoes add column descricao_banco text;

alter table public.conexoes_banco enable row level security;
revoke all on public.conexoes_banco from anon, authenticated;
