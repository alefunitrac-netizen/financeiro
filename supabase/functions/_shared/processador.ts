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
import { dividirEmParcelas, formatarReais, paraCentavos } from "./dinheiro.ts";
import { bancoDoTexto } from "./bancos.ts";
import {
  type ItemLancamento,
  itensDeTransacoes,
  normalizar,
  TEXTO_BOT_PRIVADO,
  TEXTO_ERRO,
  TEXTO_FORA_DO_ESCOPO,
  TEXTO_NAO_ENTENDI,
  TEXTO_SO_TEXTO,
  textoAjuda,
  textoCartaoConfigurado,
  textoCategorizado,
  textoContas,
  resumoParaDesfazer,
  textoDesfeito,
  textoFatura,
  textoRegistro,
  textoCategoria,
  textoPerguntaCategoria,
  textoResumo,
  textoVinculado,
} from "./respostas.ts";
import { categoriaNoTexto, contaNoTexto, interpretarPorRegras, vencimentoNoTexto } from "./interpretador_regras.ts";
import { categoriaPorRegra, termoDaDescricao } from "./regras.ts";
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
  PassoDesfazer,
  Pendencia,
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

const PEDIR_DIAS = (_c: Conta) => `❓ Em que dia o cartão fecha e em que dia vence? _Responda assim: 3 e 10._`;

/** Minutos que o bot espera a resposta de uma pergunta. Categoria vinda do banco espera mais. */
const ESPERA_MIN = 15;
const ESPERA_CATEGORIA_MIN = 24 * 60;

async function perguntar(ctx: Contexto, p: Pendencia, minutos = ESPERA_MIN) {
  await ctx.deps.repo.salvarPendencia(ctx.usuario.id, p, minutos);
}

const ehReserva = (c: Categoria | null | undefined) => !!c && ["outros", "outras receitas"].includes(normalizar(c.nome));
const exemplosCategoria = (ctx: Contexto, tipo: TipoLancamento) =>
  ctx.categorias.filter((c) => c.tipo === tipo && !ehReserva(c)).slice(0, 4).map((c) => c.nome);
const palavras = (t: string) => normalizar(t).split(" ").filter(Boolean).length;

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
  const regras = await ctx.deps.repo.listarRegras(ctx.usuario.id);
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
    if (conta?.tipo === "cartao_credito" && !conta.diaFechamento) await perguntar(ctx, { tipo: "dias_cartao", contaId: conta.id });
    let categoria = encontrarCategoria(l.categoria, l.tipo, categorias);
    // Sem categoria clara, vale o que você ensinou ("roberto é moradia").
    if (!categoria || ["outros", "outras receitas"].includes(normalizar(categoria.nome))) {
      categoria = categoriaPorRegra(l.descricao, l.tipo, regras, categorias) ?? categoria;
    }

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
  const gravadas = await ctx.deps.repo.inserirTransacoes(novas);
  await anotar(ctx, resumoParaDesfazer(itens), [{ op: "cancelar", ids: gravadas.map((t) => t.id) }]);
  const texto = textoRegistro(itens, hoje);
  return { texto: avisos.length ? `${texto}\n\n${avisos.join("\n")}` : texto, status: "processada" };
}

/** Guarda como voltar atrás o que acabou de ser feito. */
async function anotar(ctx: Contexto, resumo: string, passos: PassoDesfazer[]) {
  if (passos.length) await ctx.deps.repo.registrarAcao(ctx.usuario.id, ctx.mensagemId, resumo.slice(0, 300), passos);
}

/** Palavra que precisa aparecer no resumo da ação para "desfazer <alvo>" bater com ela. */
const ALVOS: Record<string, [string, string]> = {
  vencimento: ["vencimento", "o vencimento"],
  fatura: ["fatura", "a fatura"],
  parcela: ["parcela", "a compra parcelada"],
  parcelado: ["parcela", "a compra parcelada"],
  parcelada: ["parcela", "a compra parcelada"],
  correcao: ["correcao", "uma correção"],
  fechamento: ["fechamento", "os dias do cartão"],
  dias: ["fechamento", "os dias do cartão"],
};

