-- Histórico do que o bot fez, para o "desfazer" voltar a ÚLTIMA ação (um registro, uma correção,
-- o vencimento de uma fatura, os dias do cartão), e não só o último lançamento criado.
-- `passos` diz como voltar ao estado anterior; nada é apagado de verdade.
create table public.acoes (
  id           uuid primary key default gen_random_uuid(),
  usuario_id   uuid not null references public.usuarios(id) on delete cascade,
  mensagem_id  uuid references public.mensagens(id) on delete set null,
  resumo       text not null check (length(resumo) between 1 and 300),
  passos       jsonb not null,
  desfeita_em  timestamptz,
  criado_em    timestamptz not null default now()
);

create index acoes_ultima on public.acoes (usuario_id, criado_em desc) where desfeita_em is null;

alter table public.acoes enable row level security;
revoke all on public.acoes from anon, authenticated;
