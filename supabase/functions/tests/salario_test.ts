import assert from "node:assert/strict";
import { calcularHolerite, calcularInss, calcularIrrf, metaMensal, projetarInvestimento } from "../_shared/salario.ts";

const clt = (bruto: number, extra: Partial<Parameters<typeof calcularHolerite>[0]> = {}) =>
  calcularHolerite({ regime: "clt", brutoCentavos: bruto, dependentes: 0, descontos: [], inssManual: null, irrfManual: null, metaPercentual: 10, ...extra });

Deno.test("INSS é progressivo por faixa e tem teto", () => {
  assert.equal(calcularInss(162_100), 12_158); // 7,5% de 1.621,00
  assert.equal(calcularInss(300_000), Math.round(162_100 * 0.075 + (290_284 - 162_100) * 0.09 + (300_000 - 290_284) * 0.12));
  assert.equal(calcularInss(2_000_000), calcularInss(847_555), "acima do teto não desconta mais");
});

Deno.test("IR: isento até R$ 5.000, redução até R$ 7.350, tabela cheia acima", () => {
  assert.equal(calcularIrrf(500_000, calcularInss(500_000)), 0);
  const seis = calcularIrrf(600_000, calcularInss(600_000));
  assert.equal(seis, 38_510); // R$ 385,10 com a redução de 2026
  const dez = calcularIrrf(1_000_000, calcularInss(1_000_000));
  const base = 1_000_000 - calcularInss(1_000_000);
  assert.equal(dez, Math.round(base * 0.275 - 90_873));
  assert.ok(calcularIrrf(600_000, calcularInss(600_000), 2) < seis, "dependente reduz o imposto");
});

Deno.test("holerite: bruto, descontos, líquido; valores do contracheque têm prioridade", () => {
  const h = clt(600_000, { descontos: [{ nome: "Vale-transporte", valorCentavos: 36_000 }, { nome: "Plano de saúde", valorCentavos: 25_000 }] });
  assert.equal(h.inss, calcularInss(600_000));
  assert.equal(h.irrf, 38_510);
  assert.equal(h.totalDescontos, h.inss + h.irrf + 61_000);
  assert.equal(h.liquido, 600_000 - h.totalDescontos);
  assert.equal(h.origemImpostos, "calculado");

  const informado = clt(600_000, { inssManual: 60_000, irrfManual: 40_000 });
  assert.equal(informado.liquido, 500_000);
  assert.equal(informado.origemImpostos, "informado");

  const manual = calcularHolerite({ regime: "manual", brutoCentavos: 800_000, dependentes: 0, descontos: [], inssManual: 0, irrfManual: 120_000, metaPercentual: 0 });
  assert.equal(manual.liquido, 680_000);
});

Deno.test("meta de investimento e projeção com juros compostos", () => {
  assert.equal(metaMensal(450_000, 15), 67_500);
  assert.equal(metaMensal(450_000, 150), 450_000, "limita a 100%");
  const p = projetarInvestimento(100_000, 12, 0);
  assert.equal(p[11], 1_200_000);
  assert.ok(projetarInvestimento(100_000, 12, 0.01)[11] > 1_200_000);
});