/** Desfaz a ÚLTIMA ação, seja ela um registro, uma correção, um vencimento ou os dias do cartão. */
async function desfazer(ctx: Contexto, alvo?: string | null): Promise<Resultado> {
  const { repo } = ctx.deps;
  const acao = await repo.ultimaAcao(ctx.usuario.id);
  if (acao && alvo && ALVOS[alvo] && !chave(acao.resumo).includes(ALVOS[alvo][0])) {
    // "desfazer vencimento", mas a última coisa feita foi outra: não desfaz às cegas.
    return {
      texto: `🤔 A última coisa que fiz foi ${acao.resumo}, não ${ALVOS[alvo][1]}.\n` +
        `Se quiser voltar isso, responda *desfazer*.`,
      status: "processada",
    };
  }
  if (acao) {
    for (const p of [...acao.passos].reverse()) {
      if (p.op === "cancelar") await repo.cancelarTransacoes(p.ids);
      else if (p.op === "status") await repo.restaurarStatus(p.ids, p.status);
      else if (p.op === "campos") await repo.atualizarTransacao(p.id, p.campos);
      else if (p.op === "desativar_regra") await repo.desativarRegra(p.id);
      else await repo.atualizarDiasCartao(p.contaId, p.diaFechamento, p.diaVencimento);
    }
    await repo.marcarDesfeita(acao.id);
    return { texto: textoDesfeito(acao.resumo), status: "processada" };
  }
  // Lançamentos de antes do histórico de ações: desfaz a última mensagem inteira.
  const ts = await repo.transacoesDaUltimaMensagem(ctx.usuario.id);
  if (ts.length === 0) return { texto: "Não encontrei nenhum lançamento para desfazer.", status: "processada" };
  await repo.cancelarTransacoes(ts.map((t) => t.id));
  return { texto: textoDesfeito(resumoParaDesfazer(itensDeTransacoes(ts, ctx.contas, ctx.categorias))), status: "processada" };
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
  const passos: PassoDesfazer[] = [];
  for (const t of ts) {
    const campos: CamposCorrecao = { ...comum };
    if (novoValor !== null) campos.valorCentavos = novoValor;
    if (novaData !== null) campos.dataTransacao = novaData;
    if (t.tipo !== "pagamento_fatura" && (campos.contaId !== undefined || campos.dataTransacao !== undefined)) {
      const conta = novaConta ?? ctx.contas.find((c) => c.id === t.contaId) ?? null;
      campos.dataPagamento = dataDePagamento(campos.dataTransacao ?? t.dataTransacao, conta);
    }
    if (Object.keys(campos).length === 0) continue;
    const antes = Object.fromEntries(Object.keys(campos).map((k) => [k, t[k as keyof CamposCorrecao]])) as CamposCorrecao;
    passos.push({ op: "campos", id: t.id, campos: antes });
    await ctx.deps.repo.atualizarTransacao(t.id, campos);
    atualizadas.push({ ...t, ...campos });
  }
  if (atualizadas.length) {
    const itens = itensDeTransacoes(ts, ctx.contas, ctx.categorias);
    await anotar(ctx, `a correção de ${resumoParaDesfazer(itens)}`, passos);
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
  // "o que é outros?" / "quanto foi de mercado?": lista os lançamentos da categoria.
  const categoria = p.categoria
    ? ctx.categorias.find((c) => normalizar(c.nome) === normalizar(p.categoria!)) ?? null
    : null;
  if (p.categoria && !categoria) {
    return { texto: `📂 Não tenho a categoria *${p.categoria}*.`, status: "processada" };
  }
  if (categoria) {
    const [lista, somas] = await Promise.all([
      repo.lancamentos(ctx.usuario.id, intervalo.inicio, intervalo.fim, { categoriaId: categoria.id, contaId: conta?.id, limite: 10 }),
      repo.resumoPorCategoria(ctx.usuario.id, intervalo.inicio, intervalo.fim, conta?.id),
    ]);
    const soma = somas.find((l) => l.tipo === categoria.tipo && l.categoria === categoria.nome)?.totalCentavos ?? 0;
    // Em "Outros", já pergunta o que é o maior: a resposta ("moradia") vira regra.
    let pergunta: string | null = null;
    const maior = ehReserva(categoria) ? lista.itens[0] : undefined;
    const termo = maior ? termoDaDescricao(maior.descricao) : null;
    if (maior && termo) {
      await perguntar(ctx, {
        tipo: "categoria",
        termo,
        tipoLancamento: categoria.tipo,
        descricao: maior.descricao,
        valorCentavos: maior.valorCentavos,
      }, ESPERA_CATEGORIA_MIN);
      pergunta = textoPerguntaCategoria(maior.descricao, maior.valorCentavos, exemplosCategoria(ctx, categoria.tipo));
    }
    return {
      texto: textoCategoria(categoria, intervalo.rotulo, conta, lista.itens, lista.total, soma, ctx.hoje, pergunta),
      status: "processada",
    };
  }

  const reservas = ctx.categorias.filter((c) => ["outros", "outras receitas"].includes(normalizar(c.nome)));
  const [categorias, porConta, faturas, ...semCategoria] = await Promise.all([
    repo.resumoPorCategoria(ctx.usuario.id, intervalo.inicio, intervalo.fim, conta?.id),
    conta ? Promise.resolve([]) : repo.resumoPorConta(ctx.usuario.id, intervalo.inicio, intervalo.fim),
    conta ? Promise.resolve([]) : repo.faturasAbertas(ctx.usuario.id, ctx.hoje),
    ...reservas.map((c) =>
      repo.lancamentos(ctx.usuario.id, intervalo.inicio, intervalo.fim, { categoriaId: c.id, contaId: conta?.id, limite: 2 })
    ),
  ]);
  const destaques = new Map(reservas.map((c, i) => [c.nome, semCategoria[i].itens]));
  const texto = textoResumo(categorias, intervalo.rotulo, null, { porConta, faturas, conta, hoje: ctx.hoje, destaques });
  return { texto, status: "processada" };
}

async function registrarFatura(f: PedidoFatura, ctx: Contexto): Promise<Resultado> {
  const { repo } = ctx.deps;
  const cartoes = ctx.contas.filter((c) => c.tipo === "cartao_credito");
  const r = f.conta ? await resolverConta(f.conta, "credito", ctx) : { conta: cartoes.length === 1 ? cartoes[0] : null, criada: null };
  const cartao = r.conta;
  if (!cartao || cartao.tipo !== "cartao_credito") {
    const nomes = cartoes.map((c) => chave(bancoDa(c) ?? c.nome).trim());
    if (f.valor !== null) {
      await perguntar(ctx, { tipo: "conta_fatura", valor: f.valor, vencimento: f.vencimento, paga: f.paga });
    }
    return {
      texto: `🧾 De qual cartão é essa fatura?${nomes.length ? ` _Responda: ${nomes.join(" ou ")}._` : ""}`,
      status: "processada",
    };
  }
  const abertas = await repo.faturasInformadas(ctx.usuario.id, cartao.id);
  const avisos = r.criada ? [avisoContaCriada(r.criada, true)] : [];

  if (f.valor === null && f.vencimento === null) {
    // "alterar vencimento nubank": pergunta o dia e espera a resposta.
    if (!abertas.length) {
      return { texto: `🧾 Não achei fatura em aberto do ${cartao.nome}. Mande com o valor: _fatura nubank 1547 vence dia 10_.`, status: "processada" };
    }
    await perguntar(ctx, { tipo: "vencimento", contaId: cartao.id });
    return { texto: `📅 Qual o novo vencimento da fatura do *${cartao.nome}*? _Responda: dia 10 (ou 10/12)._`, status: "processada" };
  }

  if (f.valor === null) {
    // Só o vencimento: ajusta a fatura que você já informou.
    const ultima = abertas[abertas.length - 1];
    if (!ultima) {
      return { texto: `🧾 Não achei fatura do ${cartao.nome}. Mande com o valor: _fatura ${chave(bancoDa(cartao) ?? "nubank").trim()} 1547 vence dia 15_.`, status: "processada" };
    }
    const antes = ultima.dataPagamento;
    await repo.atualizarTransacao(ultima.id, { dataPagamento: f.vencimento });
    await anotar(ctx, `o vencimento da fatura do ${cartao.nome}`, [
      { op: "campos", id: ultima.id, campos: { dataPagamento: antes } },
    ]);
    return { texto: textoFatura({ ...ultima, dataPagamento: f.vencimento }, cartao, ctx.hoje, "✏️ *Fatura atualizada:*"), status: "processada" };
  }

  const valor = paraCentavos(f.valor);
  if (valor === null) return { texto: `⚠️ Não entendi o valor da fatura. Ex.: _fatura nubank 1547,90_.`, status: "processada" };

  let vencimento = f.vencimento ?? proximoVencimento(cartao, ctx.hoje);
  const passos: PassoDesfazer[] = [];
  if (f.paga) {
    // Paga agora: as que estavam em aberto saem da lista de "a pagar".
    if (abertas.length) {
      await repo.confirmarTransacoes(abertas.map((a) => a.id));
      passos.push({ op: "status", ids: abertas.map((a) => a.id), status: "informado" });
    }
    vencimento = f.vencimento ?? ctx.hoje;
  } else {
    // Informar de novo a mesma fatura troca o valor, em vez de somar.
    const repetidas = abertas.filter((a) => !a.dataPagamento || !vencimento || a.dataPagamento === vencimento);
    if (repetidas.length) {
      await repo.cancelarTransacoes(repetidas.map((a) => a.id));
      passos.push({ op: "status", ids: repetidas.map((a) => a.id), status: "informado" });
    }
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
  passos.push({ op: "cancelar", ids: [gravada.id] });
  await anotar(ctx, `${f.paga ? "o pagamento" : "a fatura"} de ${formatarReais(valor)} do ${cartao.nome}`, passos);
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
  const passos: PassoDesfazer[] = [
    { op: "dias_cartao", contaId: cartao.id, diaFechamento: cartao.diaFechamento, diaVencimento: cartao.diaVencimento },
  ];
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
    passos.push({ op: "campos", id: t.id, campos: { dataPagamento: null } });
    atualizados++;
  }
  await anotar(ctx, `os dias de fechamento e vencimento do ${cartao.nome}`, passos);
  return { texto: textoCartaoConfigurado(cartao, atualizados, ctx.hoje), status: "processada" };
}

/** "roberto é moradia": guarda a regra e já recategoriza o que bate com ela. */
async function categorizar(regra: { termo: string; categoria: string }, ctx: Contexto): Promise<Resultado> {
  const { repo } = ctx.deps;
  const categoria = ctx.categorias.find((c) => normalizar(c.nome) === normalizar(regra.categoria));
  if (!categoria) return { texto: `📂 Não tenho a categoria *${regra.categoria}*.`, status: "processada" };
  const termo = chave(regra.termo).trim();
  const regraId = await repo.criarRegra(ctx.usuario.id, termo, categoria.id);
  const passos: PassoDesfazer[] = [{ op: "desativar_regra", id: regraId }];
  const afetadas = await repo.transacoesComTermo(ctx.usuario.id, termo, categoria.tipo);
  let total = 0;
  for (const t of afetadas) {
    if (t.categoriaId === categoria.id) continue;
    passos.push({ op: "campos", id: t.id, campos: { categoriaId: t.categoriaId } });
    await repo.atualizarTransacao(t.id, { categoriaId: categoria.id });
    total += t.valorCentavos;
  }
  const mudadas = passos.length - 1;
  await anotar(ctx, `a regra "${termo}" → ${categoria.nome}`, passos);
  return { texto: textoCategorizado(termo, categoria.nome, mudadas, total), status: "processada" };
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

/** Conta citada numa consulta (sem criar nada): por nome/apelido ou pelo banco. */
function contaDaConsulta(nome: string, ctx: Contexto): Conta[] {
  const exata = encontrarConta(nome, ctx.contas);
  const banco = exata ? bancoDa(exata) : bancoDoTexto(nome);
  const doBanco = banco ? ctx.contas.filter((c) => bancoDa(c) === banco) : [];
  return doBanco.length ? doBanco : exata ? [exata] : [];
}

async function mostrarContas(ctx: Contexto, nome?: string | null): Promise<Resultado> {
  let contas = ctx.contas;
  if (nome) {
    contas = contaDaConsulta(nome, ctx);
    if (!contas.length) {
      return { texto: `🏦 Ainda não tenho *${nome}*. A conta aparece quando você registrar algo nela.`, status: "processada" };
    }
  }
  const ids = new Set(contas.map((c) => c.id));
  const faturas = (await ctx.deps.repo.faturasAbertas(ctx.usuario.id, ctx.hoje)).filter((f) => ids.has(f.contaId));
  const texto = textoContas(contas, faturas, ctx.hoje, Boolean(nome));
  const semDias = contas.find((c) => c.tipo === "cartao_credito" && !c.diaFechamento);
  if (semDias) await perguntar(ctx, { tipo: "dias_cartao", contaId: semDias.id });
  return { texto: semDias ? `${texto}\n\n${PEDIR_DIAS(semDias)}` : texto, status: "processada" };
}

const RE_PULAR = /^\W*(pular|pula|deixa|deixa\s+pra\s+la|nao\s+sei|depois|ignora|ignorar|nada)\W*$/;

/**
 * A mensagem é a resposta curta da pergunta em aberto? Se for, resolve e devolve o resultado.
 * Se não for (a pessoa mudou de assunto), devolve null e a mensagem segue o caminho normal.
 */
async function responderPendencia(p: Pendencia, texto: string, ctx: Contexto): Promise<Resultado | null> {
  const k = normalizar(texto);
  if (RE_PULAR.test(k)) {
    return { texto: p.tipo === "categoria" ? "👍 Ok, fica em Outros." : "👍 Ok, deixei pra lá.", status: "processada" };
  }
  switch (p.tipo) {
    case "valor": {
      // "almocei fora" → "Quanto foi?" → "35" (ou "35 no nubank")
      if (!/\d/.test(texto) || palavras(texto) > 5) return null;
      // Só vale se a resposta for o valor (com conta ou data, se quiser): "uber 20" é outro gasto.
      const sozinha = interpretarPorRegras({ texto, hoje: ctx.hoje, diaDaSemana: diaDaSemana(ctx.hoje), contas: ctx.contas, categorias: ctx.categorias });
      if (sozinha?.intencao !== "registrar" || sozinha.lancamentos.length !== 1 || sozinha.lancamentos[0].descricao !== "Gasto") {
        return null;
      }
      const i = interpretarPorRegras({ texto: `${p.texto} ${texto}`, hoje: ctx.hoje, diaDaSemana: diaDaSemana(ctx.hoje), contas: ctx.contas, categorias: ctx.categorias });
      if (i?.intencao !== "registrar" || i.lancamentos.length !== 1) return null;
      return await registrar(i.lancamentos, ctx);
    }
    case "vencimento": {
      if (palavras(texto) > 4) return null;
      const vencimento = vencimentoNoTexto(texto, ctx.hoje);
      const cartao = ctx.contas.find((c) => c.id === p.contaId);
      if (!vencimento || !cartao) return null;
      return await registrarFatura({ conta: cartao.nome, valor: null, vencimento, paga: false }, ctx);
    }
    case "dias_cartao": {
      const numeros = [...k.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1]));
      const cartao = ctx.contas.find((c) => c.id === p.contaId);
      if (numeros.length !== 2 || palavras(texto) > 8 || !cartao || numeros.some((n) => n < 1 || n > 31)) return null;
      // "fecha 3 vence 10", "3 e 10", "vence 10 fecha 3"
      const [a, b] = numeros;
      const venceAntes = /\bvenc\w*\b.*\bfech/.test(k);
      return await configurarCartao({
        conta: cartao.nome,
        diaFechamento: venceAntes ? b : a,
        diaVencimento: venceAntes ? a : b,
      }, ctx);
    }
    case "conta_fatura": {
      if (palavras(texto) > 4) return null;
      const conta = contaNoTexto(texto, ctx.contas);
      if (!conta) return null;
      return await registrarFatura({ conta, valor: p.valor, vencimento: p.vencimento, paga: p.paga }, ctx);
    }
    case "categoria": {
      if (palavras(texto) > 4 || /\d/.test(texto)) return null;
      // "roberto é moradia" é um comando completo: vale ele, não a pergunta.
      const comando = interpretarPorRegras({ texto, hoje: ctx.hoje, diaDaSemana: diaDaSemana(ctx.hoje), contas: ctx.contas, categorias: ctx.categorias });
      if (comando?.intencao === "categorizar") return null;
      const categoria = categoriaNoTexto(texto, [p.tipoLancamento], ctx.categorias);
      // "Outros" de novo é pedir a lista outra vez, não responder.
      if (categoria && ehReserva(ctx.categorias.find((c) => c.nome === categoria))) return null;
      if (!categoria) {
        if (palavras(texto) > 2) return null;
        // Parece resposta, mas não é uma categoria que existe: mostra as opções e continua esperando.
        await perguntar(ctx, p, ESPERA_CATEGORIA_MIN);
        const nomes = ctx.categorias.filter((c) => c.tipo === p.tipoLancamento).map((c) => c.nome.toLowerCase());
        return { texto: `🤔 Não tenho a categoria *${texto.trim()}*. Escolha uma: ${nomes.join(", ")}.`, status: "processada" };
      }
      return await categorizar({ termo: p.termo, categoria }, ctx);
    }
  }
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

  // Resposta curta a uma pergunta que o bot fez ("dia 10", "35", "moradia")?
  const pendencia = await deps.repo.lerPendencia(usuario.id);
  if (pendencia) {
    await deps.repo.limparPendencia(usuario.id);
    const resposta = await responderPendencia(pendencia, msg.texto, ctx);
    if (resposta) return { resultado: resposta, interpretacao: null };
  }

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
      resultado = await desfazer(ctx, interpretacao.desfazerAlvo);
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
      resultado = await mostrarContas(ctx, interpretacao.contaConsulta);
      break;
    case "categorizar":
      resultado = interpretacao.regra
        ? await categorizar(interpretacao.regra, ctx)
        : { texto: "📂 Mande assim: _roberto é moradia_.", status: "processada" };
      break;
    case "esclarecer": {
      // "almocei fora": parece um gasto, só faltou o valor. Pergunta e espera.
      const texto = msg.texto.trim();
      const pareceGasto = !/\d/.test(texto) && palavras(texto) <= 6 &&
        categoriaNoTexto(texto, ["despesa"], categorias) !== null;
      const daIa = interpretacao.pergunta && interpretacao.pergunta !== TEXTO_NAO_ENTENDI ? interpretacao.pergunta : null;
      if (pareceGasto) {
        await perguntar(ctx, { tipo: "valor", texto });
        resultado = {
          texto: daIa ?? `💬 Quanto foi *${texto}*? _Responda só o valor, ex.: 35 (ou 35 no nubank)._`,
          status: "processada",
        };
      } else {
        resultado = {
          texto: interpretacao.pergunta ?? "Não entendi bem. Manda de novo com o valor? Ex.: _almoço 35 no nubank_.",
          status: "processada",
        };
      }
      break;
    }
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
