// Previsão e simulação: "vou comprar um ar de 500 em 3x, quanto compromete?", "quanto vai sobrar?".
// Base: a renda (a que você informou, ou a média do que entrou) e o gasto do dia a dia (média dos
// meses completos, sem parcelas). Por mês: renda − gasto do dia a dia − parcelas = o que sobra.
import { somarDias, somarMeses } from "./datas.ts";
import { formatarReais } from "./dinheiro.ts";
import type { Conta, DataISO, MesFluxo } from "./tipos.ts";

const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MESES_LONGOS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

export const inicioDoMes = (d: DataISO) => `${d.slice(0, 7)}-01`;
export const rotuloMes = (mes: DataISO) => `${MESES_CURTOS[Number(mes.slice(5, 7)) - 1]}/${mes.slice(2, 4)}`;
const nomeMes = (mes: DataISO) => MESES_LONGOS[Number(mes.slice(5, 7)) - 1];
const porcento = (parte: number, todo: number) => `${((parte / todo) * 100).toFixed(1).replace(".", ",").replace(",0", "")}%`;

/** Quantos meses completos (no máximo) entram na média. */
const MESES_BASE = 3;
/** Parcelas acima disso (fatia da renda) começam a apertar. É a regra usada por bancos no crédito. */
const LIMITE_PARCELAS = 0.3;

export interface Base {
  renda: number | null;
  rendaInformada: boolean;
  /** Gasto do dia a dia por mês, sem parcelas. Null sem nenhum mês completo de histórico. */
  gastos: number | null;
  /** Meses usados na média (YYYY-MM-01). */
  meses: DataISO[];
}

/**
 * Média dos últimos meses completos que o histórico cobre do começo ao fim (o banco traz só 60 dias:
 * um mês que começa antes do primeiro lançamento ficaria incompleto e puxaria a média para baixo).
 */
export function calcularBase(
  historico: MesFluxo[],
  primeiraData: DataISO | null,
  hoje: DataISO,
  rendaInformada: number | null,
): Base {
  const atual = inicioDoMes(hoje);
  const meses = Array.from({ length: MESES_BASE }, (_, k) => somarMeses(atual, -(k + 1)))
    .filter((m) => primeiraData !== null && primeiraData <= somarDias(m, 3))
    .sort();
  const linhas = meses.map((m) => historico.find((h) => h.mes === m) ?? { mes: m, receitas: 0, gastosAvulsos: 0, parcelas: 0 });
  const media = (f: (l: MesFluxo) => number) =>
    linhas.length ? Math.round(linhas.reduce((a, l) => a + f(l), 0) / linhas.length) : null;
  const receitas = media((l) => l.receitas);
  return {
    renda: rendaInformada ?? (receitas || null),
    rendaInformada: rendaInformada !== null,
    gastos: media((l) => l.gastosAvulsos),
    meses,
  };
}

export interface LinhaProjecao {
  mes: DataISO;
  /** Parcelas que você já tem nesse mês. */
  existentes: number;
  /** Parcela da compra simulada nesse mês. */
  nova: number;
  /** Renda − gasto do dia a dia − parcelas. Null sem histórico de gastos. */
  sobra: number | null;
}

export function projetar(base: Base, historico: MesFluxo[], meses: DataISO[], novas: Map<DataISO, number>): LinhaProjecao[] {
  return meses.map((mes) => {
    const existentes = historico.find((h) => h.mes === mes)?.parcelas ?? 0;
    const nova = novas.get(mes) ?? 0;
    const sobra = base.renda !== null && base.gastos !== null ? base.renda - base.gastos - existentes - nova : null;
    return { mes, existentes, nova, sobra };
  });
}

function linhasBase(base: Base): string[] {
  const periodo = base.meses.length === 1
    ? nomeMes(base.meses[0])
    : `${nomeMes(base.meses[0])} a ${nomeMes(base.meses[base.meses.length - 1])}`;
  const linhas = [
    `💰 Renda: *${formatarReais(base.renda!)}*/mês ${
      base.rendaInformada ? "_(a que você informou)_" : `_(média do que entrou em ${periodo})_`
    }`,
  ];
  linhas.push(
    base.gastos !== null
      ? `💸 Gasto do dia a dia: *${formatarReais(base.gastos)}*/mês _(média de ${periodo}, sem parcelas)_`
      : "💸 Gasto do dia a dia: _ainda não tenho um mês inteiro de histórico_",
  );
  return linhas;
}

function linhaMes(l: LinhaProjecao, renda: number): string {
  const parcelas = l.existentes + l.nova;
  const partes = [`parcelas ${formatarReais(parcelas)} (${porcento(parcelas, renda)} da renda)`];
  if (l.sobra !== null) partes.push(`${l.sobra >= 0 ? "sobra" : "falta"} *${formatarReais(Math.abs(l.sobra))}*`);
  return `• ${rotuloMes(l.mes)}: ${partes.join(" · ")}`;
}

