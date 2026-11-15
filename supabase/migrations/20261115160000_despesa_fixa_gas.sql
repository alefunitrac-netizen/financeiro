-- Gás (botijão ou encanado) como tipo de despesa fixa.
alter table public.despesas_fixas drop constraint despesas_fixas_tipo_check;
alter table public.despesas_fixas add constraint despesas_fixas_tipo_check
  check (tipo in ('luz', 'agua', 'gas', 'internet', 'telefone', 'assinatura', 'moradia', 'outro'));
