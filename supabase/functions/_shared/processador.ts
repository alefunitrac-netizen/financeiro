// Núcleo do bot: recebe uma mensagem já validada e decide o que fazer.
// Não conhece Supabase, Meta nem Claude — só as interfaces de ./tipos.ts.
import {
  dataAmigavel,
  dataValida,
  diaDaSemana,
  hojeNoFuso,
  intervaloDoPeriodo,
  somarDias,
  somarMeses,
  vencimentoFatura,
} from "./datas.ts";
import { dividirEmParcelas, paraCentavos } from "./dinheiro.ts";
import {
  type ItemLancamento,
  itensDeTransacoes,
  normalizar,
  TEXTO_BOT_PRIVADO,
  TEXTO_ERRO,
  TEXTO_FORA_DO_ESCOPO,
  TEXTO_SO_TEXTO,
  textoAjuda,
  textoDesfeito,
  textoRegistro,
  textoResumo,
  textoVinculado,
} from "./respostas.ts";
import { normalizarWhatsapp } from "./telefone.ts";
import type {
  CamposCorrecao,
  Canal,
  Categoria,
  Conta,
  DataISO,
  Interpretacao,
  Interpretador,
  LancamentoInterpretado,
  Mensageiro,
  MensagemRecebida,
  NovaTransacao,
  Repositorio,
  TipoLancamento,
  Usuario,
} from "./tipos.ts";

export interface Dependencias {
  repo: Repositorio;
  interpretador: Interpretador;
  mensageiro: Mensageiro;
  agora: () => Date;
  novoId: () => string;
  log: (evento: string, dados?: Record<string, unknown>) => void;
  /** Open Finance (opcional): lê os bancos do usuário agora e devolve o texto da resposta. */
  sincronizarBanco?: (usuarioId: string) => Promise<string>;
}

const COMANDOS_BANCO = ["atualizar", "atualiza", "sincronizar", "sincroniza", "banco", "atualizar banco"];

const MAX_PARCELAS = 99;

// ---------- Correspondência de nomes ----------

export function encontrarConta(nome: string | null, contas: Conta[]): Conta | null {
  if (!nome) return null;
  const alvo = normalizar(nome);
  const nomesDa = (c: Conta) => [c.nome, ...c.apelidos].map(normalizar);
  const exata = contas.find((c) => nomesDa(c).includes(alvo));
  if (exata) return exata;
  // Aproximada só se for inequívoca: "nubank" casa com "Nubank crédito" se for a única.
  const parciais = contas.filter((c) => nomesDa(c).some((n) => n.includes(alvo) || alvo.includes(n)));
  return parciais.length === 1 ? parciais[0] : null;
}

export function encontrarCategoria(nome: string | null, tipo: TipoLancamento, categorias: Categoria[]): Categoria | null {
  const doTipo = categorias.filter((c) => c.tipo === tipo);
  if (nome) {
    const alvo = normalizar(nome);
    const achada = doTipo.find((c) => normalizar(c.nome) === alvo) ?? categorias.find((c) => normalizar(c.nome) === alvo);
    if (achada) return achada;
  }
  const reserva = tipo === "receita" ? "outras receitas" : "outros";
  return doTipo.find((c) => normalizar(c.nome) === reserva) ?? null;
}

/** Quando o dinheiro sai de fato: no cartão, o vencimento da fatura; no resto, na hora. */
export function dataDePagamento(data: DataISO, conta: Conta | null): DataISO | null {
  if (!conta) return null;
  if (conta.tipo === "cartao_credito") {
    return conta.diaFechamento && conta.diaVencimento
      ? vencimentoFatura(data, conta.diaFechamento, conta.diaVencimento)
      : null;
  }
  return data;
}

/** Comandos de uma palavra não precisam de IA: mais rápido, mais barato e funciona mesmo se a API cair. */
export function comandoDireto(texto: string): Interpretacao | null {
  const t = normalizar(texto);
  const vazio = { lancamentos: [], resumo: null, correcao: null, pergunta: null };
  if (["desfazer", "desfaz", "cancelar", "cancela", "apagar", "apaga"].includes(t)) {
    return { intencao: "desfazer", ...vazio };
  }
  if (["ajuda", "help", "menu", "oi", "ola", "comandos", "start"].includes(t)) return { intencao: "ajuda", ...vazio };
  if (["resumo", "extrato", "saldo"].includes(t)) {
    return {
      intencao: "resumo",
      ...vazio,
      resumo: { periodo: "mes_atual", inicio: null, fim: null, categoria: null },
    };
  }
  return null;
}

// ---------- Ações ----------

