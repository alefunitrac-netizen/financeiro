// Salário CLT: do bruto ao líquido (INSS progressivo, IRRF com a isenção até R$ 5 mil de 2026) e a
// meta de investimento como fatia do líquido. Tudo em centavos.
//
// ATENÇÃO: as tabelas mudam todo ano. Confira com o contracheque; o painel deixa sobrescrever o INSS
// e o IR com os valores dele.

/** INSS 2026, progressivo: [teto da faixa, alíquota]. Acima do último teto não há desconto a mais. */
export const FAIXAS_INSS: [number, number][] = [
  [162_100, 0.075],
  [290_284, 0.09],
  [435_427, 0.12],
  [847_555, 0.14],
];

/** IRRF mensal: [teto da base, alíquota, parcela a deduzir]. */
export const FAIXAS_IRRF: [number, number, number][] = [
  [242_880, 0, 0],
  [282_665, 0.075, 18_216],
  [375_105, 0.15, 39_416],
  [466_468, 0.225, 67_549],
  [Infinity, 0.275, 90_873],
];
export const DEDUCAO_DEPENDENTE = 18_959;
/** Desconto simplificado mensal: usado no lugar das deduções legais quando é maior. */
export const DESCONTO_SIMPLIFICADO = 60_720;
/** Lei 15.270/2025: isenção total até R$ 5.000 e redução decrescente até R$ 7.350 (sobre o rendimento bruto). */
const ISENCAO_ATE = 500_000;
const REDUCAO_ATE = 735_000;

export function calcularInss(bruto: number): number {
  let desconto = 0;
  let anterior = 0;
  for (const [teto, aliquota] of FAIXAS_INSS) {
    if (bruto <= anterior) break;
    desconto += (Math.min(bruto, teto) - anterior) * aliquota;
    anterior = teto;
  }
  return Math.round(desconto);
}

export function calcularIrrf(bruto: number, inss: number, dependentes = 0, pensao = 0): number {
  const legais = inss + dependentes * DEDUCAO_DEPENDENTE + pensao;
  const base = Math.max(0, bruto - Math.max(legais, DESCONTO_SIMPLIFICADO));
  const [, aliquota, deduzir] = FAIXAS_IRRF.find(([teto]) => base <= teto)!;
  let imposto = Math.max(0, base * aliquota - deduzir);
  if (bruto <= ISENCAO_ATE) imposto = 0;
  else if (bruto <= REDUCAO_ATE) imposto = Math.max(0, imposto - (97_862 - 0.133145 * bruto));
  return Math.round(imposto);
}

export interface Desconto {
  nome: string;
  valorCentavos: number;
  /** Último mês descontado ("2027-03"), para parcelas como o empréstimo consignado. Sem ele, é fixo. */
  ateMes?: string | null;
}

/** "2026-11" → "2026-12". */
export function proximoMes(mes: string, n = 1): string {
  const [a, m] = mes.split("-").map(Number);
  const t = a * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

const ativoEm = (d: Desconto, mes: string | undefined) => !mes || !d.ateMes || d.ateMes >= mes;

export interface ConfigRenda {
  /** "clt": calcula INSS e IR a partir do bruto; "manual": você digita os descontos. */
  regime: "clt" | "manual";
  brutoCentavos: number;
  dependentes: number;
  /** Outros descontos do contracheque (vale-transporte, plano de saúde, pensão...). */
  descontos: Desconto[];
  /** Se informados, valem no lugar do cálculo (o que está no contracheque). */
  inssManual: number | null;
  irrfManual: number | null;
  /** Fatia do líquido que vai para investimento, de 0 a 100. */
  metaPercentual: number;
}

export interface Holerite {
  bruto: number;
  inss: number;
  irrf: number;
  outros: Desconto[];
  totalDescontos: number;
  liquido: number;
  /** "calculado" pelas tabelas ou "informado" por você. */
  origemImpostos: "calculado" | "informado";
}

/** Holerite de um mês ("2026-11"); sem mês, conta todos os descontos. Parcela que já terminou não desconta. */
export function calcularHolerite(c: ConfigRenda, mes?: string): Holerite {
  const outros = c.descontos.filter((d) => d.valorCentavos > 0 && ativoEm(d, mes));
  const somaOutros = outros.reduce((a, d) => a + d.valorCentavos, 0);
  if (c.regime === "manual") {
    const inss = c.inssManual ?? 0;
    const irrf = c.irrfManual ?? 0;
    const total = inss + irrf + somaOutros;
    return { bruto: c.brutoCentavos, inss, irrf, outros, totalDescontos: total, liquido: c.brutoCentavos - total, origemImpostos: "informado" };
  }
  const pensao = outros.filter((d) => /pens[aã]o/i.test(d.nome)).reduce((a, d) => a + d.valorCentavos, 0);
  const inss = c.inssManual ?? calcularInss(c.brutoCentavos);
  const irrf = c.irrfManual ?? calcularIrrf(c.brutoCentavos, inss, c.dependentes, pensao);
  const total = inss + irrf + somaOutros;
  return {
    bruto: c.brutoCentavos,
    inss,
    irrf,
    outros,
    totalDescontos: total,
    liquido: c.brutoCentavos - total,
    origemImpostos: c.inssManual !== null || c.irrfManual !== null ? "informado" : "calculado",
  };
}

/** Quanto investir por mês para cumprir a fatia do líquido. */
export function metaMensal(liquido: number, percentual: number): number {
  return Math.round(Math.max(0, liquido) * Math.min(100, Math.max(0, percentual)) / 100);
}

/** Patrimônio após N meses aportando `aporte` por mês a uma taxa mensal (juros compostos). */
export function projetarInvestimento(aporte: number, meses: number, taxaMensal = 0.008, inicial = 0): number[] {
  const saida: number[] = [];
  let saldo = inicial;
  for (let k = 0; k < meses; k++) {
    saldo = saldo * (1 + taxaMensal) + aporte;
    saida.push(Math.round(saldo));
  }
  return saida;
}

export interface MarcoRenda {
  /** Primeiro mês sem o desconto ("2027-04"). */
  mes: string;
  nomes: string[];
  aumento: number;
  liquido: number;
}

/**
 * Como o líquido muda conforme as parcelas terminam: um ponto por mês, de agora até o mês depois da
 * última parcela (no máximo 60 meses), e os marcos em que a renda sobe.
 */
export function rendaAoLongo(c: ConfigRenda, mesAtual: string, maxMeses = 60): { meses: { mes: string; liquido: number }[]; marcos: MarcoRenda[] } {
  const fins = c.descontos.filter((d) => d.ateMes && d.ateMes >= mesAtual && d.valorCentavos > 0).map((d) => d.ateMes!);
  if (!fins.length || c.brutoCentavos <= 0) return { meses: [], marcos: [] };
  const ultimo = fins.sort().at(-1)!;
  const meses: { mes: string; liquido: number }[] = [];
  for (let k = 0, mes = mesAtual; k < maxMeses; k++, mes = proximoMes(mes)) {
    meses.push({ mes, liquido: calcularHolerite(c, mes).liquido });
    if (mes > ultimo) break;
  }
  const marcos: MarcoRenda[] = [];
  for (let i = 1; i < meses.length; i++) {
    const aumento = meses[i].liquido - meses[i - 1].liquido;
    if (aumento > 0) {
      marcos.push({
        mes: meses[i].mes,
        nomes: c.descontos.filter((d) => d.ateMes === meses[i - 1].mes).map((d) => d.nome),
        aumento,
        liquido: meses[i].liquido,
      });
    }
  }
  return { meses, marcos };
}
