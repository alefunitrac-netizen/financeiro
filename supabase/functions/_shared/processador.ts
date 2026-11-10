// Núcleo do bot: recebe uma mensagem já validada e decide o que fazer.
// Não conhece Supabase, Meta nem Claude — só as interfaces de ./tipos.ts.
import {
  dataAmigavel,
  dataValida,
  diaDaSemana,
  hojeNoFuso,
  intervaloDoPeriodo,
  proximaDataComDia,
  somarDias,
  somarMeses,
  vencimentoFatura,
} from "./datas.ts";
import { dividirEmParcelas, paraCentavos } from "./dinheiro.ts";
import { bancoDoTexto } from "./bancos.ts";
import {
  type ItemLancamento,
  itensDeTransacoes,
  normalizar,
  TEXTO_BOT_PRIVADO,
  TEXTO_ERRO,
  TEXTO_FORA_DO_ESCOPO,
  TEXTO_SO_TEXTO,
  textoAjuda,
  textoCartaoConfigurado,
  textoContas,
  textoDesfeito,
  textoFatura,
  textoRegistro,
  textoResumo,
  textoVinculado,
} from "./respostas.ts";
import { normalizarWhatsapp } from "./telefone.ts";
import { chave } from "./texto.ts";
import type {
  CamposCorrecao,
  Canal,
  Categoria,
  Conta,
  DataISO,
  Interpretacao,
  Interpretador,
  LancamentoInterpretado,
  Meio,
  Mensageiro,
  MensagemRecebida,
  NovaConta,
  NovaTransacao,
  PedidoCartao,
  PedidoFatura,
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

const bancoDa = (c: Conta) => c.instituicao || bancoDoTexto(c.nome);
const combinaMeio = (c: Conta, meio: Meio | null | undefined) =>
  !meio || (meio === "credito" ? c.tipo === "cartao_credito" : c.tipo !== "cartao_credito");

/** Conta que o sistema cria quando você cita um banco que ainda não está cadastrado. */
export function novaContaDoBanco(banco: string, meio: Meio | null | undefined): NovaConta {
  const k = chave(banco).trim();
  return meio === "debito"
    ? { nome: banco, tipo: "corrente", instituicao: banco, apelidos: [k, `conta ${k}`, `debito ${k}`, `pix ${k}`] }
    : {
      nome: `Cartão ${banco}`,
      tipo: "cartao_credito",
      instituicao: banco,
      apelidos: [k, `cartao ${k}`, `${k} credito`, `credito ${k}`, `fatura ${k}`],
    };
}

/**
 * Acha a conta citada, respeitando a pista de meio de pagamento ("no débito do nubank" não é o
 * cartão Nubank). Se for um banco conhecido sem a conta do tipo certo, cria a conta.
 * `base`: conta atual do lançamento, para "foi no débito" (mesmo banco, outro tipo).
 */
async function resolverConta(
  nome: string | null,
  meio: Meio | null | undefined,
  ctx: Contexto,
  base: Conta | null = null,
): Promise<{ conta: Conta | null; criada: Conta | null }> {
  const achada = nome ? encontrarConta(nome, ctx.contas) : null;
  if (achada && combinaMeio(achada, meio)) return { conta: achada, criada: null };

  const banco = achada ? bancoDa(achada) : nome ? bancoDoTexto(nome) : base ? bancoDa(base) : null;
  if (!banco || (!achada && !nome && !meio)) return { conta: achada, criada: null };

  const doBanco = ctx.contas.filter((c) => bancoDa(c) === banco && combinaMeio(c, meio));
  if (doBanco.length) return { conta: doBanco.find((c) => c.tipo === "cartao_credito") ?? doBanco[0], criada: null };

  const dados = novaContaDoBanco(banco, meio);
  const mesmoNome = ctx.contas.find((c) => normalizar(c.nome) === normalizar(dados.nome));
  if (mesmoNome) return { conta: mesmoNome, criada: null };
  const criada = await ctx.deps.repo.criarConta(ctx.usuario.id, dados);
  ctx.contas.push(criada);
  ctx.deps.log("conta_criada", { tipo: criada.tipo, instituicao: banco });
  return { conta: criada, criada };
}

const PEDIR_DIAS = (c: Conta) => {
  const k = bancoDa(c) ? chave(bancoDa(c)!).trim() : "cartao";
  return `Para eu saber em que fatura cada compra cai, me diga: _${k} fecha dia 3 vence dia 10_ (com os dias do seu cartão).`;
};

function avisoContaCriada(c: Conta, curto = false): string {
  if (curto) return `${c.tipo === "cartao_credito" ? "💳" : "🏦"} Criei ${c.tipo === "cartao_credito" ? "o" : "a conta"} *${c.nome}*.`;
  return c.tipo === "cartao_credito"
    ? `💳 Criei o *${c.nome}*. ${PEDIR_DIAS(c)}\n_Se foi no débito ou Pix, responda: foi no débito._`
    : `🏦 Criei a conta *${c.nome}*.`;
}

/** Vencimento da próxima fatura do cartão, se ele tem os dias cadastrados. */
function proximoVencimento(c: Conta, hoje: DataISO): DataISO | null {
  return c.diaVencimento ? proximaDataComDia(hoje, c.diaVencimento) : null;
}

/** Comandos de uma palavra não precisam de IA: mais rápido, mais barato e funciona mesmo se a API cair. */
export function comandoDireto(texto: string): Interpretacao | null {
  const t = normalizar(texto);
  const vazio = { lancamentos: [], resumo: null, correcao: null, pergunta: null };
  if (["desfazer", "desfaz", "cancelar", "cancela", "apagar", "apaga"].includes(t)) {
    return { intencao: "desfazer", ...vazio };
  }
  if (["ajuda", "help", "menu", "oi", "ola", "comandos", "start"].includes(t)) return { intencao: "ajuda", ...vazio };
  if (["saldo", "saldos", "contas", "minhas contas", "faturas", "fatura", "cartoes", "limite"].includes(t)) {
    return { intencao: "contas", ...vazio };
  }
  if (["resumo", "extrato", "resumo total", "resumo geral", "por banco", "por conta"].includes(t)) {
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
  const { hoje, categorias } = ctx;
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

    const { conta, criada } = await resolverConta(l.conta, l.meio, ctx);
    if (l.conta && !conta) avisos.push(`⚠️ Não achei a conta "${l.conta}"; registrei sem conta.`);
    if (criada) avisos.push(avisoContaCriada(criada));
    else if (conta?.tipo === "cartao_credito" && !conta.diaFechamento && !avisos.some((a) => a.includes(conta.nome))) {
      avisos.push(`ℹ️ ${conta.nome} sem fechamento e vencimento. ${PEDIR_DIAS(conta)}`);
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

  if (correcao.conta || correcao.meio) {
    const atual = ctx.contas.find((c) => c.id === ts[0].contaId) ?? null;
    const r = await resolverConta(correcao.conta, correcao.meio, ctx, atual);
    novaConta = r.conta;
    if (novaConta) comum.contaId = novaConta.id;
    else if (correcao.conta) avisos.push(`⚠️ Não achei a conta "${correcao.conta}".`);
    else avisos.push(`⚠️ Em qual banco? Ex.: _foi no débito do itaú_.`);
    if (r.criada) avisos.push(avisoContaCriada(r.criada));
  }
  if (correcao.categoria && ts[0].tipo !== "pagamento_fatura") {
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
    if (t.tipo !== "pagamento_fatura" && (campos.contaId !== undefined || campos.dataTransacao !== undefined)) {
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
  const { repo } = ctx.deps;
  let conta: Conta | null = null;
  if (p.conta) {
    conta = encontrarConta(p.conta, ctx.contas) ??
      ctx.contas.find((c) => bancoDa(c) !== null && bancoDa(c) === bancoDoTexto(p.conta!)) ?? null;
    if (!conta) return { texto: `📊 Não tenho a conta *${p.conta}* ainda. Ela aparece quando você registrar algo nela.`, status: "processada" };
  }
  const [categorias, porConta, faturas] = await Promise.all([
    repo.resumoPorCategoria(ctx.usuario.id, intervalo.inicio, intervalo.fim, conta?.id),
    repo.resumoPorConta(ctx.usuario.id, intervalo.inicio, intervalo.fim),
    conta || p.categoria ? Promise.resolve([]) : repo.faturasAbertas(ctx.usuario.id, ctx.hoje),
  ]);
  const texto = textoResumo(categorias, intervalo.rotulo, p.categoria, {
    porConta: conta ? [] : porConta,
    faturas,
    conta,
    hoje: ctx.hoje,
  });
  return { texto, status: "processada" };
}

async function registrarFatura(f: PedidoFatura, ctx: Contexto): Promise<Resultado> {
  const { repo } = ctx.deps;
  const cartoes = ctx.contas.filter((c) => c.tipo === "cartao_credito");
  const r = f.conta ? await resolverConta(f.conta, "credito", ctx) : { conta: cartoes.length === 1 ? cartoes[0] : null, criada: null };
  const cartao = r.conta;
  if (!cartao || cartao.tipo !== "cartao_credito") {
    return { texto: "🧾 De qual cartão é essa fatura? Ex.: _fatura nubank 1547 vence dia 15_.", status: "processada" };
  }
  const abertas = await repo.faturasInformadas(ctx.usuario.id, cartao.id);
  const avisos = r.criada ? [avisoContaCriada(r.criada, true)] : [];

  if (f.valor === null) {
    // Só o vencimento: ajusta a fatura que você já informou.
    const ultima = abertas[abertas.length - 1];
    if (!ultima) {
      return { texto: `🧾 Não achei fatura do ${cartao.nome}. Mande com o valor: _fatura ${chave(bancoDa(cartao) ?? "nubank").trim()} 1547 vence dia 15_.`, status: "processada" };
    }
    await repo.atualizarTransacao(ultima.id, { dataPagamento: f.vencimento });
    return { texto: textoFatura({ ...ultima, dataPagamento: f.vencimento }, cartao, ctx.hoje, "✏️ *Fatura atualizada:*"), status: "processada" };
  }

  const valor = paraCentavos(f.valor);
  if (valor === null) return { texto: `⚠️ Não entendi o valor da fatura. Ex.: _fatura nubank 1547,90_.`, status: "processada" };

  let vencimento = f.vencimento ?? proximoVencimento(cartao, ctx.hoje);
  if (f.paga) {
    // Paga agora: as que estavam em aberto saem da lista de "a pagar".
    if (abertas.length) await repo.confirmarTransacoes(abertas.map((a) => a.id));
    vencimento = f.vencimento ?? ctx.hoje;
  } else {
    // Informar de novo a mesma fatura troca o valor, em vez de somar.
    const repetidas = abertas.filter((a) => !a.dataPagamento || !vencimento || a.dataPagamento === vencimento);
    if (repetidas.length) await repo.cancelarTransacoes(repetidas.map((a) => a.id));
  }
  const [gravada] = await repo.inserirTransacoes([{
    usuarioId: ctx.usuario.id,
    origem: ctx.canal,
    contaId: cartao.id,
    categoriaId: null,
    mensagemId: ctx.mensagemId,
    tipo: "pagamento_fatura",
    status: f.paga ? "confirmado" : "informado",
    descricao: `Fatura ${cartao.nome}`,
    estabelecimento: null,
    valorCentavos: valor,
    dataTransacao: ctx.hoje,
    dataPagamento: vencimento,
    parcelaNumero: null,
    parcelaTotal: null,
    grupoParcelamento: null,
  }]);
  const texto = textoFatura(gravada, cartao, ctx.hoje, f.paga ? "✅ *Fatura paga:*" : undefined);
  return { texto: avisos.length ? `${texto}\n\n${avisos.join("\n")}` : texto, status: "processada" };
}

async function configurarCartao(p: PedidoCartao, ctx: Contexto): Promise<Resultado> {
  const { repo } = ctx.deps;
  const cartoes = ctx.contas.filter((c) => c.tipo === "cartao_credito");
  const r = p.conta ? await resolverConta(p.conta, "credito", ctx) : { conta: cartoes.length === 1 ? cartoes[0] : null, criada: null };
  const cartao = r.conta;
  if (!cartao || cartao.tipo !== "cartao_credito") {
    return { texto: "💳 De qual cartão? Ex.: _nubank fecha dia 3 vence dia 10_.", status: "processada" };
  }
  await repo.atualizarDiasCartao(cartao.id, p.diaFechamento, p.diaVencimento);
  cartao.diaFechamento = p.diaFechamento;
  cartao.diaVencimento = p.diaVencimento;

  // O que já estava no cartão sem data de pagamento ganha a fatura certa.
  let atualizados = 0;
  for (const t of await repo.semDataDePagamento(ctx.usuario.id, cartao.id)) {
    const pagamento = t.tipo === "pagamento_fatura"
      ? proximaDataComDia(ctx.hoje, p.diaVencimento)
      : vencimentoFatura(t.dataTransacao, p.diaFechamento, p.diaVencimento);
    await repo.atualizarTransacao(t.id, { dataPagamento: pagamento });
    atualizados++;
  }
  return { texto: textoCartaoConfigurado(cartao, atualizados, ctx.hoje), status: "processada" };
}

async function mostrarUltimo(ctx: Contexto): Promise<Resultado> {
  const ts = await ctx.deps.repo.transacoesDaUltimaMensagem(ctx.usuario.id);
  if (ts.length === 0) return { texto: "Você ainda não registrou nada por aqui.", status: "processada" };
  const itens = itensDeTransacoes(ts, ctx.contas, ctx.categorias);
  let texto = ts[0].tipo === "pagamento_fatura"
    ? textoFatura(ts[0], ctx.contas.find((c) => c.id === ts[0].contaId) ?? null, ctx.hoje, "🔎 *Último registro:*")
    : textoRegistro(itens, ctx.hoje, "🔎 *Último registro:*");
  if (!ts[0].contaId) texto += "\n\nEstá *sem conta*. Para dizer onde foi, responda: _foi no nubank_ (ou _foi no débito do itaú_).";
  return { texto, status: "processada" };
}

async function mostrarContas(ctx: Contexto): Promise<Resultado> {
  const faturas = await ctx.deps.repo.faturasAbertas(ctx.usuario.id, ctx.hoje);
  return { texto: textoContas(ctx.contas, faturas, ctx.hoje), status: "processada" };
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
    case "fatura":
      resultado = interpretacao.fatura
        ? await registrarFatura(interpretacao.fatura, ctx)
        : { texto: "🧾 Mande assim: _fatura nubank 1547 vence dia 15_.", status: "processada" };
      break;
    case "configurar_cartao":
      resultado = interpretacao.cartao
        ? await configurarCartao(interpretacao.cartao, ctx)
        : { texto: "💳 Mande assim: _nubank fecha dia 3 vence dia 10_.", status: "processada" };
      break;
    case "ultimo":
      resultado = await mostrarUltimo(ctx);
      break;
    case "contas":
      resultado = await mostrarContas(ctx);
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
