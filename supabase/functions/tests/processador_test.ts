import assert from "node:assert/strict";
import { comandoDireto, encontrarCategoria, encontrarConta, processarMensagem } from "../_shared/processador.ts";
import { CATEGORIAS, CONTAS, criarDeps, interpretacao, mensagem } from "./fakes.ts";

const lanc = (p: Record<string, unknown>) => ({
  tipo: "despesa" as const,
  descricao: "Almoço",
  estabelecimento: null,
  valor: "45.00",
  valor_refere_se_a: "total" as const,
  parcelas: null,
  data: "2026-11-07",
  conta: null,
  categoria: "Alimentação",
  ...p,
});

Deno.test("registra um gasto no cartão e calcula a fatura", async () => {
  const { deps, repo, enviadas, pedidosIA } = criarDeps([
    interpretacao({ lancamentos: [lanc({ descricao: "iFood", valor: "47.90", conta: "Nubank crédito" })] }),
  ]);
  await processarMensagem(mensagem("gastei 47,90 no ifood no nubank"), deps);

  assert.equal(pedidosIA[0].hoje, "2026-11-07");
  assert.equal(pedidosIA[0].diaDaSemana, "sábado");
  assert.equal(repo.transacoes.length, 1);
  const t = repo.transacoes[0];
  assert.equal(t.valorCentavos, 4790);
  assert.equal(t.origem, "whatsapp");
  assert.equal(t.contaId, "c-nu");
  assert.equal(t.categoriaId, "k-alim");
  assert.equal(t.dataPagamento, "2026-12-10"); // fecha dia 3 → fatura de dezembro
  assert.equal(enviadas.length, 1);
  assert.match(enviadas[0].texto, /R\$ 47,90 — iFood/);
  assert.match(enviadas[0].texto, /vence em 10\/12/);
  assert.equal(enviadas[0].para, "5511987654321");
  assert.equal([...repo.mensagens.values()][0].status, "processada");
});

Deno.test("compra parcelada vira N transações ligadas, uma por fatura", async () => {
  const { deps, repo, enviadas } = criarDeps([
    interpretacao({
      lancamentos: [lanc({ descricao: "TV", valor: "1000.00", parcelas: 3, conta: "roxinho", categoria: "Compras" })],
    }),
  ]);
  await processarMensagem(mensagem("tv de 1000 em 3x no roxinho"), deps);

  assert.equal(repo.transacoes.length, 3);
  assert.deepEqual(repo.transacoes.map((t) => t.valorCentavos), [33334, 33333, 33333]);
  assert.deepEqual(repo.transacoes.map((t) => t.dataTransacao), ["2026-11-07", "2026-12-07", "2027-01-07"]);
  assert.deepEqual(repo.transacoes.map((t) => t.dataPagamento), ["2026-12-10", "2027-01-10", "2027-02-10"]);
  assert.deepEqual(repo.transacoes.map((t) => t.parcelaNumero), [1, 2, 3]);
  assert.ok(repo.transacoes.every((t) => t.grupoParcelamento === "g1" && t.parcelaTotal === 3));
  assert.match(enviadas[0].texto, /R\$ 1\.000,00 em 3x \(1ª de R\$ 333,34, demais de R\$ 333,33\)/);
  assert.match(enviadas[0].texto, /1ª parcela na fatura de 10\/12, última em 10\/02\/2027/);
});

Deno.test("'12x de 250' usa o valor como parcela", async () => {
  const { deps, repo } = criarDeps([
    interpretacao({ lancamentos: [lanc({ valor: "250.00", parcelas: 12, valor_refere_se_a: "parcela" })] }),
  ]);
  await processarMensagem(mensagem("geladeira 12x de 250"), deps);
  assert.equal(repo.transacoes.length, 12);
  assert.equal(repo.transacoes.reduce((a, t) => a + t.valorCentavos, 0), 300000);
});

Deno.test("vários lançamentos numa mensagem, com conta desconhecida e débito", async () => {
  const { deps, repo, enviadas } = criarDeps([
    interpretacao({
      lancamentos: [
        lanc({ descricao: "Uber", valor: "23.00", categoria: "Transporte", conta: "itau" }),
        lanc({ descricao: "Almoço", conta: "Banco Inexistente" }),
      ],
    }),
  ]);
  await processarMensagem(mensagem("uber 23 no itau e almoço 45 no banco x"), deps);

  assert.equal(repo.transacoes.length, 2);
  assert.equal(repo.transacoes[0].dataPagamento, "2026-11-07"); // conta corrente: sai na hora
  assert.equal(repo.transacoes[1].contaId, null);
  assert.match(enviadas[0].texto, /Registrei 2 lançamentos/);
  assert.match(enviadas[0].texto, /Total de despesas:\* R\$ 68,00/);
  assert.match(enviadas[0].texto, /Não achei a conta "Banco Inexistente"/);
});

