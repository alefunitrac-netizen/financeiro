import assert from "node:assert/strict";
import {
  dataAmigavel,
  dataValida,
  diaDaSemana,
  hojeNoFuso,
  intervaloDoPeriodo,
  somarMeses,
  vencimentoFatura,
} from "../_shared/datas.ts";
import { dividirEmParcelas, formatarReais, paraCentavos } from "../_shared/dinheiro.ts";
import { normalizarWhatsapp } from "../_shared/telefone.ts";

Deno.test("paraCentavos entende os formatos brasileiros e o formato da IA", () => {
  assert.equal(paraCentavos("47.90"), 4790);
  assert.equal(paraCentavos("47,90"), 4790);
  assert.equal(paraCentavos("47,9"), 4790);
  assert.equal(paraCentavos("R$ 1.234,56"), 123456);
  assert.equal(paraCentavos("1,234.56"), 123456);
  assert.equal(paraCentavos("1.234"), 123400); // ponto de milhar
  assert.equal(paraCentavos("1500"), 150000);
  assert.equal(paraCentavos("0.05"), 5);
  assert.equal(paraCentavos(" 12 "), 1200);
});

Deno.test("paraCentavos rejeita lixo, zero e negativos", () => {
  for (const v of ["", "abc", "-5", "0", "0,00", "12,3456", "1e5", "R$", "10 reais"]) {
    assert.equal(paraCentavos(v), null, `deveria rejeitar "${v}"`);
  }
  assert.equal(paraCentavos("99999999999"), null); // acima do limite de sanidade
});

Deno.test("formatarReais", () => {
  assert.equal(formatarReais(4790), "R$ 47,90");
  assert.equal(formatarReais(5), "R$ 0,05");
  assert.equal(formatarReais(123456789), "R$ 1.234.567,89");
  assert.equal(formatarReais(-1000), "-R$ 10,00");
});

Deno.test("dividirEmParcelas não perde nem cria centavos", () => {
  assert.deepEqual(dividirEmParcelas(10000, 3), [3334, 3333, 3333]);
  assert.deepEqual(dividirEmParcelas(300000, 12), Array(12).fill(25000));
  for (const [total, n] of [[99999, 7], [101, 10], [1, 1]]) {
    const p = dividirEmParcelas(total, n);
    assert.equal(p.reduce((a, b) => a + b, 0), total);
    assert.equal(p.length, n);
  }
  assert.throws(() => dividirEmParcelas(5, 10));
});

Deno.test("vencimentoFatura segue a regra do melhor dia de compra", () => {
  // Fecha dia 3, vence dia 10
  assert.equal(vencimentoFatura("2026-11-02", 3, 10), "2026-11-10"); // antes do fechamento
  assert.equal(vencimentoFatura("2026-11-03", 3, 10), "2026-12-10"); // no dia do fechamento → próxima
  assert.equal(vencimentoFatura("2026-11-07", 3, 10), "2026-12-10");
  // Fecha dia 25, vence dia 5 do mês seguinte
  assert.equal(vencimentoFatura("2026-11-07", 25, 5), "2026-12-05");
  assert.equal(vencimentoFatura("2026-11-26", 25, 5), "2027-01-05");
  // Virada de ano
  assert.equal(vencimentoFatura("2026-12-20", 3, 10), "2027-01-10");
  // Dia 31 em fevereiro vira o último dia do mês
  assert.equal(vencimentoFatura("2027-02-10", 31, 8), "2027-03-08");
  // 28/02 é o "dia 31" de fevereiro, ou seja, o próprio fechamento → próxima fatura
  assert.equal(vencimentoFatura("2027-02-28", 31, 8), "2027-04-08");
  assert.equal(vencimentoFatura("2027-03-01", 30, 31), "2027-03-31");
});

Deno.test("somarMeses limita ao fim do mês", () => {
  assert.equal(somarMeses("2027-01-31", 1), "2027-02-28");
  assert.equal(somarMeses("2028-01-31", 1), "2028-02-29"); // bissexto
  assert.equal(somarMeses("2026-11-15", 2), "2027-01-15");
  assert.equal(somarMeses("2026-01-15", -1), "2025-12-15");
  assert.equal(somarMeses("2026-11-01", 1, 31), "2026-12-31");
});

Deno.test("hoje respeita o fuso de São Paulo", () => {
  // 01:30 UTC do dia 8 ainda é dia 7 em São Paulo
  assert.equal(hojeNoFuso("America/Sao_Paulo", new Date("2026-11-08T01:30:00Z")), "2026-11-07");
  assert.equal(hojeNoFuso("America/Sao_Paulo", new Date("2026-11-08T03:30:00Z")), "2026-11-08");
  assert.equal(diaDaSemana("2026-11-07"), "sábado");
});

Deno.test("intervalos de período", () => {
  assert.deepEqual(intervaloDoPeriodo("mes_atual", "2026-11-07"), {
    inicio: "2026-11-01",
    fim: "2026-11-30",
    rotulo: "novembro/2026",
  });
  assert.deepEqual(intervaloDoPeriodo("mes_anterior", "2026-01-10"), {
    inicio: "2025-12-01",
    fim: "2025-12-31",
    rotulo: "dezembro/2025",
  });
  // Sábado 07/11 → semana começa na segunda 02/11
  assert.equal(intervaloDoPeriodo("semana", "2026-11-07").inicio, "2026-11-02");
  assert.equal(intervaloDoPeriodo("semana", "2026-11-02").inicio, "2026-11-02");
  assert.equal(intervaloDoPeriodo("semana", "2026-11-08").inicio, "2026-11-02"); // domingo
  assert.equal(intervaloDoPeriodo("ontem", "2026-11-01").inicio, "2026-10-31");
});

Deno.test("datas válidas e amigáveis", () => {
  assert.ok(dataValida("2028-02-29"));
  assert.ok(!dataValida("2027-02-29"));
  assert.ok(!dataValida("2026-13-01"));
  assert.ok(!dataValida("07/11/2026"));
  assert.equal(dataAmigavel("2026-11-07", "2026-11-07"), "hoje");
  assert.equal(dataAmigavel("2026-11-06", "2026-11-07"), "ontem");
  assert.equal(dataAmigavel("2026-12-10", "2026-11-07"), "10/12");
  assert.equal(dataAmigavel("2027-01-10", "2026-11-07"), "10/01/2027");
});

Deno.test("normalizarWhatsapp recoloca o nono dígito de celulares brasileiros", () => {
  assert.equal(normalizarWhatsapp("551187654321"), "5511987654321");
  assert.equal(normalizarWhatsapp("5511987654321"), "5511987654321");
  assert.equal(normalizarWhatsapp("+55 (11) 98765-4321"), "5511987654321");
  assert.equal(normalizarWhatsapp("551133334444"), "551133334444"); // fixo: não mexe
  assert.equal(normalizarWhatsapp("14155550123"), "14155550123"); // outro país
});
