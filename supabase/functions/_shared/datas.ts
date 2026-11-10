// Datas de calendário (YYYY-MM-DD), sempre sem hora. Toda conta é feita em UTC
// para não sofrer com horário de verão; o fuso do usuário só entra para saber "que dia é hoje".
import type { DataISO, Periodo } from "./tipos.ts";

const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const DIAS_SEMANA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

function partes(data: DataISO): [number, number, number] {
  const [a, m, d] = data.split("-").map(Number);
  return [a, m, d];
}

function montar(ano: number, mes: number, dia: number): DataISO {
  return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function paraUTC(data: DataISO): Date {
  const [a, m, d] = partes(data);
  return new Date(Date.UTC(a, m - 1, d));
}

function deUTC(dt: Date): DataISO {
  return montar(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function diasNoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

export function dataValida(s: unknown): s is DataISO {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = partes(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= diasNoMes(a, m);
}

/** Que dia é hoje no fuso do usuário. */
export function hojeNoFuso(fuso: string, agora: Date = new Date()): DataISO {
  // en-CA formata como YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
}

export function diaDaSemana(data: DataISO): string {
  return DIAS_SEMANA[paraUTC(data).getUTCDay()];
}

export function somarDias(data: DataISO, dias: number): DataISO {
  const dt = paraUTC(data);
  dt.setUTCDate(dt.getUTCDate() + dias);
  return deUTC(dt);
}

/**
 * Soma meses mantendo o dia (ou `diaAlvo`), limitado ao último dia do mês:
 * 31/01 + 1 mês = 28/02 (ou 29/02 em ano bissexto).
 */
export function somarMeses(data: DataISO, meses: number, diaAlvo?: number): DataISO {
  const [a, m, d] = partes(data);
  const total = a * 12 + (m - 1) + meses;
  const ano = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  return montar(ano, mes, Math.min(diaAlvo ?? d, diasNoMes(ano, mes)));
}

/** Primeira data com o dia `dia` (limitado ao fim do mês) estritamente depois de `data`. */
function proximoDia(data: DataISO, dia: number): DataISO {
  const [a, m] = partes(data);
  const candidata = montar(a, m, Math.min(dia, diasNoMes(a, m)));
  return candidata > data ? candidata : somarMeses(montar(a, m, 1), 1, dia);
}

/** Primeira data com o dia `dia` (limitado ao fim do mês) a partir de `data`, contando ela mesma. */
export function proximaDataComDia(data: DataISO, dia: number): DataISO {
  return proximoDia(somarDias(data, -1), dia);
}

/**
 * Vencimento da fatura em que cai uma compra no cartão.
 * Convenção dos bancos brasileiros: compra feita NO dia do fechamento já vai para a
 * próxima fatura (por isso o dia do fechamento é o "melhor dia de compra").
 */
export function vencimentoFatura(dataCompra: DataISO, diaFechamento: number, diaVencimento: number): DataISO {
  const fechamento = proximoDia(dataCompra, diaFechamento);
  return proximoDia(fechamento, diaVencimento);
}

export function intervaloDoPeriodo(
  periodo: Periodo,
  hoje: DataISO,
): { inicio: DataISO; fim: DataISO; rotulo: string } {
  const [a, m] = partes(hoje);
  switch (periodo) {
    case "hoje":
      return { inicio: hoje, fim: hoje, rotulo: "hoje" };
    case "ontem": {
      const ontem = somarDias(hoje, -1);
      return { inicio: ontem, fim: ontem, rotulo: "ontem" };
    }
    case "semana": {
      // Semana começa na segunda-feira.
      const dow = paraUTC(hoje).getUTCDay();
      const inicio = somarDias(hoje, -((dow + 6) % 7));
      return { inicio, fim: hoje, rotulo: "esta semana" };
    }
    case "mes_atual":
      return { inicio: montar(a, m, 1), fim: montar(a, m, diasNoMes(a, m)), rotulo: `${MESES[m - 1]}/${a}` };
    case "mes_anterior": {
      const ref = somarMeses(montar(a, m, 1), -1);
      const [pa, pm] = partes(ref);
      return { inicio: ref, fim: montar(pa, pm, diasNoMes(pa, pm)), rotulo: `${MESES[pm - 1]}/${pa}` };
    }
  }
}

/** "hoje", "ontem", "05/11" ou "05/11/2025" (quando é de outro ano). */
export function dataAmigavel(data: DataISO, hoje: DataISO): string {
  if (data === hoje) return "hoje";
  if (data === somarDias(hoje, -1)) return "ontem";
  const [a, m, d] = partes(data);
  const base = `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
  return a === partes(hoje)[0] ? base : `${base}/${a}`;
}