Deno.test("valor inválido não grava nada e avisa", async () => {
  const { deps, repo, enviadas } = criarDeps([interpretacao({ lancamentos: [lanc({ valor: "quarenta" })] })]);
  await processarMensagem(mensagem("almoço quarenta"), deps);
  assert.equal(repo.transacoes.length, 0);
  assert.match(enviadas[0].texto, /Não entendi o valor/);
});

Deno.test("data absurda vinda da IA cai para hoje", async () => {
  const { deps, repo, enviadas } = criarDeps([interpretacao({ lancamentos: [lanc({ data: "2019-01-01" })] })]);
  await processarMensagem(mensagem("almoço 45"), deps);
  assert.equal(repo.transacoes[0].dataTransacao, "2026-11-07");
  assert.match(enviadas[0].texto, /usei hoje/);
});

Deno.test("receita entra com categoria de receita", async () => {
  const { deps, repo, enviadas } = criarDeps([
    interpretacao({ lancamentos: [lanc({ tipo: "receita", descricao: "Salário", valor: "5000.00", categoria: "Salário", conta: "Itaú" })] }),
  ]);
  await processarMensagem(mensagem("recebi 5000 de salário no itaú"), deps);
  assert.equal(repo.transacoes[0].tipo, "receita");
  assert.equal(repo.transacoes[0].categoriaId, "k-sal");
  assert.match(enviadas[0].texto, /Receita registrada/);
});

Deno.test("desfazer cancela a última mensagem inteira (sem IA) e não apaga nada", async () => {
  const { deps, repo, enviadas, pedidosIA } = criarDeps([
    interpretacao({ lancamentos: [lanc({ descricao: "Mercado", valor: "200.00" })] }),
    interpretacao({ lancamentos: [lanc({ descricao: "TV", valor: "900.00", parcelas: 3 })] }),
  ]);
  await processarMensagem(mensagem("mercado 200"), deps);
  await processarMensagem(mensagem("tv 900 em 3x"), deps);
  await processarMensagem(mensagem("Desfazer!"), deps);

  assert.equal(pedidosIA.length, 2); // o comando direto não chamou a IA
  assert.equal(repo.transacoes.length, 4); // nada foi apagado
  assert.equal(repo.ativas().length, 1);
  assert.equal(repo.ativas()[0].descricao, "Mercado");
  assert.match(enviadas[2].texto, /Desfeito:\* R\$ 900,00 — TV \(3 parcelas\)/);

  await processarMensagem(mensagem("desfazer"), deps);
  assert.equal(repo.ativas().length, 0);
  await processarMensagem(mensagem("desfazer"), deps);
  assert.match(enviadas[4].texto, /Não encontrei nenhum lançamento/);
});

Deno.test("corrigir valor e conta recalcula a data de pagamento", async () => {
  const { deps, repo, enviadas } = criarDeps([
    interpretacao({ lancamentos: [lanc({ valor: "45.00", conta: "Itaú" })] }),
    interpretacao({
      intencao: "corrigir",
      correcao: { valor: "52.00", conta: "Nubank crédito", data: null, categoria: null, descricao: null },
    }),
  ]);
  await processarMensagem(mensagem("almoço 45 no itaú"), deps);
  await processarMensagem(mensagem("corrigir: era 52 no nubank"), deps);

  const t = repo.transacoes[0];
  assert.equal(t.valorCentavos, 5200);
  assert.equal(t.contaId, "c-nu");
  assert.equal(t.dataPagamento, "2026-12-10");
  assert.match(enviadas[1].texto, /Corrigido:\* R\$ 52,00/);
});

Deno.test("corrigir valor de parcelado pede para desfazer, mas aplica a categoria", async () => {
  const { deps, repo, enviadas } = criarDeps([
    interpretacao({ lancamentos: [lanc({ valor: "300.00", parcelas: 3 })] }),
    interpretacao({
      intencao: "corrigir",
      correcao: { valor: "600.00", categoria: "Compras", conta: null, data: null, descricao: null },
    }),
  ]);
  await processarMensagem(mensagem("x 300 em 3x"), deps);
  await processarMensagem(mensagem("corrige: era 600, compras"), deps);
  assert.ok(repo.transacoes.every((t) => t.valorCentavos === 10000 && t.categoriaId === "k-compras"));
  assert.match(enviadas[1].texto, /responda \*desfazer\* e mande de novo/);
});

Deno.test("resumo do mês soma por categoria e ignora cancelados", async () => {
  const { deps, enviadas } = criarDeps([
    interpretacao({ lancamentos: [lanc({ valor: "100.00" }), lanc({ valor: "300.00", categoria: "Mercado" })] }),
    interpretacao({ lancamentos: [lanc({ valor: "999.00" })] }),
    interpretacao({ lancamentos: [lanc({ tipo: "receita", valor: "1000.00", categoria: "Salário" })] }),
  ]);
  await processarMensagem(mensagem("a"), deps);
  await processarMensagem(mensagem("b"), deps);
  await processarMensagem(mensagem("desfazer"), deps);
  await processarMensagem(mensagem("c"), deps);
  await processarMensagem(mensagem("resumo"), deps);

  const texto = enviadas.at(-1)!.texto;
  assert.match(texto, /📊 \*Novembro\/2026\*/);
  assert.match(texto, /💰 Entrou: \*R\$ 1\.000,00\*\n💸 Saiu: \*R\$ 400,00\*\n📈 Saldo: \*R\$ 600,00\*/);
  assert.match(texto, /\*Para onde foi\*\n• Mercado: R\$ 300,00\n• Alimentação: R\$ 100,00/);
  assert.match(texto, /\*De onde veio\*\n• Salário: R\$ 1\.000,00/);
  assert.doesNotMatch(texto, /999/);
});

