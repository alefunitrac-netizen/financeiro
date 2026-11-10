// As mensagens do dia a dia, de ponta a ponta, só com as regras (sem IA).
import assert from "node:assert/strict";
import { criarInterpretadorHibrido } from "../_shared/interpretador_hibrido.ts";
import { processarMensagem } from "../_shared/processador.ts";
import { criarDeps, mensagem } from "./fakes.ts";

function semNubank() {
  const r = criarDeps();
  r.deps.interpretador = criarInterpretadorHibrido(null, () => {});
  r.repo.contas = r.repo.contas.filter((c) => c.id !== "c-nu"); // Nubank ainda não conectado
  const enviar = async (texto: string) => {
    await processarMensagem(mensagem(texto), r.deps);
    return r.enviadas[r.enviadas.length - 1].texto;
  };
  return { ...r, enviar };
}

Deno.test("fatura informada vai para o cartão certo e não soma como despesa", async () => {
  const { repo, enviar } = semNubank();
  const resposta = await enviar("Adicionar fatura Nubank 1547");

  const cartao = repo.contas.find((c) => c.nome === "Cartão Nubank");
  assert.ok(cartao, "criou o Cartão Nubank");
  assert.equal(cartao.tipo, "cartao_credito");
  assert.equal(repo.transacoes.length, 1);
  const f = repo.transacoes[0];
  assert.equal(f.tipo, "pagamento_fatura");
  assert.equal(f.contaId, cartao.id);
  assert.equal(f.valorCentavos, 154700);
  assert.equal(f.categoriaId, null);
  assert.match(resposta, /Fatura registrada:\*? R\$ 1\.547,00 — 💳 Cartão Nubank/);
  assert.match(resposta, /Criei o \*Cartão Nubank\*\./);
  assert.match(resposta, /fatura nubank vence dia 15/);

  // Com os dias do cartão, a fatura ganha vencimento.
  const cfg = await enviar("nubank fecha dia 3 vence dia 10");
  assert.match(cfg, /fecha dia 3, vence dia 10/);
  assert.equal(repo.transacoes[0].dataPagamento, "2026-11-10");

  // Mandar de novo a mesma fatura troca o valor, não soma.
  await enviar("fatura nubank 1600");
  assert.deepEqual(repo.ativas().filter((t) => t.tipo === "pagamento_fatura").map((t) => t.valorCentavos), [160000]);

  const resumo = await enviar("resumo da semana");
  assert.match(resumo, /Nada registrado/); // a fatura não é despesa
  assert.match(resumo, /Faturas a pagar: R\$ 1\.600,00/);
  assert.match(resumo, /Cartão Nubank: R\$ 1\.600,00 · vence 10\/11/);

  // Compra no cartão depois do fechamento: aparece a próxima fatura também.
  await enviar("mercado 100 no nubank");
  assert.match(await enviar("contas"), /Cartão Nubank: R\$ 1\.600,00 · vence 10\/11\n• 💳 Cartão Nubank: R\$ 100,00 · vence 10\/12/);

  await enviar("paguei a fatura do nubank 1600");
  const depois = await enviar("contas");
  assert.ok(!depois.includes("1.600,00"), depois);
  assert.match(depois, /R\$ 100,00 · vence 10\/12/);
});

Deno.test("'foi no Nubank' corrige o último lançamento e cria a conta", async () => {
  const { repo, enviar } = semNubank();
  await enviar("Parcela de 3x 16,78");
  assert.equal(repo.transacoes.length, 3);
  assert.ok(repo.transacoes.every((t) => t.contaId === null));

  const r = await enviar("Foi no Nubank");
  assert.match(r, /Corrigido/);
  const cartao = repo.contas.find((c) => c.nome === "Cartão Nubank")!;
  assert.ok(repo.ativas().every((t) => t.contaId === cartao.id));

  // "em qual banco foi?" mostra o último registro
  assert.match(await enviar("Está parcela foi em qual banco"), /Último registro:[\s\S]*Cartão Nubank/);

  // Dias do cartão: as parcelas ganham a fatura de cada mês.
  await enviar("nubank fecha dia 3 vence dia 10");
  assert.deepEqual(repo.ativas().map((t) => t.dataPagamento), ["2026-12-10", "2027-01-10", "2027-02-10"]);

  // "foi no débito": mesmo banco, outra conta.
  await enviar("almoço 30 no nubank");
  await enviar("foi no débito");
  const debito = repo.contas.find((c) => c.nome === "Nubank")!;
  assert.equal(debito.tipo, "corrente");
  assert.equal(repo.ativas().at(-1)!.contaId, debito.id);
});

Deno.test("resumo separa por conta, por categoria e mostra as faturas", async () => {
  const { enviar } = semNubank();
  await enviar("almoço 35 no itaú");
  await enviar("mercado 120 no nubank");
  await enviar("uber 20");
  await enviar("nubank fecha dia 3 vence dia 10");

  const r = await enviar("resumo da semana");
  assert.match(r, /💸 \*Despesas: R\$ 175,00\*/);
  assert.match(r, /_Por conta_\n• 💳 Cartão Nubank: R\$ 120,00 \(69%\)\n• 🏦 Itaú: R\$ 35,00 \(20%\)\n• ❔ Sem conta: R\$ 20,00 \(11%\)/);
  assert.match(r, /_Por categoria_\n• Mercado: R\$ 120,00/);
  assert.match(r, /Faturas a pagar: R\$ 120,00\*\n• 💳 Cartão Nubank: R\$ 120,00 · vence 10\/12 _\(compras até agora\)_/);

  const nu = await enviar("quanto gastei no nubank?");
  assert.match(nu, /Cartão Nubank — novembro\/2026/);
  assert.match(nu, /Despesas: R\$ 120,00/);
  assert.ok(!nu.includes("Itaú"));

  assert.match(await enviar("Por banco"), /_Por conta_/);
  const contas = await enviar("contas");
  assert.match(contas, /Suas contas/);
  assert.match(contas, /Cartão Nubank: _cadastrada por você_ · fecha 3, vence 10/);
});