/** Cabe, aperta ou não cabe, olhando o pior mês. */
function veredito(base: Base, linhas: LinhaProjecao[], comCompra: boolean): string {
  const renda = base.renda!;
  const folgaSemCompra = base.gastos !== null ? renda - base.gastos : null;
  const piorParcelas = Math.max(...linhas.map((l) => l.existentes + l.nova));
  const sobras = linhas.map((l) => l.sobra).filter((s): s is number => s !== null);
  const pior = sobras.length ? Math.min(...sobras) : null;
  const mesPior = linhas.find((l) => l.sobra === pior);
  const linhas_: string[] = [];

  if (folgaSemCompra !== null && folgaSemCompra <= 0) {
    linhas_.push(
      `⚠️ Mesmo sem ${comCompra ? "essa compra" : "nada novo"}, o gasto do dia a dia (${formatarReais(base.gastos!)}) ` +
        `já passa do que entra (${formatarReais(renda)}).`,
    );
  }
  if (pior !== null && pior < 0) {
    linhas_.push(
      comCompra
        ? `❌ *Não cabe no ritmo atual:* em ${rotuloMes(mesPior!.mes)} faltariam ${formatarReais(-pior)}.`
        : `❌ *No ritmo atual, ${rotuloMes(mesPior!.mes)} fecha no vermelho* (falta ${formatarReais(-pior)}).`,
    );
  } else if (piorParcelas / renda > LIMITE_PARCELAS || (pior !== null && pior < renda * 0.1)) {
    linhas_.push(
      comCompra
        ? `⚠️ *Cabe, mas aperta:* ${
          piorParcelas / renda > LIMITE_PARCELAS
            ? `as parcelas passam de 30% da renda (${porcento(piorParcelas, renda)})`
            : `sobra pouco (${formatarReais(pior!)} no pior mês)`
        }.`
        : `⚠️ *Sobra pouco:* ${formatarReais(pior!)} no pior mês.`,
    );
  } else if (pior !== null) {
    linhas_.push(
      comCompra
        ? `✅ *Cabe:* sobra pelo menos ${formatarReais(pior)} por mês.`
        : `✅ Sobra pelo menos ${formatarReais(pior)} por mês.`,
    );
  } else if (comCompra) {
    linhas_.push(`ℹ️ As parcelas ficam em ${porcento(piorParcelas, renda)} da renda no pior mês (até 30% é o saudável).`);
  }
  return linhas_.join("\n");
}

export interface CompraSimulada {
  descricao: string;
  valores: number[];
  conta: Conta | null;
  /** Mês em que cada parcela é paga (YYYY-MM-01). */
  meses: DataISO[];
  /** Vencimento da 1ª parcela, quando é no cartão com dias cadastrados. */
  primeiroVencimento: DataISO | null;
}

export function textoSimulacao(c: CompraSimulada, base: Base, linhas: LinhaProjecao[], comprometeRenda: number): string {
  const total = c.valores.reduce((a, b) => a + b, 0);
  const n = c.valores.length;
  const parcela = c.valores[n - 1];
  const cabecalho = n > 1
    ? `🧮 *Simulação: ${c.descricao} — ${formatarReais(total)} em ${n}x de ${formatarReais(parcela)}*`
    : `🧮 *Simulação: ${c.descricao} — ${formatarReais(total)} à vista*`;
  const partes = [cabecalho];
  if (c.conta) {
    const quando = n > 1
      ? `parcelas de ${rotuloMes(c.meses[0])} a ${rotuloMes(c.meses[n - 1])}`
      : `paga em ${rotuloMes(c.meses[0])}`;
    partes.push(`${c.conta.tipo === "cartao_credito" ? "💳" : "🏦"} ${c.conta.nome}: ${quando}.`);
  }
  partes.push("", ...linhasBase(base), "", "*Mês a mês*", ...linhas.map((l) => linhaMes(l, base.renda!)));
  partes.push(
    "",
    `📌 ${n > 1 ? "A parcela" : "A compra"} compromete *${porcento(comprometeRenda, base.renda!)} da renda*${
      n > 1 ? ` por ${n} meses` : ""
    }.`,
  );
  const v = veredito(base, linhas, true);
  if (v) partes.push(v);
  partes.push("", "_Quer registrar essa compra? Responda *sim*._");
  if (!base.rendaInformada) partes.push("_Renda diferente? Responda: minha renda é 4500._");
  return partes.join("\n");
}

export function textoPrevisao(base: Base, linhas: LinhaProjecao[]): string {
  const partes = ["🔮 *Previsão dos próximos meses*", "", ...linhasBase(base), "", "*Mês a mês*"];
  partes.push(...linhas.map((l) => linhaMes(l, base.renda!)));
  const v = veredito(base, linhas, false);
  if (v) partes.push("", v);
  partes.push("", "_Simule uma compra: vou comprar uma tv de 2000 em 10x, cabe?_");
  if (!base.rendaInformada) partes.push("_Renda diferente? Responda: minha renda é 4500._");
  return partes.join("\n");
}

export const TEXTO_PEDIR_RENDA =
  "💰 Para ver quanto isso compromete, preciso da sua renda por mês. _Responda só o valor, ex.: 4500._";

export function textoRendaAnotada(centavos: number): string {
  return `💰 Anotei: renda de *${formatarReais(centavos)}* por mês. Uso nas simulações ` +
    "(_vou comprar uma tv de 2000 em 10x, cabe?_) e na _previsão_.";
}
