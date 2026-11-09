// Open Finance via Pluggy (Meu Pluggy, uso pessoal): lê contas e transações do banco, confere com
// o que você informou e grava o resto.
// Regra de ouro: o banco é a fonte da verdade do VALOR e da DATA; você é a fonte da verdade da
// DESCRIÇÃO e da CATEGORIA. Por isso, ao confirmar um lançamento seu, mantemos o seu texto.
import { dataAmigavel, hojeNoFuso, somarDias, vencimentoFatura } from "./datas.ts";
import { formatarReais } from "./dinheiro.ts";
import { categoriaPorTexto, chave } from "./interpretador_regras.ts";
import type { Categoria, DataISO, TipoConta } from "./tipos.ts";

const API = "https://api.pluggy.ai";

// ---------- O que a Pluggy devolve (só os campos que usamos) ----------

export interface ItemPluggy {
  id: string;
  status?: string;
  executionStatus?: string | null;
  consentExpiresAt?: string | null;
  lastUpdatedAt?: string | null;
  connector?: { name?: string } | null;
  error?: { code?: string; message?: string } | null;
}

export interface ContaPluggy {
  id: string;
  type: string; // BANK | CREDIT
  subtype?: string; // CHECKING_ACCOUNT | SAVINGS_ACCOUNT | CREDIT_CARD
  name: string;
  marketingName?: string | null;
  number?: string | null;
  balance?: number | null;
  creditData?: {
    balanceCloseDate?: string | null;
    balanceDueDate?: string | null;
    creditLimit?: number | null;
  } | null;
}

export interface TransacaoPluggy {
  id: string;
  description: string;
  amount: number;
  amountInAccountCurrency?: number | null;
  date: string;
  type: string; // DEBIT | CREDIT
  status?: string;
  providerId?: string | null;
  creditCardMetadata?: { installmentNumber?: number | null; totalInstallments?: number | null } | null;
}

export interface ClientePluggy {
  item(itemId: string): Promise<ItemPluggy>;
  contas(itemId: string): Promise<ContaPluggy[]>;
  transacoes(accountId: string, de: DataISO, ate: DataISO): Promise<TransacaoPluggy[]>;
}

export class ErroPluggy extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroPluggy";
  }
}

