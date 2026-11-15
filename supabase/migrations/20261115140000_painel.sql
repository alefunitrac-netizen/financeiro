-- Painel web: salário e descontos, despesas fixas, meta de investimento (aportes) e acesso pelo link
-- que o bot manda ("painel"). Só o backend lê estas tabelas (RLS ligada, sem políticas).

create table public.renda_config (
  usuario_id       uuid primary key references public.usuarios(id) on delete cascade,
  regime           text not null default 'clt' check (regime in ('clt', 'manual')),
  bruto_centavos   bigint not null default 0 check (bruto_centavos >= 0),
  dependentes      smallint not null default 0 check (dependentes between 0 and 20),
  -- [{"nome": "Vale-transporte", "valorCentavos": 36000}, ...]
  descontos        jsonb not null default '[]'::jsonb,
  inss_manual      bigint check (inss_manual >= 0),
  irrf_manual      bigint check (irrf_manual >= 0),
  meta_percentual  numeric(5, 2) not null default 10 check (meta_percentual between 0 and 100),
  atualizado_em    timestamptz not null default now()
);

create table public.despesas_fixas (
  id              uuid primary key default gen_random_uuid(),
  usuario_id      uuid not null references public.usuarios(id) on delete cascade,
  nome            text not null check (length(nome) between 1 and 60),
  tipo            text not null default 'outro'
                  check (tipo in ('luz', 'agua', 'internet', 'telefone', 'assinatura', 'moradia', 'outro')),
  valor_centavos  bigint not null check (valor_centavos > 0),
  dia_vencimento  smallint check (dia_vencimento between 1 and 31),
  ativa           boolean not null default true,
  criado_em       timestamptz not null default now()
);
create index on public.despesas_fixas (usuario_id) where ativa;

-- Quanto você guardou/investiu (para acompanhar a meta).
create table public.aportes (
  id              uuid primary key default gen_random_uuid(),
  usuario_id      uuid not null references public.usuarios(id) on delete cascade,
  data            date not null,
  valor_centavos  bigint not null check (valor_centavos <> 0),
  descricao       text check (length(descricao) <= 80),
  criado_em       timestamptz not null default now()
);
create index on public.aportes (usuario_id, data);

-- "codigo": uso único, vem no link do bot e vale 15 minutos. "sessao": o que o navegador guarda
-- depois de entrar. Só o hash (SHA-256) fica no banco.
create table public.acessos_painel (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid not null references public.usuarios(id) on delete cascade,
  tipo        text not null check (tipo in ('codigo', 'sessao')),
  hash        text not null unique,
  expira_em   timestamptz not null,
  usado_em    timestamptz,
  revogado    boolean not null default false,
  criado_em   timestamptz not null default now()
);

alter table public.renda_config enable row level security;
alter table public.despesas_fixas enable row level security;
alter table public.aportes enable row level security;
alter table public.acessos_painel enable row level security;
revoke all on public.renda_config, public.despesas_fixas, public.aportes, public.acessos_painel from anon, authenticated;
