// Painel web: o link de acesso pelo bot e os números do mês.
import assert from "node:assert/strict";
import { criarInterpretadorHibrido } from "../_shared/interpretador_hibrido.ts";
import { hashSegredo, montarPainel, validarFixa, validarRenda } from "../_shared/painel.ts";
import { processarMensagem } from "../_shared/processador.ts";
import { criarDeps, mensagem } from "./fakes.ts";

Deno.test("'painel' manda um link de uso único e 'sair do painel' encerra os acessos", async () => {
  const r = criarDeps();
  r.deps.interpretador = criarInterpretadorHibrido(null, () => {});
  const enviar = async (t: string) => {
    await processarMensagem(mensagem(t), r.deps);
    return r.enviadas.at(-1)!.texto;
  };
  const texto = await enviar("painel");
  const codigo = /painel-financeiro\/#c=([A-Za-z0-9_-]{40,})/.exec(texto)?.[1];
  assert.ok(codigo, texto);
  assert.equal(r.repo.acessosPainel.length, 1);
  assert.equal(r.repo.acessosPainel[0].hash, await hashSegredo(codigo), "só o hash fica guardado");
  assert.equal(r.repo.acessosPainel[0].expiraEm.getTime(), r.deps.agora().getTime() + 15 * 60_000);
  assert.match(await enviar("me manda o link do painel"), /#c=/);
  assert.match(await enviar("sair do painel"), /encerrei o acesso/);
  assert.ok(r.repo.acessosPainel.every((a) => a.revogado));
  assert.equal(r.repo.transacoes.length, 0);
});

Deno.test("painel: limite do mês, gasto por dia, fixas, meta e renda pelo holerite", () => {
  const p = montarPainel({
    nome: "Alef Teste",
    hoje: "2026-11-15",
    mes: "2026-11-01",
    categorias: [
      { tipo: "despesa", categoria: "Mercado", totalCentavos: 80_000, quantidade: 3 },
      { tipo: "despesa", categoria: "Lazer", totalCentavos: 20_000, quantidade: 1 },
      { tipo: "receita", categoria: "Salário", totalCentavos: 400_000, quantidade: 1 },
    ],
    categoriasAnterior: [{ tipo: "despesa", categoria: "Mercado", totalCentavos: 80_000, quantidade: 2 }],
    faturas: [],
    contas: [],
    renda: {
      regime: "manual",
      brutoCentavos: 500_000,
      dependentes: 0,
      descontos: [],
      inssManual: 50_000,
      irrfManual: 50_000,
      metaPercentual: 10,
    },
    rendaInformada: null,
    historico: [],
    primeiraData: "2026-09-01",
    fixas: [
      { id: "f1", nome: "Luz", tipo: "luz", valorCentavos: 15_000, diaVencimento: 20 },
      { id: "f2", nome: "Internet", tipo: "internet", valorCentavos: 10_000, diaVencimento: 5 },
    ],
    aportes: [{ id: "a1", data: "2026-11-05", valorCentavos: 10_000, descricao: null }],
    lancamentos: [
      { data: "2026-11-02", descricao: "Mercado", valorCentavos: 80_000, tipo: "despesa", categoria: "Mercado", conta: null },
      { data: "2026-11-10", descricao: "Show", valorCentavos: 20_000, tipo: "despesa", categoria: "Lazer", conta: null },
    ],
  });
  assert.equal(p.renda.liquido, 400_000);
  assert.equal(p.renda.origem, "holerite");
  assert.equal(p.investimento.metaMensal, 40_000);
  assert.equal(p.investimento.faltaMes, 30_000);
  assert.equal(p.gastos.limite, 360_000);
  assert.equal(p.gastos.diasRestantes, 16);
  assert.equal(p.gastos.porDia, Math.floor((360_000 - 100_000) / 16));
  assert.equal(p.gastos.curva.length, 15);
  assert.equal(p.gastos.curva[14], 100_000);
  assert.equal(p.fixas.total, 25_000);
  assert.equal(p.fixas.fatiaDaRenda, 6.3);
  assert.deepEqual(p.fixas.itens.map((f) => f.proximoVencimento), ["2026-11-20", "2026-12-05"]);
  assert.equal(p.resultado.variacaoSaidas, 25);
});

Deno.test("validação do que o site manda", () => {
  assert.equal(typeof validarRenda({ regime: "clt", brutoCentavos: -1, metaPercentual: 10, descontos: [] }), "string");
  const ok = validarRenda({ regime: "clt", brutoCentavos: 600_000, metaPercentual: 15, descontos: [{ nome: "VT", valorCentavos: 100 }] });
  assert.equal(typeof ok, "object");
  assert.equal(typeof validarFixa({ nome: "Luz", tipo: "bomba", valorCentavos: 100 }), "string");
  assert.deepEqual(validarFixa({ nome: " Luz ", tipo: "luz", valorCentavos: 15000, diaVencimento: 10 }), {
    nome: "Luz",
    tipo: "luz",
    valorCentavos: 15000,
    diaVencimento: 10,
  });
});
