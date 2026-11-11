-- Simulação de compra ("vou comprar um ar de 500 em 3x, quanto compromete?") e previsão de saldo.

-- "minha renda é 4500": vale mais que a média do que entrou.
alter table public.usuarios add column renda_mensal_centavos bigint check (renda_mensal_centavos > 0);

-- Por mês: o que entrou, o que saiu fora de parcelas (o gasto do dia a dia) e as parcelas.
-- Parcela conta no mês em que é paga (vencimento da fatura); o resto, no mês da compra.
-- Parcela = parcelada aqui (parcela_total >= 2) ou vinda do banco com "(2/10)" na descrição.
create function public.fluxo_mensal(p_usuario uuid, p_inicio date, p_fim date)
returns table (mes date, receitas bigint, gastos_avulsos bigint, parcelas bigint)
language sql
stable
set search_path = ''
as $$
  with t as (
    select tipo,
           valor_centavos,
           (coalesce(parcela_total, 0) >= 2 or descricao ~ '\(\d+/\d+\)') as parcela,
           data_transacao,
           data_pagamento
    from public.transacoes
    where usuario_id = p_usuario
      and status <> 'cancelado'
      and tipo in ('despesa', 'receita')
  ), d as (
    select tipo, valor_centavos, parcela,
           case when parcela then coalesce(data_pagamento, data_transacao) else data_transacao end as data
    from t
  )
  select date_trunc('month', data)::date,
         coalesce(sum(valor_centavos) filter (where tipo = 'receita'), 0)::bigint,
         coalesce(sum(valor_centavos) filter (where tipo = 'despesa' and not parcela), 0)::bigint,
         coalesce(sum(valor_centavos) filter (where tipo = 'despesa' and parcela), 0)::bigint
  from d
  where data between p_inicio and p_fim
  group by 1
  order by 1;
$$;

revoke execute on function public.fluxo_mensal(uuid, date, date) from public, anon, authenticated;
grant execute on function public.fluxo_mensal(uuid, date, date) to service_role;
