// Implementação do Repositorio sobre o Postgres do Supabase (supabase-js).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { chave, contemTermo } from "./texto.ts";
import type {
  CamposCorrecao,
  Categoria,
  Conta,
  NovaTransacao,
  LancamentoResumido,
  PassoDesfazer,
  Pendencia,
  Repositorio,
  Transacao,
  Usuario,
} from "./tipos.ts";

const COLUNAS_CONTA =
  "id, nome, tipo, apelidos, instituicao, dia_fechamento, dia_vencimento, saldo_centavos, limite_centavos, saldo_atualizado_em";

// deno-lint-ignore no-explicit-any
function deLinhaConta(c: Record<string, any>): Conta {
  return {
    id: c.id,
    nome: c.nome,
    tipo: c.tipo,
    apelidos: c.apelidos ?? [],
    instituicao: c.instituicao ?? null,
    diaFechamento: c.dia_fechamento,
    diaVencimento: c.dia_vencimento,
    saldoCentavos: c.saldo_centavos == null ? null : Number(c.saldo_centavos),
    limiteCentavos: c.limite_centavos == null ? null : Number(c.limite_centavos),
    saldoAtualizadoEm: c.saldo_atualizado_em ?? null,
  };
}

const COLUNAS_TRANSACAO =
  "id, usuario_id, origem, conta_id, categoria_id, mensagem_id, tipo, descricao, estabelecimento, valor_centavos, data_transacao, data_pagamento, parcela_numero, parcela_total, grupo_parcelamento";

// deno-lint-ignore no-explicit-any
type Linha = Record<string, any>;

function deLinha(l: Linha): Transacao {
  return {
    id: l.id,
    usuarioId: l.usuario_id,
    origem: l.origem,
    contaId: l.conta_id,
    categoriaId: l.categoria_id,
    mensagemId: l.mensagem_id,
    tipo: l.tipo,
    descricao: l.descricao,
    estabelecimento: l.estabelecimento,
    valorCentavos: Number(l.valor_centavos),
    dataTransacao: l.data_transacao,
    dataPagamento: l.data_pagamento,
    parcelaNumero: l.parcela_numero,
    parcelaTotal: l.parcela_total,
    grupoParcelamento: l.grupo_parcelamento,
  };
}

function paraLinha(t: NovaTransacao): Linha {
  return {
    usuario_id: t.usuarioId,
    conta_id: t.contaId,
    categoria_id: t.categoriaId,
    mensagem_id: t.mensagemId,
    tipo: t.tipo,
    origem: t.origem,
    status: t.status ?? "informado",
    descricao: t.descricao,
    estabelecimento: t.estabelecimento,
    valor_centavos: t.valorCentavos,
    data_transacao: t.dataTransacao,
    data_pagamento: t.dataPagamento,
    parcela_numero: t.parcelaNumero,
    parcela_total: t.parcelaTotal,
    grupo_parcelamento: t.grupoParcelamento,
  };
}

const MAPA_CORRECAO: Record<keyof CamposCorrecao, string> = {
  contaId: "conta_id",
  categoriaId: "categoria_id",
  descricao: "descricao",
  valorCentavos: "valor_centavos",
  dataTransacao: "data_transacao",
  dataPagamento: "data_pagamento",
};

function falhar(operacao: string, erro: { message: string }): never {
  throw new Error(`${operacao}: ${erro.message}`);
}

const COLUNAS_USUARIO = "id, nome, whatsapp, fuso_horario";

function deLinhaUsuario(l: Linha | null): Usuario | null {
  return l ? { id: l.id, nome: l.nome, whatsapp: l.whatsapp, fusoHorario: l.fuso_horario } : null;
}

