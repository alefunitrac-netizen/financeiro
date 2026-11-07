-- =====================================================================
-- Controle financeiro pessoal — esquema inicial (Fase 1)
--
-- Regras de ouro deste esquema:
--   * Dinheiro é sempre bigint em CENTAVOS. Nunca float/numeric solto.
--   * Valor é sempre positivo; o sentido vem do `tipo` da transação.
--   * Nada é apagado: lançamento errado vira status 'cancelado' (trilha de auditoria).
--   * Toda transação guarda DUAS datas: a da compra (competência) e a do
--     pagamento (caixa — no cartão, o vencimento da fatura).
--   * `status` + `external_id` já preparam a conciliação com o Open Finance (Fase 2).
-- =====================================================================

-- ---------- Tipos ----------
create type public.tipo_conta as enum (
  'corrente', 'poupanca', 'cartao_credito', 'dinheiro', 'vale', 'investimento', 'outro'
);

create type public.tipo_transacao as enum (
  'despesa', 'receita', 'transferencia', 'pagamento_fatura'
);

-- informado  = veio de você (WhatsApp/manual), ainda não visto no banco
-- confirmado = conferido com o extrato do banco (Fase 2)
-- cancelado  = desfeito; não entra em nenhum relatório
create type public.status_transacao as enum ('informado', 'confirmado', 'cancelado');

create type public.origem_transacao as enum ('whatsapp', 'banco', 'manual', 'importacao');

-- ---------- Usuários ----------
create table public.usuarios (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null check (length(nome) between 1 and 100),
  -- Número no formato E.164 só com dígitos, ex.: 5511987654321
  whatsapp      text not null unique check (whatsapp ~ '^[1-9][0-9]{9,14}$'),
  fuso_horario  text not null default 'America/Sao_Paulo',
  criado_em     timestamptz not null default now()
);

-- ---------- Contas e cartões ----------
create table public.contas (
  id               uuid primary key default gen_random_uuid(),
  usuario_id       uuid not null references public.usuarios(id) on delete cascade,
  nome             text not null check (length(nome) between 1 and 60),
  tipo             public.tipo_conta not null,
  instituicao      text,
  -- Como você chama a conta no dia a dia: {'nubank','roxinho','nu'}
  apelidos         text[] not null default '{}',
  dia_fechamento   smallint check (dia_fechamento between 1 and 31),
  dia_vencimento   smallint check (dia_vencimento between 1 and 31),
  limite_centavos  bigint check (limite_centavos >= 0),
  ativa            boolean not null default true,
  external_id      text,  -- id da conta no agregador Open Finance (Fase 2)
  criado_em        timestamptz not null default now(),
  unique (usuario_id, nome),
  -- Cartão de crédito precisa de fechamento e vencimento juntos (ou nenhum dos dois)
  check ((dia_fechamento is null) = (dia_vencimento is null))
);

-- ---------- Categorias ----------
create table public.categorias (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid not null references public.usuarios(id) on delete cascade,
  nome        text not null check (length(nome) between 1 and 60),
  tipo        text not null default 'despesa' check (tipo in ('despesa', 'receita')),
  ativa       boolean not null default true,
  criado_em   timestamptz not null default now(),
  unique (usuario_id, nome)
);

-- ---------- Mensagens recebidas (auditoria + idempotência) ----------
create table public.mensagens (
  id             uuid primary key default gen_random_uuid(),
  usuario_id     uuid not null references public.usuarios(id) on delete cascade,
  -- id da mensagem no WhatsApp. UNIQUE garante que um reenvio da Meta não duplica lançamento.
  wamid          text not null unique,
  tipo           text not null,
  texto          text,
  interpretacao  jsonb,
  resposta       text,
  status         text not null default 'recebida'
                 check (status in ('recebida', 'processada', 'ignorada', 'erro')),
  erro           text,
  recebida_em    timestamptz not null default now(),
  processada_em  timestamptz
);

-- ---------- Transações ----------
create table public.transacoes (
  id                  uuid primary key default gen_random_uuid(),
  usuario_id          uuid not null references public.usuarios(id) on delete cascade,
  conta_id            uuid references public.contas(id) on delete set null,
  categoria_id        uuid references public.categorias(id) on delete set null,
  mensagem_id         uuid references public.mensagens(id) on delete set null,
  tipo                public.tipo_transacao not null,
  status              public.status_transacao not null default 'informado',
  origem              public.origem_transacao not null,
  descricao           text not null check (length(descricao) between 1 and 200),
  estabelecimento     text,
  valor_centavos      bigint not null check (valor_centavos > 0),
  data_transacao      date not null,  -- competência: quando a compra aconteceu
  data_pagamento      date,           -- caixa: quando o dinheiro sai (vencimento da fatura no cartão)
  parcela_numero      smallint,
  parcela_total       smallint,
  grupo_parcelamento  uuid,
  external_id         text,           -- id da transação no banco, preenchido na conciliação
  confirmado_em       timestamptz,
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  check (
    (parcela_total is null and parcela_numero is null and grupo_parcelamento is null)
    or (parcela_total between 2 and 99
        and parcela_numero between 1 and parcela_total
        and grupo_parcelamento is not null)
  )
);

