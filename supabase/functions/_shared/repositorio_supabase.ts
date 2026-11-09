// Implementação do Repositorio sobre o Postgres do Supabase (supabase-js).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import type { CamposCorrecao, Categoria, Conta, NovaTransacao, Repositorio, Transacao, Usuario } from "./tipos.ts";

const COLUNAS_TRANSACAO =
  "id, usuario_id, conta_id, categoria_id, mensagem_id, tipo, descricao, estabelecimento, valor_centavos, data_transacao, data_pagamento, parcela_numero, parcela_total, grupo_parcelamento";

// deno-lint-ignore no-explicit-any
type Linha = Record<string, any>;

function deLinha(l: Linha): Transacao {
  return {
    id: l.id,
    usuarioId: l.usuario_id,
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
    origem: "whatsapp",
    status: "informado",
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
        .select("id, nome, tipo, apelidos, dia_fechamento, dia_vencimento")
        .eq("usuario_id", usuarioId)
        .eq("ativa", true)
        .order("nome");
      if (error) falhar("listarContas", error);
      return (data ?? []).map((c: Linha): Conta => ({
        id: c.id,
        nome: c.nome,
        tipo: c.tipo,
        apelidos: c.apelidos ?? [],
        diaFechamento: c.dia_fechamento,
        diaVencimento: c.dia_vencimento,
      }));
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

    async atualizarTransacao(id, campos) {
      const linha: Linha = {};
      for (const [chave, valor] of Object.entries(campos)) {
        linha[MAPA_CORRECAO[chave as keyof CamposCorrecao]] = valor;
      }
      const { error } = await db.from("transacoes").update(linha).eq("id", id);
      if (error) falhar("atualizarTransacao", error);
    },

    async resumoPorCategoria(usuarioId, inicio, fim) {
      const { data, error } = await db.rpc("resumo_por_categoria", {
        p_usuario: usuarioId,
        p_inicio: inicio,
        p_fim: fim,
      });
      if (error) falhar("resumoPorCategoria", error);
      return ((data ?? []) as Linha[]).map((l) => ({
        tipo: l.tipo,
        categoria: l.categoria,
        totalCentavos: Number(l.total_centavos),
        quantidade: Number(l.quantidade),
      }));
    },
  };
}