/** Cliente da API. A chave dura 2 horas: reaproveitamos (pedir uma por chamada estoura o limite do /auth). */
export function criarClientePluggy(opcoes: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  agora?: () => number;
}): ClientePluggy {
  const fazerFetch = opcoes.fetch ?? fetch;
  const agora = opcoes.agora ?? Date.now;
  let apiKey: { valor: string; expiraEm: number } | null = null;

  async function chaveDaApi(): Promise<string> {
    if (apiKey && apiKey.expiraEm > agora()) return apiKey.valor;
    const r = await fazerFetch(`${API}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: opcoes.clientId, clientSecret: opcoes.clientSecret }),
    });
    if (!r.ok) throw new ErroPluggy(`auth ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const corpo = await r.json() as { apiKey?: string };
    if (!corpo.apiKey) throw new ErroPluggy("auth sem apiKey na resposta");
    apiKey = { valor: corpo.apiKey, expiraEm: agora() + 110 * 60 * 1000 }; // 1h50, com folga
    return apiKey.valor;
  }

  async function ler<T>(caminho: string): Promise<T> {
    const r = await fazerFetch(`${API}${caminho}`, { headers: { "X-API-KEY": await chaveDaApi() } });
    if (!r.ok) throw new ErroPluggy(`GET ${caminho.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return await r.json() as T;
  }

  return {
    item: (itemId) => ler<ItemPluggy>(`/items/${encodeURIComponent(itemId)}`),
    async contas(itemId) {
      const r = await ler<{ results?: ContaPluggy[] }>(`/accounts?itemId=${encodeURIComponent(itemId)}`);
      return r.results ?? [];
    },
    async transacoes(accountId, de, ate) {
      const todas: TransacaoPluggy[] = [];
      let consulta: string | null = `?accountId=${encodeURIComponent(accountId)}&dateFrom=${de}&dateTo=${ate}`;
      for (let pagina = 0; consulta && pagina < 40; pagina++) {
        const r: { results?: TransacaoPluggy[]; next?: string | null } = await ler(`/v2/transactions${consulta}`);
        todas.push(...(r.results ?? []));
        consulta = r.next ?? null;
      }
      // Lista incompleta é pior que nenhuma: faria transações "sumirem" na conferência.
      if (consulta) throw new ErroPluggy("paginação de transações não terminou");
      return todas;
    },
  };
}

// ---------- Conversão para o nosso modelo ----------

export interface DadosContaBanco {
  externalId: string;
  nome: string;
  tipo: TipoConta;
  apelidos: string[];
  instituicao: string;
  diaFechamento: number | null;
  diaVencimento: number | null;
  limiteCentavos: number | null;
  saldoCentavos: number | null;
}

const BANCOS: [RegExp, string][] = [
  [/\bitau\b/, "Itaú"],
  [/\bnubank\b|\bnu pagamentos\b/, "Nubank"],
  [/\bbradesco\b/, "Bradesco"],
  [/\bsantander\b/, "Santander"],
  [/\bbanco do brasil\b|\bbb\b/, "Banco do Brasil"],
  [/\bcaixa\b/, "Caixa"],
  [/\binter\b/, "Inter"],
  [/\bc6\b/, "C6 Bank"],
  [/\bbtg\b/, "BTG"],
  [/\bxp\b/, "XP"],
  [/\bpicpay\b/, "PicPay"],
  [/\bmercado pago\b/, "Mercado Pago"],
  [/\bsicoob\b/, "Sicoob"],
  [/\bsicredi\b/, "Sicredi"],
  [/\bneon\b/, "Neon"],
  [/\bpagbank\b|\bpagseguro\b/, "PagBank"],
  [/\bsafra\b/, "Safra"],
  [/\bbanrisul\b/, "Banrisul"],
];

/**
 * Banco de uma conta. Pelo Meu Pluggy o conector se chama "MeuPluggy" e um item pode trazer
 * vários bancos, então o banco sai do nome da conta ("itau", "Itaú Click Múltiplo MC Plat").
 */
export function instituicaoDaConta(c: ContaPluggy, nomeConector?: string | null): string {
  const k = chave(`${c.name ?? ""} ${c.marketingName ?? ""}`);
  for (const [re, nome] of BANCOS) if (re.test(k)) return nome;
  if (nomeConector && !/pluggy/i.test(nomeConector)) return nomeConector;
  const nome = (c.name ?? "").trim();
  return nome ? nome[0].toUpperCase() + nome.slice(1) : "Banco";
}

/** A Pluggy manda reais com casas decimais (47.9); aqui tudo é centavo inteiro. */
const emCentavos = (v: number) => Math.round(v * 100);
const diaDe = (data?: string | null) => (data && /^\d{4}-\d{2}-\d{2}/.test(data) ? Number(data.slice(8, 10)) : null);

export function mapearConta(c: ContaPluggy, instituicao: string): DadosContaBanco {
  const inst = instituicao.trim() || "Banco";
  const k = chave(inst).trim();
  const base = {
    externalId: `pluggy:${c.id}`,
    instituicao: inst,
    saldoCentavos: typeof c.balance === "number" ? emCentavos(c.balance) : null,
  };
  if (c.type === "CREDIT" || c.subtype === "CREDIT_CARD") {
    const final = (c.number ?? "").replace(/\D/g, "").slice(-4);
    let fechamento = diaDe(c.creditData?.balanceCloseDate);
    let vencimento = diaDe(c.creditData?.balanceDueDate);
    if (fechamento === null || vencimento === null) fechamento = vencimento = null; // o banco exige os dois juntos
    return {
      ...base,
      nome: final ? `Cartão ${inst} final ${final}` : `Cartão ${inst}`,
      tipo: "cartao_credito",
      apelidos: [`cartao ${k}`, `${k} credito`, `credito ${k}`, "cartao", "credito", ...(final ? [final, `cartao ${final}`] : [])],
      diaFechamento: fechamento,
      diaVencimento: vencimento,
      limiteCentavos: typeof c.creditData?.creditLimit === "number" ? emCentavos(c.creditData.creditLimit) : null,
    };
  }
  const poupanca = c.subtype === "SAVINGS_ACCOUNT";
  return {
    ...base,
    nome: poupanca ? `${inst} Poupança` : inst,
    tipo: poupanca ? "poupanca" : "corrente",
    apelidos: poupanca ? [`poupanca ${k}`, "poupanca"] : [k, `conta ${k}`, `debito ${k}`, "debito", "pix"],
    diaFechamento: null,
    diaVencimento: null,
    limiteCentavos: null,
  };
}

/**
 * A Pluggy manda datas em UTC. Data "pura" vem à meia-noite UTC e é o próprio dia; com hora,
 * convertemos para o horário de Brasília (uma compra às 22h do dia 5 não vira dia 6).
 */
export function dataDoBanco(iso: string): DataISO {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso) || /T00:00:00(\.0+)?Z$/.test(iso)) return iso.slice(0, 10);
  const instante = new Date(iso);
  return Number.isNaN(instante.getTime()) ? iso.slice(0, 10) : hojeNoFuso("America/Sao_Paulo", instante);
}

export type TipoBanco = "despesa" | "receita" | "pagamento_fatura";

export interface TransacaoBanco {
  externalId: string;
  contaId: string;
  tipo: TipoBanco;
  descricao: string;
  valorCentavos: number;
  dataTransacao: DataISO;
  dataPagamento: DataISO | null;
}

export interface ContaSalva {
  id: string;
  nome: string;
  tipo: TipoConta;
  diaFechamento: number | null;
  diaVencimento: number | null;
}

const RE_PAGAMENTO_FATURA = /\b(pagamento|pagto|pgto|pag)\b.*\b(fatura|cartao)\b|\bfatura\b/;
const RE_PAGAMENTO_RECEBIDO_CARTAO = /\b(pagamento|pagto|pgto)\b/;

export function mapearTransacao(t: TransacaoPluggy, conta: ContaSalva): TransacaoBanco | null {
  const bruto = typeof t.amountInAccountCurrency === "number" ? t.amountInAccountCurrency : t.amount;
  const valor = Math.abs(emCentavos(bruto));
  if (!valor) return null;

  let descricao = (t.description ?? "").replace(/\s+/g, " ").trim() || "Transação";
  const meta = t.creditCardMetadata;
  if (meta?.totalInstallments && meta.totalInstallments >= 2 && meta.installmentNumber) {
    descricao += ` (${meta.installmentNumber}/${meta.totalInstallments})`;
  }
  const k = chave(descricao);
  const cartao = conta.tipo === "cartao_credito";

  let tipo: TipoBanco;
  if (cartao) {
    // No cartão: positivo é compra; negativo é pagamento da fatura ou estorno.
    tipo = bruto > 0 ? "despesa" : RE_PAGAMENTO_RECEBIDO_CARTAO.test(k) ? "pagamento_fatura" : "receita";
  } else {
    tipo = t.type === "CREDIT" ? "receita" : RE_PAGAMENTO_FATURA.test(k) ? "pagamento_fatura" : "despesa";
  }

  const data = dataDoBanco(t.date);
  let pagamento: DataISO | null = data;
  if (cartao) {
    pagamento = conta.diaFechamento && conta.diaVencimento
      ? vencimentoFatura(data, conta.diaFechamento, conta.diaVencimento)
      : null;
  }

  return {
    // providerId é o id do próprio banco e não muda; o id da Pluggy muda quando a fatura fecha.
    externalId: `pluggy:${t.providerId || t.id}`,
    contaId: conta.id,
    tipo,
    descricao: descricao.slice(0, 200),
    valorCentavos: valor,
    dataTransacao: data,
    dataPagamento: pagamento,
  };
}

// ---------- Conferência com o que você informou ----------

export interface Informado {
  id: string;
  contaId: string | null;
  tipo: string;
  valorCentavos: number;
  dataTransacao: DataISO;
}

const diasEntre = (a: DataISO, b: DataISO) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/**
 * Acha o lançamento que você informou e que corresponde ao que veio do banco: mesmo tipo, mesmo
 * valor, mesma conta (ou sem conta) e data próxima. Prefere mesma conta e a data mais perto.
 */
export function acharCorrespondente(b: TransacaoBanco, informados: Informado[], toleranciaDias: number): Informado | null {
  const candidatos = informados
    .filter((i) =>
      i.tipo === b.tipo && i.valorCentavos === b.valorCentavos && (i.contaId === b.contaId || i.contaId === null) &&
      Math.abs(diasEntre(i.dataTransacao, b.dataTransacao)) <= toleranciaDias
    )
    .sort((x, y) =>
      Number(y.contaId === b.contaId) - Number(x.contaId === b.contaId) ||
      Math.abs(diasEntre(x.dataTransacao, b.dataTransacao)) - Math.abs(diasEntre(y.dataTransacao, b.dataTransacao))
    );
  return candidatos[0] ?? null;
}

// ---------- Sincronização ----------

export interface ConexaoBanco {
  id: string;
  usuarioId: string;
  itemId: string;
  instituicao: string | null;
  telegramId: string | null;
  ultimaSincronizacao: string | null;
}

export interface TransacaoSalva {
  id: string;
  externalId: string;
  valorCentavos: number;
  dataTransacao: DataISO;
}

export interface NovaDoBanco extends TransacaoBanco {
  categoriaId: string | null;
}

export interface RepositorioBanco {
  listarConexoes(usuarioId?: string): Promise<ConexaoBanco[]>;
  salvarConta(usuarioId: string, dados: DadosContaBanco): Promise<ContaSalva>;
  listarCategorias(usuarioId: string): Promise<Categoria[]>;
  buscarPorExternos(usuarioId: string, externos: string[]): Promise<TransacaoSalva[]>;
  informadosParaConciliar(usuarioId: string, inicio: DataISO, fim: DataISO): Promise<Informado[]>;
  confirmar(id: string, b: TransacaoBanco): Promise<void>;
  atualizarDoBanco(id: string, b: TransacaoBanco): Promise<void>;
  inserirDoBanco(usuarioId: string, novas: NovaDoBanco[]): Promise<void>;
  /** O que sumiu do banco na janela: do banco → cancelado; seu e confirmado → volta a "informado". */
  tratarAusentes(usuarioId: string, contaId: string, inicio: DataISO, fim: DataISO, presentes: Set<string>): Promise<number>;
  registrarSincronizacao(conexaoId: string, dados: {
    instituicao: string | null;
    status: string | null;
    consentimentoExpiraEm: string | null;
    erro: string | null;
  }): Promise<void>;
}

export interface ResultadoSincronizacao {
  instituicao: string;
  novas: (NovaDoBanco & { conta: string; categoria: string | null })[];
  confirmadas: number;
  canceladas: number;
  avisos: string[];
}

export interface DependenciasSincronizacao {
  repo: RepositorioBanco;
  pluggy: ClientePluggy;
  agora: () => Date;
}

/** Janela lida a cada sincronização: 60 dias para trás e as parcelas futuras do cartão. */
const DIAS_PASSADOS = 60;
const DIAS_FUTUROS = 400;

export async function sincronizarConexao(
  conexao: ConexaoBanco,
  deps: DependenciasSincronizacao,
): Promise<ResultadoSincronizacao> {
  const hoje = hojeNoFuso("America/Sao_Paulo", deps.agora());
  const de = somarDias(hoje, -DIAS_PASSADOS);
  const ate = somarDias(hoje, DIAS_FUTUROS);
  const { repo, pluggy } = deps;
  const avisos: string[] = [];

  const item = await pluggy.item(conexao.itemId);
  const conector = item.connector?.name ?? null;
  if (item.error?.code || item.status === "LOGIN_ERROR" || item.status === "OUTDATED") {
    avisos.push(`⚠️ A conexão ${conector ? `${conector} ` : ""}está com problema (${item.error?.code ?? item.status}). ` +
      "Abra o Meu Pluggy e reconecte.");
  }
  if (item.consentExpiresAt) {
    const expira = item.consentExpiresAt.slice(0, 10);
    if (diasEntre(expira, hoje) <= 30) {
      avisos.push(`⚠️ A autorização do Meu Pluggy vence em ${dataAmigavel(expira, hoje)}. Renove no painel da Pluggy: ` +
        "Applications → Demo → Connect Account → MeuPluggy.");
    }
  }

  const categorias = await repo.listarCategorias(conexao.usuarioId);
  const porNome = new Map(categorias.map((c) => [c.nome, c]));
  const informados = await repo.informadosParaConciliar(conexao.usuarioId, somarDias(de, -5), somarDias(ate, 5));
  const resultado: ResultadoSincronizacao = { instituicao: "", novas: [], confirmadas: 0, canceladas: 0, avisos };
  const bancos = new Set<string>();

  for (const cp of await pluggy.contas(conexao.itemId)) {
    const banco = instituicaoDaConta(cp, conector);
    bancos.add(banco);
    const conta = await repo.salvarConta(conexao.usuarioId, mapearConta(cp, banco));
    const doBanco = (await pluggy.transacoes(cp.id, de, ate))
      .map((t) => mapearTransacao(t, conta))
      .filter((t): t is TransacaoBanco => t !== null);
    // Mesmo id duas vezes na mesma leitura: fica o último.
    const unicas = [...new Map(doBanco.map((t) => [t.externalId, t])).values()];

    const conhecidas = new Map(
      (await repo.buscarPorExternos(conexao.usuarioId, unicas.map((t) => t.externalId))).map((t) => [t.externalId, t]),
    );
    const novas: NovaDoBanco[] = [];
    // Cartão: parcelas e fechamento de fatura mexem mais na data do que no débito.
    const tolerancia = conta.tipo === "cartao_credito" ? 5 : 3;

    for (const b of unicas) {
      const salva = conhecidas.get(b.externalId);
      if (salva) {
        if (salva.valorCentavos !== b.valorCentavos || salva.dataTransacao !== b.dataTransacao) {
          await repo.atualizarDoBanco(salva.id, b);
        }
        continue;
      }
      const seu = b.tipo === "pagamento_fatura" ? null : acharCorrespondente(b, informados, tolerancia);
      if (seu) {
        await repo.confirmar(seu.id, b);
        informados.splice(informados.indexOf(seu), 1);
        resultado.confirmadas++;
        continue;
      }
      const nomeCategoria = b.tipo === "pagamento_fatura"
        ? null
        : categoriaPorTexto(b.descricao, b.tipo, categorias) ?? (b.tipo === "receita" ? "Outras receitas" : "Outros");
      const categoria = nomeCategoria ? porNome.get(nomeCategoria) ?? null : null;
      novas.push({ ...b, categoriaId: categoria?.id ?? null });
      resultado.novas.push({ ...b, categoriaId: categoria?.id ?? null, conta: conta.nome, categoria: categoria?.nome ?? null });
    }

    if (novas.length) await repo.inserirDoBanco(conexao.usuarioId, novas);
    // Margem de 1 dia nas pontas: fuso horário não pode fazer algo "sumir".
    resultado.canceladas += await repo.tratarAusentes(
      conexao.usuarioId,
      conta.id,
      somarDias(de, 1),
      somarDias(ate, -1),
      new Set(unicas.map((t) => t.externalId)),
    );
  }

  resultado.instituicao = [...bancos].join(", ") || conexao.instituicao || conector || "Banco";
  await repo.registrarSincronizacao(conexao.id, {
    instituicao: resultado.instituicao,
    status: item.status ?? null,
    consentimentoExpiraEm: item.consentExpiresAt ?? null,
    erro: null,
  });
  return resultado;
}

const MAX_LINHAS_AVISO = 8;

/** Mensagem para o Telegram. Null quando não há nada a dizer (sincronização automática silenciosa). */
export function textoSincronizacao(r: ResultadoSincronizacao, hoje: DataISO, sempre = false): string | null {
  const gastos = r.novas.filter((n) => n.tipo !== "pagamento_fatura");
  if (!gastos.length && !r.confirmadas && !r.canceladas && !r.avisos.length && !sempre) return null;
  const linhas = [`🏦 *${r.instituicao} atualizado*`];
  if (r.confirmadas) {
    linhas.push(`✅ ${r.confirmadas} lançamento${r.confirmadas > 1 ? "s" : ""} que você informou ` +
      `${r.confirmadas > 1 ? "foram confirmados" : "foi confirmado"} pelo banco.`);
  }
  if (gastos.length) {
    linhas.push(`🆕 ${gastos.length} novo${gastos.length > 1 ? "s" : ""} vindo${gastos.length > 1 ? "s" : ""} do banco:`);
    const ordenadas = [...gastos].sort((a, b) => b.dataTransacao.localeCompare(a.dataTransacao));
    for (const n of ordenadas.slice(0, MAX_LINHAS_AVISO)) {
      const sinal = n.tipo === "receita" ? "➕ " : "";
      linhas.push(`• ${sinal}${formatarReais(n.valorCentavos)} — ${n.descricao} · ${n.categoria ?? "Sem categoria"} · ` +
        dataAmigavel(n.dataTransacao, hoje));
    }
    if (ordenadas.length > MAX_LINHAS_AVISO) linhas.push(`_e mais ${ordenadas.length - MAX_LINHAS_AVISO}._`);
  }
  if (r.canceladas) linhas.push(`↩️ ${r.canceladas} lançamento${r.canceladas > 1 ? "s sumiram" : " sumiu"} do banco e foi desfeito.`);
  if (!gastos.length && !r.confirmadas && !r.canceladas) linhas.push("Nada novo desde a última vez.");
  linhas.push(...r.avisos);
  return linhas.join("\n");
}

export interface Sincronizador {
  /** Rodada automática (agendada): sincroniza todos e avisa no Telegram só quando há novidade. */
  sincronizarTodos(): Promise<{ conexoes: number; novas: number; confirmadas: number; erros: number }>;
  /** Comando "atualizar" no bot: sincroniza as conexões do usuário e devolve o texto da resposta. */
  sincronizarUsuario(usuarioId: string): Promise<string>;
}

export function criarSincronizador(deps: DependenciasSincronizacao & {
  avisar: (telegramId: string, texto: string) => Promise<void>;
  log: (evento: string, dados?: Record<string, unknown>) => void;
  /** Rodadas automáticas mais próximas que isso são puladas (protege a URL pública). */
  intervaloMinimoMin?: number;
}): Sincronizador {
  const intervalo = (deps.intervaloMinimoMin ?? 10) * 60_000;

  async function uma(conexao: ConexaoBanco): Promise<ResultadoSincronizacao | string> {
    try {
      return await sincronizarConexao(conexao, deps);
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e);
      deps.log("erro_sincronizacao", { itemId: conexao.itemId, erro });
      await deps.repo.registrarSincronizacao(conexao.id, {
        instituicao: conexao.instituicao,
        status: null,
        consentimentoExpiraEm: null,
        erro: erro.slice(0, 500),
      }).catch(() => {});
      return erro;
    }
  }

  return {
    async sincronizarTodos() {
      const total = { conexoes: 0, novas: 0, confirmadas: 0, erros: 0 };
      const hoje = hojeNoFuso("America/Sao_Paulo", deps.agora());
      for (const c of await deps.repo.listarConexoes()) {
        if (c.ultimaSincronizacao && deps.agora().getTime() - Date.parse(c.ultimaSincronizacao) < intervalo) continue;
        total.conexoes++;
        const r = await uma(c);
        if (typeof r === "string") {
          total.erros++;
          continue;
        }
        total.novas += r.novas.length;
        total.confirmadas += r.confirmadas;
        const texto = textoSincronizacao(r, hoje);
        if (texto && c.telegramId) await deps.avisar(c.telegramId, texto).catch(() => {});
      }
      return total;
    },

    async sincronizarUsuario(usuarioId) {
      const conexoes = await deps.repo.listarConexoes(usuarioId);
      if (!conexoes.length) {
        return "🏦 Nenhum banco conectado ainda. Conecte no Meu Pluggy e me mande o itemId do painel da Pluggy.";
      }
      const hoje = hojeNoFuso("America/Sao_Paulo", deps.agora());
      const partes: string[] = [];
      for (const c of conexoes) {
        const r = await uma(c);
        partes.push(typeof r === "string"
          ? `⚠️ Não consegui ler o ${c.instituicao ?? "banco"} agora. Tento de novo na próxima rodada.`
          : textoSincronizacao(r, hoje, true)!);
      }
      return partes.join("\n\n");
    },
  };
}
