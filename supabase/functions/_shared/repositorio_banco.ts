// Acesso ao Postgres para a sincronização com o Open Finance.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import type { ContaSalva, RepositorioBanco, TransacaoSalva } from "./open_finance.ts";
import type { Categoria } from "./tipos.ts";

// deno-lint-ignore no-explicit-any
type Linha = Record<string, any>;

function falhar(operacao: string, erro: { message: string }): never {
  throw new Error(`${operacao}: ${erro.message}`);
}

const COLUNAS_CONTA = "id, nome, tipo, dia_fechamento, dia_vencimento";
const deLinhaConta = (l: Linha): ContaSalva => ({
  id: l.id,
  nome: l.nome,
  tipo: l.tipo,
  diaFechamento: l.dia_fechamento,
  diaVencimento: l.dia_vencimento,
});

/** Divide listas grandes: o filtro "in" vai na URL e URL tem limite. */
function lotes<T>(lista: T[], tamanho = 100): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < lista.length; i += tamanho) saida.push(lista.slice(i, i + tamanho));
  return saida;
}

export function criarRepositorioBanco(db: SupabaseClient): RepositorioBanco {
  return {
    async listarConexoes(usuarioId) {
      let q = db
        .from("conexoes_banco")
        .select("id, usuario_id, item_id, instituicao, ultima_sincronizacao, usuarios(telegram_id)")
        .eq("ativa", true);
      if (usuarioId) q = q.eq("usuario_id", usuarioId);
      const { data, error } = await q;
      if (error) falhar("listarConexoes", error);
      return (data ?? []).map((l: Linha) => ({
        id: l.id,
        usuarioId: l.usuario_id,
        itemId: l.item_id,
        instituicao: l.instituicao,
        telegramId: l.usuarios?.telegram_id != null ? String(l.usuarios.telegram_id) : null,
        ultimaSincronizacao: l.ultima_sincronizacao,
      }));
    },

    async salvarConta(usuarioId, d) {
      // Os dados que só o banco sabe são sempre atualizados; nome e apelidos, só na criação
      // (você pode renomear a conta e o banco não desfaz).
      const doBanco = {
        instituicao: d.instituicao,
        dia_fechamento: d.diaFechamento,
        dia_vencimento: d.diaVencimento,
        limite_centavos: d.limiteCentavos,
        saldo_centavos: d.saldoCentavos,
        saldo_atualizado_em: new Date().toISOString(),
      };
      const { data: existente, error: e1 } = await db
        .from("contas")
        .select("id")
        .eq("usuario_id", usuarioId)
        .eq("external_id", d.externalId)
        .maybeSingle();
      if (e1) falhar("salvarConta.buscar", e1);
      if (existente) {
        const { data, error } = await db.from("contas").update(doBanco).eq("id", existente.id).select(COLUNAS_CONTA).single();
        if (error) falhar("salvarConta.atualizar", error);
        return deLinhaConta(data);
      }
      // Uma conta criada à mão com o mesmo nome é adotada, em vez de duplicada.
      const { data: mesmoNome } = await db
        .from("contas")
        .select("id")
        .eq("usuario_id", usuarioId)
        .eq("nome", d.nome)
        .is("external_id", null)
        .maybeSingle();
      if (mesmoNome) {
        const { data, error } = await db
          .from("contas")
          .update({ ...doBanco, external_id: d.externalId, tipo: d.tipo })
          .eq("id", mesmoNome.id)
          .select(COLUNAS_CONTA)
          .single();
        if (error) falhar("salvarConta.adotar", error);
        return deLinhaConta(data);
      }
      const { data, error } = await db
        .from("contas")
        .insert({ ...doBanco, usuario_id: usuarioId, external_id: d.externalId, nome: d.nome, tipo: d.tipo, apelidos: d.apelidos })
        .select(COLUNAS_CONTA)
        .single();
      if (error) falhar("salvarConta.inserir", error);
      return deLinhaConta(data);
    },

    async listarCategorias(usuarioId) {
      const { data, error } = await db.from("categorias").select("id, nome, tipo").eq("usuario_id", usuarioId).eq("ativa", true);
      if (error) falhar("listarCategorias", error);
      return (data ?? []) as Categoria[];
    },

    async buscarPorExternos(usuarioId, externos) {
      const saida: TransacaoSalva[] = [];
      for (const lote of lotes(externos)) {
        const { data, error } = await db
          .from("transacoes")
          .select("id, external_id, valor_centavos, data_transacao")
          .eq("usuario_id", usuarioId)
          .in("external_id", lote);
        if (error) falhar("buscarPorExternos", error);
        for (const l of data ?? []) {
          saida.push({
            id: l.id,
            externalId: l.external_id,
            valorCentavos: Number(l.valor_centavos),
            dataTransacao: l.data_transacao,
          });
        }
      }
      return saida;
    },

    async informadosParaConciliar(usuarioId, inicio, fim) {
      const { data, error } = await db
        .from("transacoes")
        .select("id, conta_id, tipo, valor_centavos, data_transacao")
        .eq("usuario_id", usuarioId)
        .eq("status", "informado")
        .is("external_id", null)
        .neq("origem", "banco")
        .in("tipo", ["despesa", "receita"])
        .gte("data_transacao", inicio)
        .lte("data_transacao", fim);
      if (error) falhar("informadosParaConciliar", error);
      return (data ?? []).map((l: Linha) => ({
        id: l.id,
        contaId: l.conta_id,
        tipo: l.tipo,
        valorCentavos: Number(l.valor_centavos),
        dataTransacao: l.data_transacao,
      }));
    },

    async confirmar(id, b) {
      // Valor e data do banco; descrição e categoria continuam as suas.
      const { error } = await db
        .from("transacoes")
        .update({
          external_id: b.externalId,
          status: "confirmado",
          confirmado_em: new Date().toISOString(),
          conta_id: b.contaId,
          valor_centavos: b.valorCentavos,
          data_transacao: b.dataTransacao,
          data_pagamento: b.dataPagamento,
          descricao_banco: b.descricao,
        })
        .eq("id", id);
      if (error) falhar("confirmar", error);
    },

    async atualizarDoBanco(id, b) {
      const { error } = await db
        .from("transacoes")
        .update({
          valor_centavos: b.valorCentavos,
          data_transacao: b.dataTransacao,
          data_pagamento: b.dataPagamento,
          descricao_banco: b.descricao,
          status: "confirmado",
        })
        .eq("id", id);
      if (error) falhar("atualizarDoBanco", error);
    },

    async inserirDoBanco(usuarioId, novas) {
      const linhas = novas.map((n) => ({
        usuario_id: usuarioId,
        conta_id: n.contaId,
        categoria_id: n.categoriaId,
        tipo: n.tipo,
        status: "confirmado",
        origem: "banco",
        descricao: n.descricao,
        descricao_banco: n.descricao,
        valor_centavos: n.valorCentavos,
        data_transacao: n.dataTransacao,
        data_pagamento: n.dataPagamento,
        external_id: n.externalId,
        confirmado_em: new Date().toISOString(),
      }));
      for (const lote of lotes(linhas, 200)) {
        // Duas sincronizações ao mesmo tempo não duplicam: o external_id é único por usuário.
        const { error } = await db.from("transacoes").upsert(lote, {
          onConflict: "usuario_id,external_id",
          ignoreDuplicates: true,
        });
        if (error) falhar("inserirDoBanco", error);
      }
    },

    async tratarAusentes(usuarioId, contaId, inicio, fim, presentes) {
      const { data, error } = await db
        .from("transacoes")
        .select("id, origem, external_id")
        .eq("usuario_id", usuarioId)
        .eq("conta_id", contaId)
        .like("external_id", "pluggy:%")
        .neq("status", "cancelado")
        .gte("data_transacao", inicio)
        .lte("data_transacao", fim);
      if (error) falhar("tratarAusentes.buscar", error);
      const sumiram = (data ?? []).filter((l: Linha) => !presentes.has(l.external_id));
      const doBanco = sumiram.filter((l: Linha) => l.origem === "banco").map((l: Linha) => l.id);
      const seus = sumiram.filter((l: Linha) => l.origem !== "banco").map((l: Linha) => l.id);
      for (const lote of lotes(doBanco)) {
        const { error: e } = await db.from("transacoes").update({ status: "cancelado" }).in("id", lote);
        if (e) falhar("tratarAusentes.cancelar", e);
      }
      for (const lote of lotes(seus)) {
        const { error: e } = await db
          .from("transacoes")
          .update({ status: "informado", external_id: null, confirmado_em: null })
          .in("id", lote);
        if (e) falhar("tratarAusentes.desvincular", e);
      }
      return doBanco.length;
    },

    async registrarSincronizacao(conexaoId, d) {
      const campos: Linha = { ultima_sincronizacao: new Date().toISOString(), ultimo_erro: d.erro };
      if (d.instituicao) campos.instituicao = d.instituicao;
      if (d.status) campos.status = d.status;
      if (d.consentimentoExpiraEm) campos.consentimento_expira_em = d.consentimentoExpiraEm;
      const { error } = await db.from("conexoes_banco").update(campos).eq("id", conexaoId);
      if (error) falhar("registrarSincronizacao", error);
    },
  };
}
