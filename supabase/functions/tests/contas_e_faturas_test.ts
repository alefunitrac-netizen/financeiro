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
  assert.match(resumo, /Nada registrado ainda/); // a fatura não é despesa
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
  assert.match(r, /💸 Saiu: \*R\$ 175,00\*/);
  assert.match(r, /\*Para onde foi\*\n• Mercado: R\$ 120,00\n• Alimentação: R\$ 35,00\n• Transporte: R\$ 20,00/);
  assert.match(r, /\*Por conta\*\n• 💳 Cartão Nubank: saiu R\$ 120,00\n• 🏦 Itaú: saiu R\$ 35,00\n• ❔ Sem conta: saiu R\$ 20,00/);
  assert.match(r, /Faturas a pagar: R\$ 120,00\*\n• 💳 Cartão Nubank: R\$ 120,00 · vence 10\/12 _\(compras até agora\)_/);

  const nu = await enviar("quanto gastei no nubank?");
  assert.match(nu, /Cartão Nubank · novembro\/2026/);
  assert.match(nu, /Saiu: \*R\$ 120,00\*/);
  assert.ok(!nu.includes("Itaú"));

  assert.match(await enviar("Por banco"), /\*Por conta\*/);
  const contas = await enviar("contas");
  assert.match(contas, /Suas contas/);
  assert.match(contas, /• 💳 Cartão Nubank · fecha dia 3, vence dia 10/);
});

Deno.test("desfazer volta a ÚLTIMA ação, na ordem, e as perguntas sobre o cartão são entendidas", async () => {
  const { repo, enviar } = semNubank();
  await enviar("Adicionar fatura Nubank 1547");
  await enviar("Parcela de 3x 16,78");
  await enviar("foi no nubank");
  const cartao = repo.contas.find((c) => c.nome === "Cartão Nubank")!;

  // "Nubank" sozinho mostra o cartão, não mexe em nada.
  const nu = await enviar("Nubank");
  assert.match(nu, /💳 Cartão Nubank/);
  assert.match(nu, /Faturas a pagar: R\$ 1\.547,00/);
  assert.match(nu, /Em que dia o cartão fecha e em que dia vence\?/); // pede os dias do cartão
  assert.ok(!nu.includes("Corrigido"));

  const venc = await enviar("Fatura Nubank vence dia 10");
  assert.match(venc, /Fatura atualizada/);
  const fatura = () => repo.transacoes.find((t) => t.tipo === "pagamento_fatura")!;
  assert.equal(fatura().dataPagamento, "2026-11-10");

  // O desfazer volta o vencimento, não a compra parcelada.
  assert.match(await enviar("Desfazer"), /Desfeito:\* o vencimento da fatura do Cartão Nubank/);
  assert.equal(fatura().dataPagamento, null);
  assert.equal(repo.ativas().filter((t) => t.tipo === "despesa").length, 3);

  // "desfazer vencimento" de novo: o vencimento já foi desfeito, então avisa em vez de desfazer outra coisa.
  assert.match(await enviar("Desafazer vencimento"), /A última coisa que fiz foi a correção de R\$ 50,34/);
  assert.ok(repo.ativas().filter((t) => t.tipo === "despesa").every((t) => t.contaId === cartao.id));
  // Com erro de digitação e sem alvo: volta a correção de conta ("foi no nubank").
  assert.match(await enviar("desfaze"), /Desfeito:\* a correção de R\$ 50,34 — Compra parcelada \(3 parcelas\)/);
  assert.ok(repo.ativas().filter((t) => t.tipo === "despesa").every((t) => t.contaId === null));

  // E de novo: agora sim a compra parcelada.
  assert.match(await enviar("desfazer"), /Desfeito:\* R\$ 50,34 — Compra parcelada \(3 parcelas\)/);
  assert.equal(repo.ativas().filter((t) => t.tipo === "despesa").length, 0);
  assert.equal(fatura().status, "informado"); // a fatura continua

  const vn = await enviar("Vencimento Nubank");
  assert.match(vn, /^💳 \*Cartão Nubank\* · sem dias de fechamento e vencimento/);
  assert.match(vn, /vencimento a definir/);
  assert.match(await enviar("quando vence a fatura do nubank?"), /Cartão Nubank/);

  // Dias do cartão também se desfazem, e as datas calculadas voltam.
  await enviar("nubank fecha dia 3 vence dia 10");
  assert.equal(fatura().dataPagamento, "2026-11-10");
  assert.match(await enviar("desfazer"), /os dias de fechamento e vencimento do Cartão Nubank/);
  assert.equal(repo.contas.find((c) => c.id === cartao.id)!.diaFechamento, null);
  assert.equal(fatura().dataPagamento, null);

  // Fatura informada de novo troca o valor; desfazer traz a anterior de volta.
  await enviar("fatura nubank 1600");
  assert.deepEqual(repo.ativas().filter((t) => t.tipo === "pagamento_fatura").map((t) => t.valorCentavos), [160000]);
  await enviar("desfazer");
  assert.deepEqual(repo.ativas().filter((t) => t.tipo === "pagamento_fatura").map((t) => t.valorCentavos), [154700]);
});

