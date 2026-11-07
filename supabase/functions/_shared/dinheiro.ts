// Dinheiro é sempre inteiro em centavos. Nada de float em conta financeira:
// 0.1 + 0.2 !== 0.3, e em um ano de lançamentos esse erro aparece no saldo.

/** Limite de sanidade: R$ 10 bilhões. Acima disso é erro de digitação/interpretação. */
const MAXIMO_CENTAVOS = 1_000_000_000_000;

/**
 * Converte um valor em texto para centavos.
 * Aceita "47.90", "47,90", "1.234,56", "1,234.56", "R$ 47", "1234".
 * Retorna null para valores inválidos, zero ou negativos.
 */
export function paraCentavos(texto: string): number | null {
  const s = texto.trim().replace(/^R\$/i, "").replace(/\s+/g, "");
  if (!/^[0-9]+([.,][0-9]+)*$/.test(s)) return null;

  const ultimoSeparador = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let inteiros = s;
  let decimais = "";
  if (ultimoSeparador >= 0) {
    const depois = s.slice(ultimoSeparador + 1);
    // 1 ou 2 dígitos depois do último separador => é a parte decimal.
    // 3 dígitos => separador de milhar ("1.234" = mil duzentos e trinta e quatro).
    if (depois.length <= 2) {
      inteiros = s.slice(0, ultimoSeparador);
      decimais = depois;
    } else if (depois.length !== 3) {
      return null;
    }
  }
  inteiros = inteiros.replace(/[.,]/g, "");
  if (inteiros === "") inteiros = "0";

  const centavos = Number(inteiros) * 100 + Number(decimais.padEnd(2, "0"));
  if (!Number.isSafeInteger(centavos) || centavos <= 0 || centavos > MAXIMO_CENTAVOS) return null;
  return centavos;
}

/** 123456 -> "R$ 1.234,56" */
export function formatarReais(centavos: number): string {
  const negativo = centavos < 0;
  const abs = Math.abs(centavos);
  const reais = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cents = (abs % 100).toString().padStart(2, "0");
  return `${negativo ? "-" : ""}R$ ${reais},${cents}`;
}

/**
 * Divide um total em N parcelas inteiras. A diferença de arredondamento
 * fica na primeira parcela, como fazem os bancos: 100,00 em 3x = 33,34 + 33,33 + 33,33.
 */
export function dividirEmParcelas(totalCentavos: number, parcelas: number): number[] {
  if (!Number.isInteger(parcelas) || parcelas < 1) throw new RangeError("parcelas inválidas");
  if (totalCentavos < parcelas) throw new RangeError("total menor que o número de parcelas");
  const base = Math.floor(totalCentavos / parcelas);
  const resto = totalCentavos - base * parcelas;
  return Array.from({ length: parcelas }, (_, i) => (i === 0 ? base + resto : base));
}
