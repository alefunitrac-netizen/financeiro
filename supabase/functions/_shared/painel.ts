// Painel web: monta os números do mês a partir dos dados do banco. Funções puras (testáveis);
// o acesso ao banco fica em painel-api/index.ts.
import { diasNoMes, somarMeses } from "./datas.ts";
import { calcularBase, inicioDoMes, type LinhaProjecao, projetar } from "./previsao.ts";
import { faturasParaMostrar } from "./respostas.ts";
import { calcularHolerite, type ConfigRenda, type Holerite, metaMensal, projetarInvestimento, rendaAoLongo } from "./salario.ts";
import type { DataISO, LinhaFatura, LinhaResumo, MesFluxo } from "./tipos.ts";

// ---------- Acesso ----------

/** SHA-256 em hex: o banco guarda só isso dos códigos e sessões. */
export async function hashSegredo(segredo: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(segredo));
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 bytes aleatórios em base64url (256 bits). */
export function gerarSegredo(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const URL_PAINEL = "https://alefunitrac-netizen.github.io/painel-financeiro/";
export const CODIGO_MINUTOS = 15;
export const SESSAO_DIAS = 90;

// ---------- Dados ----------

export interface DespesaFixa {
  id: string;
  nome: string;
  tipo: string;
  valorCentavos: number;
  diaVencimento: number | null;
}

export interface Aporte {
  id: string;
  data: DataISO;
  valorCentavos: number;
  descricao: string | null;
}

export interface LancamentoPainel {
  data: DataISO;
  descricao: string;
  valorCentavos: number;
  tipo: string;
  categoria: string | null;
  conta: string | null;
}

export interface DadosPainel {
  nome: string;
  hoje: DataISO;
  /** Mês mostrado (YYYY-MM-01). */
  mes: DataISO;
  categorias: LinhaResumo[];
  categoriasAnterior: LinhaResumo[];
  faturas: LinhaFatura[];
  contas: { id?: string; nome: string; tipo: string; saldoCentavos: number | null; limiteCentavos: number | null }[];
  renda: ConfigRenda | null;
  rendaInformada: number | null;
  historico: MesFluxo[];
  primeiraData: DataISO | null;
  fixas: DespesaFixa[];
  aportes: Aporte[];
  lancamentos: LancamentoPainel[];
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const soma = (ls: LinhaResumo[], tipo: string) => ls.filter((l) => l.tipo === tipo).reduce((a, l) => a + l.totalCentavos, 0);

/** Próxima data (a partir de hoje) com esse dia do mês. */
function proximoVencimento(hoje: DataISO, dia: number): DataISO {
  const [a, m] = hoje.split("-").map(Number);
  const noMes = (ano: number, mes: number) =>
    `${ano}-${String(mes).padStart(2, "0")}-${String(Math.min(dia, diasNoMes(ano, mes))).padStart(2, "0")}`;
  if (noMes(a, m) >= hoje) return noMes(a, m);
  const prox = somarMeses(`${a}-${String(m).padStart(2, "0")}-01`, 1);
  return noMes(Number(prox.slice(0, 4)), Number(prox.slice(5, 7)));
}

export function montarPainel(d: DadosPainel) {
  const [ano, mesN] = d.mes.split("-").map(Number);
  const mesAtual = inicioDoMes(d.hoje) === d.mes;
  const entradas = soma(d.categorias, "receita");
  const saidas = soma(d.categorias, "despesa");
  const saidasAnterior = soma(d.categoriasAnterior, "despesa");
  const entradasAnterior = soma(d.categoriasAnterior, "receita");

  // Renda: o holerite que você montou; senão a informada no bot; senão a média do que entrou.
  const mesHoje = d.hoje.slice(0, 7);
  const holerite: Holerite | null = d.renda && d.renda.brutoCentavos > 0 ? calcularHolerite(d.renda, mesHoje) : null;
  const base = calcularBase(d.historico, d.primeiraData, d.hoje, holerite?.liquido ?? d.rendaInformada);
  const liquido = holerite?.liquido ?? base.renda;
  const origemRenda = holerite ? "holerite" : d.rendaInformada !== null ? "informada" : base.renda !== null ? "estimada" : null;

  const metaPercentual = d.renda?.metaPercentual ?? 10;
  const meta = liquido !== null ? metaMensal(liquido, metaPercentual) : null;
  const aportadoMes = d.aportes.filter((a) => inicioDoMes(a.data) === d.mes).reduce((s, a) => s + a.valorCentavos, 0);
  const acumulado = d.aportes.reduce((s, a) => s + a.valorCentavos, 0);

  const fixasTotal = d.fixas.reduce((s, f) => s + f.valorCentavos, 0);
  const porTipo = new Map<string, number>();
  for (const f of d.fixas) porTipo.set(f.tipo, (porTipo.get(f.tipo) ?? 0) + f.valorCentavos);

  // Limite de gastos do mês: o líquido menos o que vai para investimento.
  const limite = liquido !== null && meta !== null ? liquido - meta : null;
  const diasRestantes = mesAtual ? diasNoMes(ano, mesN) - Number(d.hoje.slice(8, 10)) + 1 : 0;
  const porDia = limite !== null && mesAtual && diasRestantes > 0 ? Math.max(0, Math.floor((limite - saidas) / diasRestantes)) : null;

  // Gasto acumulado por dia, para o gráfico do mês.
  const ultimoDia = mesAtual ? Number(d.hoje.slice(8, 10)) : diasNoMes(ano, mesN);
  const porDiaMes = Array(ultimoDia).fill(0);
  for (const l of d.lancamentos) {
    if (l.tipo !== "despesa" || inicioDoMes(l.data) !== d.mes) continue;
    const i = Number(l.data.slice(8, 10)) - 1;
    if (i < ultimoDia) porDiaMes[i] += l.valorCentavos;
  }
  let acumuladoDia = 0;
  const curva = porDiaMes.map((v) => (acumuladoDia += v));

  const previsao: LinhaProjecao[] = base.renda !== null
    ? projetar(base, d.historico, [0, 1, 2].map((k) => somarMeses(inicioDoMes(d.hoje), k)), new Map())
    : [];

  const faturas = faturasParaMostrar(d.faturas);
  return {
    nome: d.nome.split(" ")[0],
    hoje: d.hoje,
    mes: d.mes,
    rotuloMes: `${MESES[mesN - 1]} ${ano}`,
    mesAtual,
    resultado: {
      entradas,
      saidas,
      saldo: entradas - saidas,
      entradasAnterior,
      saidasAnterior,
      variacaoSaidas: saidasAnterior ? Math.round(((saidas - saidasAnterior) / saidasAnterior) * 1000) / 10 : null,
    },
    gastos: { total: saidas, limite, porDia, diasRestantes, curva, diasNoMes: diasNoMes(ano, mesN) },
    categorias: d.categorias.filter((l) => l.tipo === "despesa").sort((a, b) => b.totalCentavos - a.totalCentavos),
    receitas: d.categorias.filter((l) => l.tipo === "receita").sort((a, b) => b.totalCentavos - a.totalCentavos),
    renda: {
      origem: origemRenda,
      liquido,
      holerite,
      config: d.renda,
      /** Líquido mês a mês até as parcelas (consignado etc.) terminarem. */
      futura: d.renda && holerite ? rendaAoLongo(d.renda, mesHoje) : { meses: [], marcos: [] },
    },
    fixas: {
      itens: d.fixas
        .map((f) => ({ ...f, proximoVencimento: f.diaVencimento ? proximoVencimento(d.hoje, f.diaVencimento) : null }))
        .sort((a, b) => (a.proximoVencimento ?? "9999").localeCompare(b.proximoVencimento ?? "9999")),
      total: fixasTotal,
      porTipo: Object.fromEntries(porTipo),
      fatiaDaRenda: liquido ? Math.round((fixasTotal / liquido) * 1000) / 10 : null,
    },
    investimento: {
      percentual: metaPercentual,
      metaMensal: meta,
      aportadoMes,
      faltaMes: meta !== null ? Math.max(0, meta - aportadoMes) : null,
      acumulado,
      projecao12: meta !== null ? projetarInvestimento(meta, 12, 0.008, acumulado) : [],
      aportes: [...d.aportes].sort((a, b) => b.data.localeCompare(a.data)).slice(0, 12),
    },
    faturas: { itens: faturas, total: faturas.reduce((s, f) => s + f.totalCentavos, 0) },
    contas: d.contas,
    previsao: {
      gastoMedio: base.gastos,
      meses: previsao,
    },
    lancamentos: [...d.lancamentos].sort((a, b) => b.data.localeCompare(a.data) || b.valorCentavos - a.valorCentavos).slice(0, 40),
  };
}

export type Painel = ReturnType<typeof montarPainel>;

// ---------- Validação do que o site manda ----------

const inteiro = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

export function validarRenda(b: Record<string, unknown>): ConfigRenda | string {
  const regime = b.regime === "manual" ? "manual" : b.regime === "clt" ? "clt" : null;
  const bruto = inteiro(b.brutoCentavos, 0, 100_000_000);
  const dependentes = inteiro(b.dependentes ?? 0, 0, 20);
  const meta = typeof b.metaPercentual === "number" && b.metaPercentual >= 0 && b.metaPercentual <= 100 ? b.metaPercentual : null;
  const opcional = (v: unknown) => (v === null || v === undefined ? null : inteiro(v, 0, 100_000_000));
  const inss = opcional(b.inssManual);
  const irrf = opcional(b.irrfManual);
  if (!regime || bruto === null || dependentes === null || meta === null) return "dados inválidos";
  if ((b.inssManual != null && inss === null) || (b.irrfManual != null && irrf === null)) return "desconto inválido";
  if (!Array.isArray(b.descontos) || b.descontos.length > 20) return "descontos inválidos";
  const descontos = [];
  for (const x of b.descontos as Record<string, unknown>[]) {
    const nome = typeof x?.nome === "string" ? x.nome.trim().slice(0, 40) : "";
    const valor = inteiro(x?.valorCentavos, 0, 100_000_000);
    const ateMes = x?.ateMes == null || x.ateMes === "" ? null : typeof x.ateMes === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(x.ateMes) ? x.ateMes : undefined;
    if (!nome || valor === null || ateMes === undefined) return "desconto inválido";
    descontos.push(ateMes ? { nome, valorCentavos: valor, ateMes } : { nome, valorCentavos: valor });
  }
  return { regime, brutoCentavos: bruto, dependentes, descontos, inssManual: inss, irrfManual: irrf, metaPercentual: meta };
}

const TIPOS_FIXA = ["luz", "agua", "gas", "internet", "telefone", "assinatura", "moradia", "outro"];

export function validarFixa(b: Record<string, unknown>): Omit<DespesaFixa, "id"> | string {
  const nome = typeof b.nome === "string" ? b.nome.trim().slice(0, 60) : "";
  const tipo = typeof b.tipo === "string" && TIPOS_FIXA.includes(b.tipo) ? b.tipo : null;
  const valor = inteiro(b.valorCentavos, 1, 100_000_000);
  const dia = b.diaVencimento === null || b.diaVencimento === undefined ? null : inteiro(b.diaVencimento, 1, 31);
  if (!nome || !tipo || valor === null) return "dados inválidos";
  if (b.diaVencimento != null && dia === null) return "dia inválido";
  return { nome, tipo, valorCentavos: valor, diaVencimento: dia };
}

export function validarAporte(b: Record<string, unknown>, hoje: DataISO): Omit<Aporte, "id"> | string {
  const valor = inteiro(b.valorCentavos, -100_000_000, 100_000_000);
  const data = typeof b.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.data) ? b.data : hoje;
  const descricao = typeof b.descricao === "string" ? b.descricao.trim().slice(0, 80) || null : null;
  if (!valor) return "valor inválido";
  return { valorCentavos: valor, data, descricao };
}