Deno.test("resumo do jeito do Alef: Outros mostra o que tem dentro; 'o que são outros'; 'roberto é moradia'", async () => {
  const { repo, enviar } = semNubank();
  await enviar("pix roberto augusto 2110");
  await enviar("pix larissa 12");
  await enviar("pix larissa 12");
  await enviar("almoço 35 em dinheiro");
  await enviar("recebi 2146,51 de salário no itaú");

  const r = await enviar("/resumo");
  assert.match(r, /\*Para onde foi\*\n• Outros: R\$ 2\.134,00\n {3}_Pix roberto augusto R\$ 2\.110,00; Pix larissa R\$ 12,00_\n• Alimentação: R\$ 35,00/);
  assert.match(r, /\*Por conta\*\n• 🏦 Itaú: entrou R\$ 2\.146,51\n• ❔ Sem conta: saiu R\$ 2\.134,00\n• 💵 Dinheiro: saiu R\$ 35,00/);
  assert.match(r, /o que é outros\?/);
  assert.doesNotMatch(r, /%/);

  for (const t of ["O que são outros", "Outros", "o que tem em outros?"]) {
    const o = await enviar(t);
    assert.match(o, /📂 \*Outros\* · novembro\/2026: \*R\$ 2\.134,00\* \(3 lançamentos\)\n• R\$ 2\.110,00 — Pix roberto augusto/, t);
    assert.match(o, /❓ \*Pix roberto augusto\* \(R\$ 2\.110,00\) é de qual categoria\?/, t);
  }

  const c = await enviar("roberto é moradia");
  assert.match(c, /o que tiver \*roberto\* vai para \*Moradia\*/);
  assert.match(c, /Mudei 1 lançamento \(R\$ 2\.110,00\)/);
  assert.match(await enviar("/resumo"), /• Moradia: R\$ 2\.110,00/);

  // Vale para os próximos, e desfazer volta tudo.
  await enviar("pix roberto 300");
  assert.equal(repo.ativas().at(-1)!.categoriaId, "k-moradia");
  await enviar("desfazer"); // o pix de 300
  assert.match(await enviar("desfazer"), /Desfeito:\* a regra "roberto" → Moradia/);
  assert.equal(repo.ativas().find((t) => t.valorCentavos === 211000)!.categoriaId, "k-outros");
  assert.equal(repo.regras[0].ativa, false);

  // "Alterar vencimento Nubank dia 10" ajusta a fatura.
  await enviar("fatura nubank 1547");
  assert.match(await enviar("Alterar vencimento Nubank dia 10"), /Fatura atualizada[\s\S]*Vence 10\/11/);
});

Deno.test("o bot lembra da pergunta que fez: respostas curtas", async () => {
  const { repo, enviar } = semNubank();

  // Gasto sem valor → "Quanto foi?" → "35 no itaú"
  assert.match(await enviar("almocei fora"), /Quanto foi \*almocei fora\*\?/);
  assert.match(await enviar("35 no itaú"), /Registrado:\* R\$ 35,00 — Almocei fora[\s\S]*Alimentação · 🏦 Itaú/);

  // Cartão novo sem dias → "Em que dia fecha e vence?" → "3 e 10"
  assert.match(await enviar("tênis 300 em 3x no nubank"), /Em que dia o cartão fecha/);
  assert.match(await enviar("3 e 10"), /Cartão Nubank\*: fecha dia 3, vence dia 10/);
  assert.equal(repo.contas.find((c) => c.nome === "Cartão Nubank")!.diaVencimento, 10);

  // "Alterar vencimento Nubank" → "Qual o novo vencimento?" → "Dia 10" (exatamente o que deu errado antes)
  await enviar("fatura nubank 1547");
  assert.match(await enviar("Alterar vencimento Nubank"), /Qual o novo vencimento da fatura do \*Cartão Nubank\*\?/);
  assert.match(await enviar("Dia 10"), /Fatura atualizada[\s\S]*Vence 10\/11/);

  // Fatura sem cartão, com dois cartões → "De qual cartão?" → "nubank"
  repo.contas.push({ id: "c-cx", nome: "Cartão C6 Bank", tipo: "cartao_credito", apelidos: ["c6"], instituicao: "C6 Bank", diaFechamento: 1, diaVencimento: 8 });
  assert.match(await enviar("fatura 800"), /De qual cartão é essa fatura\?/);
  assert.match(await enviar("nubank"), /Fatura registrada:\* R\$ 800,00 — 💳 Cartão Nubank/);

  // Categoria: "o que são outros" pergunta o maior; resposta inválida mostra opções e continua esperando.
  await enviar("pix roberto augusto 2110");
  await enviar("o que são outros");
  assert.match(await enviar("família"), /Não tenho a categoria \*família\*/);
  assert.match(await enviar("moradia"), /o que tiver \*roberto augusto\* vai para \*Moradia\*[\s\S]*Mudei 1 lançamento/);

  // Mudou de assunto: a pergunta some e a mensagem segue normal.
  await enviar("almocei fora");
  assert.match(await enviar("uber 20"), /Registrado:\* R\$ 20,00 — Uber/);
  assert.equal(repo.pendencia, null);

  // "pular"
  await enviar("pix larissa 12");
  await enviar("outros");
  assert.match(await enviar("pular"), /fica em Outros/);
});
