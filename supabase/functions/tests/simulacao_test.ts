// Simulação de compra ("vou comprar um ar de 500 em 3x, quanto compromete?"), previsão e renda.
import assert from "node:assert/strict";
import { criarInterpretadorHibrido } from "../_shared/interpretador_hibrido.ts";
import { calcularBase } from "../_shared/previsao.ts";
import { processarMensagem } from "../_shared/processador.ts";
import { criarDeps, mensagem, type RepoMemoria } from "./fakes.ts";

// Hoje nos testes: sábado, 07/11/2026.
function cenario() {
  const r = criarDeps();
  r.deps.interpretador = criarInterpretadorHibrido(null, () => {});
  const enviar = async (texto: string) => {
    await processarMensagem(mensagem(texto), r.deps);
    return r.enviadas[r.enviadas.length - 1].texto;
  };
  return { ...r, enviar };
}

/** Um lançamento antigo, como se tivesse vindo do banco. */
function lancar(repo: RepoMemoria, tipo: "despesa" | "receita", centavos: number, data: string, descricao = "x") {
  return repo.inserirTransacoes([{
    usuarioId: "u1",
    origem: "telegram",
    contaId: "c-itau",
    categoriaId: null,
    mensagemId: "antiga",
    tipo,
    descricao,
    estabelecimento: null,
    valorCentavos: centavos,
    dataTransacao: data,
    dataPagamento: data,
    parcelaNumero: null,
    parcelaTotal: null,
    grupoParcelamento: null,
  }]);
}

Deno.test("simula a compra parcelada: parcela, % da renda, mês a mês com as parcelas que já existem", async () => {
  const c = cenario();
  await lancar(c.repo, "receita", 500000, "2026-10-01", "Salário");
  await lancar(c.repo, "despesa", 300000, "2026-10-15", "Mercado e contas");
  await c.enviar("tv 1200 em 12x no nubank"); // 100 por mês, a partir da fatura de 10/12
  const antes = c.repo.transacoes.length;

  const r = await c.enviar("vou comprar um ar de 500 reais em 3x no nubank quanto isso irá comprometer a renda");
  assert.equal(c.repo.transacoes.length, antes, "simular não grava nada");
  assert.match(r, /Simulação: Ar — R\$ 500,00 em 3x de R\$ 166,66/);
  assert.match(r, /Nubank crédito: parcelas de dez\/26 a fev\/27/);
  assert.match(r, /Renda: \*R\$ 5\.000,00\*\/mês _\(média do que entrou em outubro\)_/);
  assert.match(r, /Gasto do dia a dia: \*R\$ 3\.000,00\*\/mês/);
  assert.match(r, /dez\/26: parcelas R\$ 266,68 \(5,3% da renda\) · sobra \*R\$ 1\.733,32\*/);
  assert.match(r, /jan\/27: parcelas R\$ 266,66/);
  assert.match(r, /compromete \*3,3% da renda\* por 3 meses/);
  assert.match(r, /✅ \*Cabe:\* sobra pelo menos R\$ 1\.733,32 por mês/);
  assert.match(r, /Responda \*sim\*/);

  // "sim" registra a compra que foi simulada.
  const registro = await c.enviar("sim");
  assert.match(registro, /Registrado:\*? R\$ 500,00 em 3x/);
  assert.equal(c.repo.transacoes.length, antes + 3);
  assert.ok(c.repo.transacoes.slice(-3).every((t) => t.contaId === "c-nu"));
});

Deno.test("quando o gasto já passa da renda, diz que não cabe e por quê", async () => {
  const c = cenario();
  await lancar(c.repo, "receita", 262046, "2026-10-02");
  await lancar(c.repo, "despesa", 313380, "2026-10-20");
  const r = await c.enviar("posso gastar 300 num tênis?");
  assert.match(r, /Simulação: Tênis — R\$ 300,00 à vista/);
  assert.match(r, /Mesmo sem essa compra, o gasto do dia a dia \(R\$ 3\.133,80\) já passa do que entra \(R\$ 2\.620,46\)/);
  assert.match(r, /❌ \*Não cabe no ritmo atual:\* em nov\/26 faltariam R\$ 813,34/);
  assert.equal(await c.enviar("não"), "👍 Ok, não registrei. Quando comprar, é só me mandar.");
});

Deno.test("sem renda conhecida, pergunta a renda e refaz a simulação com a resposta", async () => {
  const c = cenario();
  await lancar(c.repo, "despesa", 200000, "2026-10-01");
  const pergunta = await c.enviar("se eu comprar uma geladeira de 3000 em 10x cabe?");
  assert.match(pergunta, /preciso da sua renda/);
  const r = await c.enviar("4500");
  assert.equal(c.repo.renda, 450000);
  assert.match(r, /Anotei: renda de \*R\$ 4\.500,00\*/);
  assert.match(r, /Simulação: Geladeira — R\$ 3\.000,00 em 10x de R\$ 300,00/);
  assert.match(r, /Renda: \*R\$ 4\.500,00\*\/mês _\(a que você informou\)_/);
  assert.doesNotMatch(r, /minha renda é 4500/, "renda informada não pede para corrigir");
});

Deno.test("renda informada e previsão dos próximos meses", async () => {
  const c = cenario();
  await lancar(c.repo, "receita", 400000, "2026-10-01");
  await lancar(c.repo, "despesa", 250000, "2026-10-12");
  assert.match(await c.enviar("minha renda é 6000"), /Anotei: renda de \*R\$ 6\.000,00\*/);
  assert.match(await c.enviar("meu salário é 5.500"), /R\$ 5\.500,00/);
  assert.equal(c.repo.renda, 550000);
  assert.equal(c.repo.transacoes.length, 2, "renda não vira lançamento");

  await c.enviar("tv 1200 em 12x no nubank");
  const p = await c.enviar("quanto vai sobrar?");
  assert.match(p, /Previsão dos próximos meses/);
  assert.match(p, /nov\/26: parcelas R\$ 0,00 \(0% da renda\) · sobra \*R\$ 3\.000,00\*/);
  assert.match(p, /dez\/26: parcelas R\$ 100,00 \(1,8% da renda\) · sobra \*R\$ 2\.900,00\*/);
  assert.match(await c.enviar("previsão"), /Previsão/);
});

Deno.test("frases normais continuam sendo lançamentos", async () => {
  const c = cenario();
  assert.match(await c.enviar("recebi 5000 de salário"), /Receita registrada/);
  assert.match(await c.enviar("ar condicionado 500 em 3x no nubank"), /Registrado:\*? R\$ 500,00 em 3x/);
  assert.equal(c.repo.renda, null);
});

Deno.test("base: só meses que o histórico cobre do começo ao fim", () => {
  const historico = [
    { mes: "2026-09-01", receitas: 33366, gastosAvulsos: 104126, parcelas: 7002 },
    { mes: "2026-10-01", receitas: 262046, gastosAvulsos: 313380, parcelas: 0 },
  ];
  // O banco trouxe a partir de 12/09: setembro está incompleto e fica de fora.
  const b = calcularBase(historico, "2026-09-12", "2026-11-11", null);
  assert.deepEqual(b.meses, ["2026-10-01"]);
  assert.equal(b.renda, 262046);
  assert.equal(b.gastos, 313380);
  assert.equal(calcularBase(historico, "2026-08-01", "2026-11-11", 500000).renda, 500000);
  assert.equal(calcularBase([], null, "2026-11-11", null).gastos, null);
});