export function criarRepositorioSupabase(db: SupabaseClient): Repositorio {
  return {
    async buscarUsuarioPorWhatsapp(numero) {
      const { data, error } = await db.from("usuarios").select(COLUNAS_USUARIO).eq("whatsapp", numero).maybeSingle();
      if (error) falhar("buscarUsuarioPorWhatsapp", error);
      return deLinhaUsuario(data);
    },

    async buscarUsuarioPorTelegram(telegramId) {
      const { data, error } = await db
        .from("usuarios")
        .select(COLUNAS_USUARIO)
        .eq("telegram_id", telegramId)
        .maybeSingle();
      if (error) falhar("buscarUsuarioPorTelegram", error);
      return deLinhaUsuario(data);
    },

    async vincularTelegram(codigo, telegramId) {
      // Um único UPDATE: o código só funciona uma vez e some ao ser usado.
      const { data, error } = await db
        .from("usuarios")
        .update({ telegram_id: telegramId, codigo_vinculo: null })
        .eq("codigo_vinculo", codigo)
        .select(COLUNAS_USUARIO)
        .maybeSingle();
      if (error) {
        if (error.code === "23505") return null; // esse Telegram já está ligado a outro usuário
        falhar("vincularTelegram", error);
      }
      return deLinhaUsuario(data);
    },

    async registrarMensagem(m) {
      const { data, error } = await db
        .from("mensagens")
        .insert({ usuario_id: m.usuarioId, canal: m.canal, id_externo: m.idExterno, tipo: m.tipo, texto: m.texto })
        .select("id")
        .single();
      if (error) {
        if (error.code === "23505") return null; // mensagem repetida = reenvio do canal
        falhar("registrarMensagem", error);
      }
      return data.id;
    },

    async finalizarMensagem(id, d) {
      const { error } = await db
        .from("mensagens")
        .update({
          status: d.status,
          interpretacao: d.interpretacao ?? null,
          resposta: d.resposta ?? null,
          erro: d.erro ?? null,
          processada_em: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) falhar("finalizarMensagem", error);
    },

    async listarContas(usuarioId) {
      const { data, error } = await db
        .from("contas")
        .select(COLUNAS_CONTA)
        .eq("usuario_id", usuarioId)
        .eq("ativa", true)
        .order("nome");
      if (error) falhar("listarContas", error);
      return (data ?? []).map(deLinhaConta);
    },

    async criarConta(usuarioId, d) {
      const { data, error } = await db
        .from("contas")
        .insert({ usuario_id: usuarioId, nome: d.nome, tipo: d.tipo, instituicao: d.instituicao, apelidos: d.apelidos })
        .select(COLUNAS_CONTA)
        .single();
      if (error) falhar("criarConta", error);
      return deLinhaConta(data);
    },

    async atualizarDiasCartao(contaId, diaFechamento, diaVencimento) {
      const { error } = await db
        .from("contas")
        .update({ dia_fechamento: diaFechamento, dia_vencimento: diaVencimento })
        .eq("id", contaId);
      if (error) falhar("atualizarDiasCartao", error);
    },

    async faturasInformadas(usuarioId, contaId) {
      const { data, error } = await db
        .from("transacoes")
        .select(COLUNAS_TRANSACAO)
        .eq("usuario_id", usuarioId)
        .eq("conta_id", contaId)
        .eq("tipo", "pagamento_fatura")
        .eq("status", "informado")
        .neq("origem", "banco")
        .order("criado_em");
      if (error) falhar("faturasInformadas", error);
      return (data ?? []).map(deLinha);
    },

    async semDataDePagamento(usuarioId, contaId) {
      const { data, error } = await db
        .from("transacoes")
        .select(COLUNAS_TRANSACAO)
        .eq("usuario_id", usuarioId)
        .eq("conta_id", contaId)
        .neq("status", "cancelado")
        .is("data_pagamento", null);
      if (error) falhar("semDataDePagamento", error);
      return (data ?? []).map(deLinha);
    },

    async listarCategorias(usuarioId) {
      const { data, error } = await db
        .from("categorias")
        .select("id, nome, tipo")
        .eq("usuario_id", usuarioId)
        .eq("ativa", true)
        .order("nome");
      if (error) falhar("listarCategorias", error);
      return (data ?? []).map((c: Linha): Categoria => ({ id: c.id, nome: c.nome, tipo: c.tipo }));
    },

    async inserirTransacoes(ts) {
      const { data, error } = await db.from("transacoes").insert(ts.map(paraLinha)).select(COLUNAS_TRANSACAO);
      if (error) falhar("inserirTransacoes", error);
      return (data ?? []).map(deLinha);
    },

    async transacoesDaUltimaMensagem(usuarioId) {
      const { data: ultima, error: e1 } = await db
        .from("transacoes")
        .select("mensagem_id")
        .eq("usuario_id", usuarioId)
        .neq("status", "cancelado")
        .not("mensagem_id", "is", null)
        .order("criado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (e1) falhar("ultimaMensagem", e1);
      if (!ultima) return [];
      const { data, error } = await db
        .from("transacoes")
        .select(COLUNAS_TRANSACAO)
        .eq("usuario_id", usuarioId)
        .eq("mensagem_id", ultima.mensagem_id)
        .neq("status", "cancelado");
      if (error) falhar("transacoesDaUltimaMensagem", error);
      return (data ?? []).map(deLinha);
    },

    async cancelarTransacoes(ids) {
      const { error } = await db.from("transacoes").update({ status: "cancelado" }).in("id", ids);
      if (error) falhar("cancelarTransacoes", error);
    },

    async confirmarTransacoes(ids) {
      const { error } = await db
        .from("transacoes")
        .update({ status: "confirmado", confirmado_em: new Date().toISOString() })
        .in("id", ids);
      if (error) falhar("confirmarTransacoes", error);
    },

    async restaurarStatus(ids, status) {
      const { error } = await db.from("transacoes").update({ status }).in("id", ids);
      if (error) falhar("restaurarStatus", error);
    },

    async registrarAcao(usuarioId, mensagemId, resumo, passos) {
      const { error } = await db.from("acoes").insert({ usuario_id: usuarioId, mensagem_id: mensagemId, resumo, passos });
      if (error) falhar("registrarAcao", error);
    },

    async ultimaAcao(usuarioId) {
      const { data, error } = await db
        .from("acoes")
        .select("id, resumo, passos")
        .eq("usuario_id", usuarioId)
        .is("desfeita_em", null)
        .order("criado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) falhar("ultimaAcao", error);
      return data ? { id: data.id, resumo: data.resumo, passos: data.passos as PassoDesfazer[] } : null;
    },

    async marcarDesfeita(acaoId) {
      const { error } = await db.from("acoes").update({ desfeita_em: new Date().toISOString() }).eq("id", acaoId);
      if (error) falhar("marcarDesfeita", error);
    },

    async atualizarTransacao(id, campos) {
      const linha: Linha = {};
      for (const [chave, valor] of Object.entries(campos)) {
        linha[MAPA_CORRECAO[chave as keyof CamposCorrecao]] = valor;
      }
      const { error } = await db.from("transacoes").update(linha).eq("id", id);
      if (error) falhar("atualizarTransacao", error);
    },

    async resumoPorCategoria(usuarioId, inicio, fim, contaId) {
      const { data, error } = contaId
        ? await db.rpc("resumo_por_categoria_conta", { p_usuario: usuarioId, p_inicio: inicio, p_fim: fim, p_conta: contaId })
        : await db.rpc("resumo_por_categoria", { p_usuario: usuarioId, p_inicio: inicio, p_fim: fim });
      if (error) falhar("resumoPorCategoria", error);
      return ((data ?? []) as Linha[]).map((l) => ({
        tipo: l.tipo,
        categoria: l.categoria,
        totalCentavos: Number(l.total_centavos),
        quantidade: Number(l.quantidade),
      }));
    },

    async resumoPorConta(usuarioId, inicio, fim) {
      const { data, error } = await db.rpc("resumo_por_conta", { p_usuario: usuarioId, p_inicio: inicio, p_fim: fim });
      if (error) falhar("resumoPorConta", error);
      return ((data ?? []) as Linha[]).map((l) => ({
        contaId: l.conta_id,
        conta: l.conta,
        tipoConta: l.tipo_conta,
        tipo: l.tipo,
        totalCentavos: Number(l.total_centavos),
        quantidade: Number(l.quantidade),
      }));
    },

    async lancamentos(usuarioId, inicio, fim, filtro) {
      let q = db
        .from("transacoes")
        .select("descricao, valor_centavos, data_transacao, contas(nome), categorias(nome)", { count: "exact" })
        .eq("usuario_id", usuarioId)
        .neq("status", "cancelado")
        .in("tipo", ["despesa", "receita"])
        .gte("data_transacao", inicio)
        .lte("data_transacao", fim)
        .order("valor_centavos", { ascending: false })
        .limit(filtro.limite);
      if (filtro.categoriaId) q = q.eq("categoria_id", filtro.categoriaId);
      if (filtro.contaId) q = q.eq("conta_id", filtro.contaId);
      const { data, error, count } = await q;
      if (error) falhar("lancamentos", error);
      const itens = (data ?? []).map((l: Linha): LancamentoResumido => ({
        descricao: l.descricao,
        valorCentavos: Number(l.valor_centavos),
        dataTransacao: l.data_transacao,
        conta: l.contas?.nome ?? null,
        categoria: l.categorias?.nome ?? null,
      }));
      return { itens, total: count ?? itens.length };
    },

    async listarRegras(usuarioId) {
      const { data, error } = await db
        .from("regras_categoria")
        .select("id, termo, categoria_id")
        .eq("usuario_id", usuarioId)
        .eq("ativa", true);
      if (error) falhar("listarRegras", error);
      return (data ?? []).map((l: Linha) => ({ id: l.id, termo: l.termo, categoriaId: l.categoria_id }));
    },

    async criarRegra(usuarioId, termo, categoriaId) {
      const { data, error } = await db
        .from("regras_categoria")
        .insert({ usuario_id: usuarioId, termo, categoria_id: categoriaId })
        .select("id")
        .single();
      if (error) falhar("criarRegra", error);
      return data.id;
    },

    async desativarRegra(id) {
      const { error } = await db.from("regras_categoria").update({ ativa: false }).eq("id", id);
      if (error) falhar("desativarRegra", error);
    },

    async lerPendencia(usuarioId) {
      const { data, error } = await db
        .from("pendencias")
        .select("tipo, dados, expira_em")
        .eq("usuario_id", usuarioId)
        .maybeSingle();
      if (error) falhar("lerPendencia", error);
      if (!data || Date.parse(data.expira_em) < Date.now()) return null;
      return { ...data.dados, tipo: data.tipo } as Pendencia;
    },

    async salvarPendencia(usuarioId, p, minutos) {
      const { tipo, ...dados } = p;
      const { error } = await db.from("pendencias").upsert({
        usuario_id: usuarioId,
        tipo,
        dados,
        expira_em: new Date(Date.now() + minutos * 60_000).toISOString(),
        criado_em: new Date().toISOString(),
      });
      if (error) falhar("salvarPendencia", error);
    },

    async limparPendencia(usuarioId) {
      const { error } = await db.from("pendencias").delete().eq("usuario_id", usuarioId);
      if (error) falhar("limparPendencia", error);
    },

    async transacoesComTermo(usuarioId, termo, tipo) {
      // O banco filtra por aproximação (sem acento não dá no ilike); a regra exata é aplicada aqui.
      const palavras = termo.split(/\s+/).filter(Boolean);
      let q = db
        .from("transacoes")
        .select(COLUNAS_TRANSACAO)
        .eq("usuario_id", usuarioId)
        .eq("tipo", tipo)
        .neq("status", "cancelado");
      for (const p of palavras) q = q.ilike("descricao", `%${p.replace(/[%_]/g, "")}%`);
      const { data, error } = await q.limit(1000);
      if (error) falhar("transacoesComTermo", error);
      return (data ?? []).map(deLinha).filter((t) => contemTermo(chave(t.descricao), termo));
    },

    async faturasAbertas(usuarioId, hoje) {
      const { data, error } = await db.rpc("faturas_abertas", { p_usuario: usuarioId, p_hoje: hoje });
      if (error) falhar("faturasAbertas", error);
      return ((data ?? []) as Linha[]).map((l) => ({
        contaId: l.conta_id,
        conta: l.conta,
        vencimento: l.vencimento,
        totalCentavos: Number(l.total_centavos),
        informada: Boolean(l.informada),
      }));
    },
  };
}
