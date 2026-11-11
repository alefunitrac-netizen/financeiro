-- Memória curta da conversa: a pergunta que o bot acabou de fazer ("Quanto foi?", "Qual o novo
-- vencimento?", "Isso é de qual categoria?"), para entender a resposta solta ("35", "dia 10", "moradia").
-- Uma por usuário; vence sozinha.
create table public.pendencias (
  usuario_id  uuid primary key references public.usuarios(id) on delete cascade,
  tipo        text not null,
  dados       jsonb not null,
  expira_em   timestamptz not null,
  criado_em   timestamptz not null default now()
);

alter table public.pendencias enable row level security;
revoke all on public.pendencias from anon, authenticated;
