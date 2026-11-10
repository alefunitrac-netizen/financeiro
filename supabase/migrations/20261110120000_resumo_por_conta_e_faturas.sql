-- Resumo separado por conta e faturas de cartão a pagar.
--
-- Fatura informada por você ("fatura nubank 1547") vira transação tipo 'pagamento_fatura',
-- status 'informado', na conta do cartão, com data_pagamento = vencimento. Ela NÃO entra em
-- despesas: as compras dentro dela já são (ou serão, quando o banco conectar) as despesas.

-- Total de despesas e receitas do período, por conta.
create function public.resumo_por_conta(p_usuario uuid, p_inicio date, p_fim date)
returns table (conta_id uuid, conta text, tipo_conta text, tipo text, total_centavos bigint, quantidade bigint)
language sql
stable
set search_path = ''
as $$
  select t.conta_id,
         c.nome,
         c.tipo::text,
         t.tipo::text,
         sum(t.valor_centavos)::bigint,
         count(*)::bigint
  from public.transacoes t
  left join public.contas c on c.id = t.conta_id
  where t.usuario_id = p_usuario
    and t.status <> 'cancelado'
    and t.tipo in ('despesa', 'receita')
    and t.data_transacao between p_inicio and p_fim
  group by 1, 2, 3, 4
  order by 4, 5 desc;
$$;

-- Resumo por categoria de uma conta só ("quanto gastei no nubank?").
create function public.resumo_por_categoria_conta(p_usuario uuid, p_inicio date, p_fim date, p_conta uuid)
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
    and t.conta_id = p_conta
    and t.status <> 'cancelado'
    and t.tipo in ('despesa', 'receita')
    and t.data_transacao between p_inicio and p_fim
  group by 1, 2
  order by 1, 3 desc;
$$;

-- Faturas de cartão em aberto:
--  * informadas por você (pagamento_fatura ainda 'informado');
--  * calculadas: soma das compras (menos estornos) de cada vencimento futuro do cartão.
-- O código escolhe o que mostrar (a informada tem prioridade sobre a calculada).
create function public.faturas_abertas(p_usuario uuid, p_hoje date)
returns table (conta_id uuid, conta text, vencimento date, total_centavos bigint, informada boolean)
language sql
stable
set search_path = ''
as $$
  select t.conta_id, c.nome, t.data_pagamento, sum(t.valor_centavos)::bigint, true
  from public.transacoes t
  join public.contas c on c.id = t.conta_id
  where t.usuario_id = p_usuario
    and t.tipo = 'pagamento_fatura'
    and t.status = 'informado'
    and t.origem <> 'banco'
    and (t.data_pagamento is null or t.data_pagamento >= p_hoje - 5)
  group by 1, 2, 3
  union all
  select t.conta_id, c.nome, t.data_pagamento,
         sum(case when t.tipo = 'despesa' then t.valor_centavos else -t.valor_centavos end)::bigint, false
  from public.transacoes t
  join public.contas c on c.id = t.conta_id and c.tipo = 'cartao_credito'
  where t.usuario_id = p_usuario
    and t.status <> 'cancelado'
    and t.tipo in ('despesa', 'receita')
    and t.data_pagamento between p_hoje and p_hoje + 62
  group by 1, 2, 3;
$$;

revoke execute on function public.resumo_por_conta(uuid, date, date) from public, anon, authenticated;
grant execute on function public.resumo_por_conta(uuid, date, date) to service_role;
revoke execute on function public.resumo_por_categoria_conta(uuid, date, date, uuid) from public, anon, authenticated;
grant execute on function public.resumo_por_categoria_conta(uuid, date, date, uuid) to service_role;
revoke execute on function public.faturas_abertas(uuid, date) from public, anon, authenticated;
grant execute on function public.faturas_abertas(uuid, date) to service_role;