create unique index transacoes_external_id_uq
  on public.transacoes (usuario_id, external_id) where external_id is not null;
create index transacoes_usuario_data_idx
  on public.transacoes (usuario_id, data_transacao) where status <> 'cancelado';
create index transacoes_mensagem_idx   on public.transacoes (mensagem_id);
create index transacoes_conta_idx      on public.transacoes (conta_id);
create index transacoes_categoria_idx  on public.transacoes (categoria_id);
create index transacoes_grupo_idx      on public.transacoes (grupo_parcelamento) where grupo_parcelamento is not null;
create index contas_usuario_idx        on public.contas (usuario_id);
create index categorias_usuario_idx    on public.categorias (usuario_id);
create index mensagens_usuario_idx     on public.mensagens (usuario_id, recebida_em desc);

-- ---------- atualizado_em automático ----------
create function public.tocar_atualizado_em()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

create trigger transacoes_atualizado_em
  before update on public.transacoes
  for each row execute function public.tocar_atualizado_em();

-- ---------- Categorias e conta padrão para todo usuário novo ----------
create function public.preparar_novo_usuario()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.categorias (usuario_id, nome, tipo)
  select new.id, c.nome, c.tipo
  from (values
    ('Alimentação', 'despesa'), ('Mercado', 'despesa'), ('Transporte', 'despesa'),
    ('Moradia', 'despesa'), ('Contas da casa', 'despesa'), ('Saúde', 'despesa'),
    ('Educação', 'despesa'), ('Lazer', 'despesa'), ('Compras', 'despesa'),
    ('Assinaturas', 'despesa'), ('Pets', 'despesa'), ('Viagem', 'despesa'),
    ('Impostos e taxas', 'despesa'), ('Presentes e doações', 'despesa'), ('Outros', 'despesa'),
    ('Salário', 'receita'), ('Renda extra', 'receita'), ('Reembolso', 'receita'),
    ('Rendimentos', 'receita'), ('Outras receitas', 'receita')
  ) as c(nome, tipo);

  insert into public.contas (usuario_id, nome, tipo, apelidos)
  values (new.id, 'Dinheiro', 'dinheiro', array['dinheiro', 'especie', 'cash']);

  return new;
end;
$$;

create trigger usuarios_preparar
  after insert on public.usuarios
  for each row execute function public.preparar_novo_usuario();

-- ---------- Resumo por categoria (usado pelo bot) ----------
create function public.resumo_por_categoria(p_usuario uuid, p_inicio date, p_fim date)
returns table (tipo text, categoria text, total_centavos bigint, quantidade bigint)
language sql
stable
set search_path = ''
as $$
  select t.tipo::text,
         coalesce(c.nome, 'Sem categoria'),
         sum(t.valor_centavos)::bigint,
         count(*)::bigint
  from public.transacoes t
  left join public.categorias c on c.id = t.categoria_id
  where t.usuario_id = p_usuario
    and t.status <> 'cancelado'
    and t.tipo in ('despesa', 'receita')
    and t.data_transacao between p_inicio and p_fim
  group by 1, 2
  order by 1, 3 desc;
$$;

-- ---------- Segurança ----------
-- Na Fase 1 só o backend (chave secreta, que ignora RLS) acessa os dados.
-- RLS ligado e nenhum acesso para anon/authenticated: nada vaza pela API pública.
alter table public.usuarios   enable row level security;
alter table public.contas     enable row level security;
alter table public.categorias enable row level security;
alter table public.mensagens  enable row level security;
alter table public.transacoes enable row level security;

revoke all on public.usuarios, public.contas, public.categorias, public.mensagens, public.transacoes
  from anon, authenticated;

revoke execute on function public.resumo_por_categoria(uuid, date, date) from public, anon, authenticated;
grant execute on function public.resumo_por_categoria(uuid, date, date) to service_role;
revoke execute on function public.preparar_novo_usuario() from public, anon, authenticated;
revoke execute on function public.tocar_atualizado_em() from public, anon, authenticated;