Deno.test("resumo por intervalo livre e por categoria", async () => {
  const { deps, enviadas } = criarDeps([
    interpretacao({ lancamentos: [lanc({ valor: "80.00", categoria: "Mercado", data: "2026-10-15" })] }),
    interpretacao({
      intencao: "resumo",
      resumo: { periodo: "intervalo", inicio: "2026-10-01", fim: "2026-10-31", categoria: "mercado" },
    }),
  ]);
  await processarMensagem(mensagem("mercado 80 dia 15/10"), deps);
  await processarMensagem(mensagem("quanto foi de mercado em outubro?"), deps);
  assert.match(enviadas[1].texto, /📂 \*Mercado\* · 01\/10 a 31\/10: \*R\$ 80,00\* \(1 lançamento\)\n• R\$ 80,00 — Almoço · 15\/10/);
});

Deno.test("número desconhecido é ignorado em silêncio", async () => {
  const { deps, repo, enviadas, logs } = criarDeps([]);
  await processarMensagem(mensagem("gastei 10", "5521999990000"), deps);
  assert.equal(enviadas.length, 0);
  assert.equal(repo.mensagens.size, 0);
  assert.deepEqual(logs, ["remetente_desconhecido"]);
});

Deno.test("aceita o número sem o nono dígito (pegadinha do WhatsApp no Brasil)", async () => {
  const { deps, enviadas } = criarDeps([]);
  await processarMensagem(mensagem("ajuda", "551187654321"), deps);
  assert.equal(enviadas.length, 1);
  assert.equal(enviadas[0].para, "551187654321"); // responde ao wa_id original
  assert.match(enviadas[0].texto, /Oi, Maria!/);
});

Deno.test("mensagem repetida (reenvio da Meta) não duplica lançamento", async () => {
  const { deps, repo, enviadas } = criarDeps([interpretacao({ lancamentos: [lanc({})] })]);
  const m = mensagem("almoço 45");
  await processarMensagem(m, deps);
  await processarMensagem(m, deps);
  assert.equal(repo.transacoes.length, 1);
  assert.equal(enviadas.length, 1);
});

Deno.test("falha da IA responde com desculpas e registra o erro", async () => {
  const { deps, repo, enviadas } = criarDeps([]); // a IA vai falhar
  await processarMensagem(mensagem("almoço 45"), deps);
  assert.equal(repo.transacoes.length, 0);
  assert.match(enviadas[0].texto, /Tive um problema/);
  const registro = [...repo.mensagens.values()][0];
  assert.equal(registro.status, "erro");
  assert.match(registro.erro!, /IA indisponível/);
});

Deno.test("áudio/imagem ainda não são suportados", async () => {
  const { deps, enviadas } = criarDeps([]);
  await processarMensagem({ ...mensagem(""), tipo: "audio", texto: null }, deps);
  assert.match(enviadas[0].texto, /só entendo mensagens de texto/);
});

Deno.test("fora do escopo e esclarecimento", async () => {
  const { deps, enviadas } = criarDeps([
    interpretacao({ intencao: "fora_do_escopo" }),
    interpretacao({ intencao: "esclarecer", pergunta: "Quanto foi o almoço?" }),
  ]);
  await processarMensagem(mensagem("me conta uma piada"), deps);
  await processarMensagem(mensagem("almocei fora"), deps);
  assert.match(enviadas[0].texto, /Eu cuido só das suas finanças/);
  assert.equal(enviadas[1].texto, "Quanto foi o almoço?");
});

Deno.test("correspondência de contas e categorias", () => {
  assert.equal(encontrarConta("NUBANK", CONTAS)?.id, "c-nu");
  assert.equal(encontrarConta("nubank credito", CONTAS)?.id, "c-nu"); // sem acento
  assert.equal(encontrarConta("cartão nubank", CONTAS)?.id, "c-nu"); // aproximada inequívoca
  assert.equal(encontrarConta("xp", CONTAS), null);
  assert.equal(encontrarConta(null, CONTAS), null);
  assert.equal(encontrarCategoria("alimentacao", "despesa", CATEGORIAS)?.id, "k-alim");
  assert.equal(encontrarCategoria("Inventada", "despesa", CATEGORIAS)?.id, "k-outros");
  assert.equal(encontrarCategoria("Inventada", "receita", CATEGORIAS)?.id, "k-outrasr");
  assert.equal(comandoDireto("  Ajuda ")?.intencao, "ajuda");
  assert.equal(comandoDireto("desfazer o uber"), null); // frase vai para a IA
});