interface Resultado {
  texto: string;
  status: "processada" | "ignorada";
}

interface Contexto {
  canal: Canal;
  usuario: Usuario;
  mensagemId: string;
  hoje: DataISO;
  contas: Conta[];
  categorias: Categoria[];
  deps: Dependencias;
}

async function registrar(lancamentos: LancamentoInterpretado[], ctx: Contexto): Promise<Resultado> {
  const { hoje, contas, categorias } = ctx;
  const novas: NovaTransacao[] = [];
  const itens: ItemLancamento[] = [];
  const avisos: string[] = [];

  for (const l of lancamentos) {
    const valor = paraCentavos(l.valor);
    if (valor === null) {
      avisos.push(`⚠️ Não entendi o valor de "${l.descricao}" — manda de novo?`);
      continue;
    }

    // Data fora de uma janela razoável quase sempre é erro de interpretação.
    let data = l.data;
    if (!dataValida(data) || data > somarDias(hoje, 31) || data < somarDias(hoje, -366)) {
      avisos.push(`⚠️ Não entendi a data de "${l.descricao}"; usei hoje.`);
      data = hoje;
    }

    const conta = encontrarConta(l.conta, contas);
    if (l.conta && !conta) avisos.push(`⚠️ Não achei a conta "${l.conta}"; registrei sem conta.`);
    if (conta?.tipo === "cartao_credito" && !conta.diaFechamento) {
      avisos.push(`ℹ️ Cadastre o fechamento e o vencimento do ${conta.nome} para eu calcular as faturas.`);
    }
    const categoria = encontrarCategoria(l.categoria, l.tipo, categorias);

    let n = l.parcelas !== null && l.parcelas >= 2 ? l.parcelas : 1;
    if (n > MAX_PARCELAS) {
      avisos.push(`⚠️ ${n} parcelas não parece certo; registrei "${l.descricao}" à vista.`);
      n = 1;
    }

    let valores: number[];
    if (n === 1) valores = [valor];
    else if (l.valor_refere_se_a === "parcela") valores = Array(n).fill(valor);
    else {
      try {
        valores = dividirEmParcelas(valor, n);
      } catch {
        avisos.push(`⚠️ Não consegui dividir "${l.descricao}" em ${n}x; registrei à vista.`);
        valores = [valor];
        n = 1;
      }
    }

    const grupo = n > 1 ? ctx.deps.novoId() : null;
    const pagamentos: (DataISO | null)[] = [];
    valores.forEach((v, k) => {
      // A parcela k cai k meses depois da compra.
      const dataParcela = somarMeses(data, k);
      const pagamento = dataDePagamento(dataParcela, conta);
      pagamentos.push(pagamento);
      novas.push({
        usuarioId: ctx.usuario.id,
        origem: ctx.canal,
        contaId: conta?.id ?? null,
        categoriaId: categoria?.id ?? null,
        mensagemId: ctx.mensagemId,
        tipo: l.tipo,
        descricao: l.descricao.slice(0, 200) || "Lançamento",
        estabelecimento: l.estabelecimento,
        valorCentavos: v,
        dataTransacao: dataParcela,
        dataPagamento: pagamento,
        parcelaNumero: grupo ? k + 1 : null,
        parcelaTotal: grupo ? n : null,
        grupoParcelamento: grupo,
      });
    });
    itens.push({ tipo: l.tipo, descricao: l.descricao, estabelecimento: l.estabelecimento, valores, data, conta, categoria, pagamentos });
  }

  if (novas.length === 0) {
    return { texto: avisos.join("\n") || "Não encontrei nenhum valor para registrar.", status: "processada" };
  }
  await ctx.deps.repo.inserirTransacoes(novas);
  const texto = textoRegistro(itens, hoje);
  return { texto: avisos.length ? `${texto}\n\n${avisos.join("\n")}` : texto, status: "processada" };
}

async function desfazer(ctx: Contexto): Promise<Resultado> {
  const ts = await ctx.deps.repo.transacoesDaUltimaMensagem(ctx.usuario.id);
  if (ts.length === 0) return { texto: "Não encontrei nenhum lançamento para desfazer.", status: "processada" };
  await ctx.deps.repo.cancelarTransacoes(ts.map((t) => t.id));
  return { texto: textoDesfeito(itensDeTransacoes(ts, ctx.contas, ctx.categorias)), status: "processada" };
}

