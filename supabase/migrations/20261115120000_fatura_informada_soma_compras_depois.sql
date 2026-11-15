-- Fatura informada ("fatura nubank 1547") + o que você comprou no cartão DEPOIS de informar, no
-- mesmo vencimento. Antes o valor informado ficava parado e escondia as compras novas.
-- Só conta o que foi registrado depois da fatura (criado_em), para não somar duas vezes o que já
-- estava no valor que você viu no app do banco.
create or replace function public.faturas_abertas(p_usuario uuid, p_hoje date)
returns table (conta_id uuid, conta text, vencimento date, total_centavos bigint, informada boolean)
language sql
stable
set search_path = ''
as $$
  with informadas as (
    select t.conta_id, c.nome, t.data_pagamento, sum(t.valor_centavos)::bigint as total, max(t.criado_em) as desde
    from public.transacoes t
    join public.contas c on c.id = t.conta_id
    where t.usuario_id = p_usuario
      and t.tipo = 'pagamento_fatura'
      and t.status = 'informado'
      and t.origem <> 'banco'
      and (t.data_pagamento is null or t.data_pagamento >= p_hoje - 5)
    group by 1, 2, 3
  )
  select i.conta_id, i.nome, i.data_pagamento,
         (i.total + coalesce((
           select sum(case when x.tipo = 'despesa' then x.valor_centavos else -x.valor_centavos end)
           from public.transacoes x
           where x.usuario_id = p_usuario
             and x.conta_id = i.conta_id
             and x.data_pagamento = i.data_pagamento
             and x.status <> 'cancelado'
             and x.tipo in ('despesa', 'receita')
             and x.criado_em > i.desde
         ), 0))::bigint,
         true
  from informadas i
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
