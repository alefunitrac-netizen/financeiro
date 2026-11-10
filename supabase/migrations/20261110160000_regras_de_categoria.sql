-- Regras de categoria que você ensina ao bot: "roberto é moradia" faz todo lançamento cuja
-- descrição tenha "roberto" (Pix enviado Roberto Augusto...) cair em Moradia, os de agora e os que vierem.
create table public.regras_categoria (
  id            uuid primary key default gen_random_uuid(),
  usuario_id    uuid not null references public.usuarios(id) on delete cascade,
  termo         text not null check (length(termo) between 3 and 80),  -- minúsculo e sem acento
  categoria_id  uuid not null references public.categorias(id) on delete cascade,
  ativa         boolean not null default true,
  criado_em     timestamptz not null default now()
);

create index regras_categoria_usuario on public.regras_categoria (usuario_id) where ativa;

alter table public.regras_categoria enable row level security;
revoke all on public.regras_categoria from anon, authenticated;