async function corrigir(correcao: Interpretacao["correcao"], ctx: Contexto): Promise<Resultado> {
  const ts = await ctx.deps.repo.transacoesDaUltimaMensagem(ctx.usuario.id);
  if (ts.length === 0) return { texto: "Não encontrei lançamento recente para corrigir.", status: "processada" };
  if (!correcao || Object.values(correcao).every((v) => v === null)) {
    return { texto: "O que eu corrijo? Ex.: _corrigir: era 52,00_ ou _corrigir: foi no itaú_.", status: "processada" };
  }

  const avisos: string[] = [];
  const comum: CamposCorrecao = {};
  let novaConta: Conta | null | undefined;

  if (correcao.conta) {
    novaConta = encontrarConta(correcao.conta, ctx.contas);
    if (novaConta) comum.contaId = novaConta.id;
    else avisos.push(`⚠️ Não achei a conta "${correcao.conta}".`);
  }
  if (correcao.categoria) {
    const cat = encontrarCategoria(correcao.categoria, ts[0].tipo, ctx.categorias);
    if (cat) comum.categoriaId = cat.id;
  }
  if (correcao.descricao) comum.descricao = correcao.descricao.slice(0, 200);

  let novoValor: number | null = null;
  let novaData: DataISO | null = null;
  if (correcao.valor || correcao.data) {
    if (ts.length > 1) {
      avisos.push("⚠️ Para mudar valor ou data de parcelado ou de vários lançamentos, responda *desfazer* e mande de novo.");
    } else {
      if (correcao.valor) {
        novoValor = paraCentavos(correcao.valor);
        if (novoValor === null) avisos.push(`⚠️ Não entendi o valor "${correcao.valor}".`);
      }
      if (correcao.data) {
        if (dataValida(correcao.data)) novaData = correcao.data;
        else avisos.push(`⚠️ Não entendi a data "${correcao.data}".`);
      }
    }
  }

  const atualizadas = [];
  for (const t of ts) {
    const campos: CamposCorrecao = { ...comum };
    if (novoValor !== null) campos.valorCentavos = novoValor;
    if (novaData !== null) campos.dataTransacao = novaData;
    if (campos.contaId !== undefined || campos.dataTransacao !== undefined) {
      const conta = novaConta ?? ctx.contas.find((c) => c.id === t.contaId) ?? null;
      campos.dataPagamento = dataDePagamento(campos.dataTransacao ?? t.dataTransacao, conta);
    }
    if (Object.keys(campos).length === 0) continue;
    await ctx.deps.repo.atualizarTransacao(t.id, campos);
    atualizadas.push({ ...t, ...campos });
  }

  if (atualizadas.length === 0) return { texto: avisos.join("\n") || "Nada para corrigir.", status: "processada" };
  const texto = textoRegistro(itensDeTransacoes(atualizadas, ctx.contas, ctx.categorias), ctx.hoje, "✏️ *Corrigido:*");
  return { texto: avisos.length ? `${texto}\n\n${avisos.join("\n")}` : texto, status: "processada" };
}

async function resumir(pedido: Interpretacao["resumo"], ctx: Contexto): Promise<Resultado> {
  const p = pedido ?? { periodo: "mes_atual" as const, inicio: null, fim: null, categoria: null };
  let intervalo;
  if (p.periodo === "intervalo" && dataValida(p.inicio) && dataValida(p.fim) && p.inicio <= p.fim) {
    intervalo = {
      inicio: p.inicio,
      fim: p.fim,
      rotulo: `${dataAmigavel(p.inicio, ctx.hoje)} a ${dataAmigavel(p.fim, ctx.hoje)}`,
    };
  } else {
    intervalo = intervaloDoPeriodo(p.periodo === "intervalo" ? "mes_atual" : p.periodo, ctx.hoje);
  }
  const linhas = await ctx.deps.repo.resumoPorCategoria(ctx.usuario.id, intervalo.inicio, intervalo.fim);
  return { texto: textoResumo(linhas, intervalo.rotulo, p.categoria), status: "processada" };
}

async function executar(msg: MensagemRecebida, usuario: Usuario, mensagemId: string, deps: Dependencias) {
  if (msg.tipo !== "text" || !msg.texto?.trim()) {
    return { resultado: { texto: TEXTO_SO_TEXTO, status: "ignorada" as const }, interpretacao: null };
  }

  if (deps.sincronizarBanco && COMANDOS_BANCO.includes(normalizar(msg.texto))) {
    return {
      resultado: { texto: await deps.sincronizarBanco(usuario.id), status: "processada" as const },
      interpretacao: null,
    };
  }

  const hoje = hojeNoFuso(usuario.fusoHorario, deps.agora());
  const [contas, categorias] = await Promise.all([
    deps.repo.listarContas(usuario.id),
    deps.repo.listarCategorias(usuario.id),
  ]);
  const ctx: Contexto = { canal: msg.canal, usuario, mensagemId, hoje, contas, categorias, deps };

  const interpretacao = comandoDireto(msg.texto) ??
    (await deps.interpretador.interpretar({
      texto: msg.texto.slice(0, 2000),
      hoje,
      diaDaSemana: diaDaSemana(hoje),
      contas,
      categorias,
    }));

  let resultado: Resultado;
  switch (interpretacao.intencao) {
    case "registrar":
      resultado = interpretacao.lancamentos.length
        ? await registrar(interpretacao.lancamentos, ctx)
        : { texto: "Não encontrei nenhum valor para registrar.", status: "processada" };
      break;
    case "resumo":
      resultado = await resumir(interpretacao.resumo, ctx);
      break;
    case "desfazer":
      resultado = await desfazer(ctx);
      break;
    case "corrigir":
      resultado = await corrigir(interpretacao.correcao, ctx);
      break;
    case "ajuda":
      resultado = { texto: textoAjuda(usuario.nome), status: "processada" };
      break;
    case "esclarecer":
      resultado = {
        texto: interpretacao.pergunta ?? "Não entendi bem. Manda de novo com o valor? Ex.: _almoço 35 no nubank_.",
        status: "processada",
      };
      break;
    default:
      resultado = { texto: TEXTO_FORA_DO_ESCOPO, status: "processada" };
  }
  return { resultado, interpretacao };
}

/** "/start CODIGO" — o link de vínculo do Telegram (t.me/<bot>?start=CODIGO) envia isso. */
const COMANDO_VINCULO = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/;

/** Descobre de quem é a mensagem. No Telegram, também faz o vínculo pelo código de uso único. */
async function identificar(
  msg: MensagemRecebida,
  deps: Dependencias,
): Promise<{ usuario: Usuario; acabouDeVincular: boolean } | null> {
  if (msg.canal === "whatsapp") {
    const usuario = await deps.repo.buscarUsuarioPorWhatsapp(normalizarWhatsapp(msg.remetente));
    return usuario && { usuario, acabouDeVincular: false };
  }
  const codigo = msg.texto ? COMANDO_VINCULO.exec(msg.texto.trim())?.[1] : undefined;
  if (codigo) {
    const usuario = await deps.repo.vincularTelegram(codigo, msg.remetente);
    if (usuario) return { usuario, acabouDeVincular: true };
  }
  const usuario = await deps.repo.buscarUsuarioPorTelegram(msg.remetente);
  return usuario && { usuario, acabouDeVincular: false };
}

/** Ponto de entrada: processa uma mensagem de qualquer canal, de ponta a ponta. */
export async function processarMensagem(msg: MensagemRecebida, deps: Dependencias): Promise<void> {
  const quem = await identificar(msg, deps);
  if (!quem) {
    // Fora da lista: não grava nada. No Telegram, quem abre o bot (/start) recebe só um aviso curto.
    deps.log("remetente_desconhecido", { canal: msg.canal, final: msg.remetente.slice(-4) });
    if (msg.canal === "telegram" && msg.texto?.trim().startsWith("/start")) {
      await deps.mensageiro.responder(msg, TEXTO_BOT_PRIVADO).catch(() => {});
    }
    return;
  }
  const { usuario, acabouDeVincular } = quem;

  const mensagemId = await deps.repo.registrarMensagem({
    usuarioId: usuario.id,
    canal: msg.canal,
    idExterno: msg.idExterno,
    tipo: msg.tipo,
    texto: msg.texto,
  });
  if (!mensagemId) {
    deps.log("mensagem_duplicada", { canal: msg.canal, id: msg.idExterno });
    return;
  }

  let texto: string;
  let status: "processada" | "ignorada" | "erro";
  let interpretacao: Interpretacao | null = null;
  let erro: string | undefined;
  try {
    if (acabouDeVincular) {
      texto = textoVinculado(usuario.nome);
      status = "processada";
    } else {
      const r = await executar(msg, usuario, mensagemId, deps);
      texto = r.resultado.texto;
      status = r.resultado.status;
      interpretacao = r.interpretacao;
    }
  } catch (e) {
    texto = TEXTO_ERRO;
    status = "erro";
    erro = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    deps.log("erro_processamento", { id: msg.idExterno, erro });
  }

  try {
    await deps.mensageiro.responder(msg, texto);
  } catch (e) {
    const falha = `envio: ${e instanceof Error ? e.message : String(e)}`;
    erro = erro ? `${erro} | ${falha}` : falha;
    deps.log("erro_envio", { id: msg.idExterno, erro: falha });
  }

  await deps.repo.finalizarMensagem(mensagemId, { status, interpretacao, resposta: texto, erro });
}
