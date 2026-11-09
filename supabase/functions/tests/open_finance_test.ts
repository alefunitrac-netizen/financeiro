import assert from "node:assert/strict";
import {
  acharCorrespondente,
  type ClientePluggy,
  type ConexaoBanco,
  type ContaPluggy,
  type ContaSalva,
  criarClientePluggy,
  criarSincronizador,
  type DadosContaBanco,
  dataDoBanco,
  type Informado,
  instituicaoDaConta,
  mapearConta,
  mapearTransacao,
  type NovaDoBanco,
  type RepositorioBanco,
  sincronizarConexao,
  type TransacaoBanco,
  type TransacaoPluggy,
  textoSincronizacao,
} from "../_shared/open_finance.ts";
import { processarMensagem } from "../_shared/processador.ts";
import { criarHandlerTelegram } from "../_shared/telegram.ts";
import type { Categoria } from "../_shared/tipos.ts";
import { CODIGO_VINCULO, criarDeps, mensagemTelegram } from "./fakes.ts";

// ---------- Dados no formato da Pluggy ----------

const CARTAO: ContaPluggy = {
  id: "acc-cartao",
  type: "CREDIT",
  subtype: "CREDIT_CARD",
  name: "Itaú Click Múltiplo MC Plat",
  number: "7669",
  balance: 190.88,
  creditData: { balanceCloseDate: "2026-11-03", balanceDueDate: "2026-11-10", creditLimit: 200 },
};
const CORRENTE: ContaPluggy = {
  id: "acc-cc",
  type: "BANK",
  subtype: "CHECKING_ACCOUNT",
  name: "Conta Corrente",
  number: "1234/5678-9",
  balance: -48.55,
};

const tx = (p: Partial<TransacaoPluggy> & { id: string }): TransacaoPluggy => ({
  description: "Compra",
  amount: 10,
  date: "2026-11-05T00:00:00.000Z",
  type: "DEBIT",
  status: "POSTED",
  ...p,
});

const CONTA_CARTAO: ContaSalva = { id: "c1", nome: "Cartão Itaú final 7669", tipo: "cartao_credito", diaFechamento: 3, diaVencimento: 10 };
const CONTA_CC: ContaSalva = { id: "c2", nome: "Itaú", tipo: "corrente", diaFechamento: null, diaVencimento: null };

Deno.test("contas: cartão com fechamento/vencimento/limite; corrente com apelidos do banco", () => {
  const cartao = mapearConta(CARTAO, "Itaú");
  assert.equal(cartao.nome, "Cartão Itaú final 7669");
  assert.equal(cartao.tipo, "cartao_credito");
  assert.equal(cartao.diaFechamento, 3);
  assert.equal(cartao.diaVencimento, 10);
  assert.equal(cartao.limiteCentavos, 20000);
  assert.equal(cartao.saldoCentavos, 19088);
  assert.ok(cartao.apelidos.includes("cartao itau") && cartao.apelidos.includes("7669"));

  const cc = mapearConta(CORRENTE, "Itaú");
  assert.equal(cc.nome, "Itaú");
  assert.equal(cc.tipo, "corrente");
  assert.equal(cc.saldoCentavos, -4855);
  assert.deepEqual(cc.apelidos.slice(0, 3), ["itau", "conta itau", "debito itau"]);
  assert.equal(cc.externalId, "pluggy:acc-cc");

  const semDatas = mapearConta({ ...CARTAO, creditData: { balanceCloseDate: "2026-11-03" } }, "Itaú");
  assert.equal(semDatas.diaFechamento, null); // sem os dois, nenhum
});

Deno.test("banco de cada conta pelo Meu Pluggy: o conector se chama MeuPluggy, o banco vem da conta", () => {
  assert.equal(instituicaoDaConta({ ...CORRENTE, name: "itau" }, "MeuPluggy"), "Itaú");
  assert.equal(instituicaoDaConta(CARTAO, "MeuPluggy"), "Itaú");
  assert.equal(instituicaoDaConta({ ...CORRENTE, name: "Nubank" }, "MeuPluggy"), "Nubank");
  assert.equal(instituicaoDaConta({ ...CORRENTE, name: "Conta Corrente" }, "Bradesco"), "Bradesco");
  assert.equal(instituicaoDaConta({ ...CORRENTE, name: "banco desconhecido" }, "MeuPluggy"), "Banco desconhecido");
});

Deno.test("sincronização pelo Meu Pluggy dá às contas o nome do banco, não do conector", async () => {
  const repo = new RepoBancoMemoria();
  const pluggy: ClientePluggy = {
    ...pluggyFalsa({}, { connector: { name: "MeuPluggy" } }),
    contas: () => Promise.resolve([CARTAO, { ...CORRENTE, name: "itau" }]),
  };
  const r = await sincronizarConexao(repo.conexoes[0], { repo, pluggy, agora: AGORA });
  assert.equal(r.instituicao, "Itaú");
  assert.deepEqual([...repo.contas.values()].map((c) => c.nome).sort(), ["Cartão Itaú final 7669", "Itaú"]);
});

Deno.test("datas do banco: meia-noite UTC é o próprio dia; com hora, vira horário de Brasília", () => {
  assert.equal(dataDoBanco("2026-11-05T00:00:00.000Z"), "2026-11-05");
  assert.equal(dataDoBanco("2026-11-06T01:30:00.000Z"), "2026-11-05"); // 22h30 do dia 5 em Brasília
  assert.equal(dataDoBanco("2026-11-06T15:00:00.000Z"), "2026-11-06");
  assert.equal(dataDoBanco("2026-11-05"), "2026-11-05");
});

Deno.test("transações: sinal, tipo, centavos, parcelas e chave estável", () => {
  const compra = mapearTransacao(tx({ id: "t1", providerId: "BANCO-1", description: "IFD*IFOOD  SAO PAULO", amount: 47.9 }), CONTA_CARTAO)!;
  assert.deepEqual(compra, {
    externalId: "pluggy:BANCO-1", // id do banco, que não muda quando a fatura fecha
    contaId: "c1",
    tipo: "despesa",
    descricao: "IFD*IFOOD SAO PAULO",
    valorCentavos: 4790,
    dataTransacao: "2026-11-05",
    dataPagamento: "2026-12-10",
  });

  const pagamento = mapearTransacao(tx({ id: "t2", description: "PAGAMENTO EFETUADO", amount: -150 }), CONTA_CARTAO)!;
  assert.equal(pagamento.tipo, "pagamento_fatura");
  assert.equal(pagamento.valorCentavos, 15000);
  assert.equal(pagamento.externalId, "pluggy:t2");

  assert.equal(mapearTransacao(tx({ id: "t3", description: "ESTORNO LOJA X", amount: -30 }), CONTA_CARTAO)!.tipo, "receita");

  const parcela = mapearTransacao(
    tx({ id: "t4", description: "MAGALU", amount: 250, creditCardMetadata: { installmentNumber: 2, totalInstallments: 10 } }),
    CONTA_CARTAO,
  )!;
  assert.equal(parcela.descricao, "MAGALU (2/10)");

  const fatura = mapearTransacao(tx({ id: "t5", description: "PAGTO FATURA CARTAO", amount: -190.88 }), CONTA_CC)!;
  assert.equal(fatura.tipo, "pagamento_fatura");
  assert.equal(fatura.dataPagamento, "2026-11-05");
  assert.equal(mapearTransacao(tx({ id: "t6", description: "PIX RECEBIDO", amount: 100, type: "CREDIT" }), CONTA_CC)!.tipo, "receita");
  assert.equal(mapearTransacao(tx({ id: "t7", description: "PIX ENVIADO", amount: -100, type: "DEBIT" }), CONTA_CC)!.tipo, "despesa");

  const exterior = mapearTransacao(tx({ id: "t8", amount: 10, amountInAccountCurrency: 55.12 }), CONTA_CARTAO)!;
  assert.equal(exterior.valorCentavos, 5512);
  assert.equal(mapearTransacao(tx({ id: "t9", amount: 0 }), CONTA_CC), null);
});

Deno.test("conferência: mesmo valor e tipo, conta igual ou sem conta, data mais próxima", () => {
  const b: TransacaoBanco = {
    externalId: "x", contaId: "c1", tipo: "despesa", descricao: "IFOOD", valorCentavos: 3500,
    dataTransacao: "2026-11-08", dataPagamento: null,
  };
  const informados: Informado[] = [
    { id: "longe", contaId: "c1", tipo: "despesa", valorCentavos: 3500, dataTransacao: "2026-11-01" },
    { id: "sem-conta", contaId: null, tipo: "despesa", valorCentavos: 3500, dataTransacao: "2026-11-07" },
    { id: "outra-conta", contaId: "c2", tipo: "despesa", valorCentavos: 3500, dataTransacao: "2026-11-08" },
    { id: "outro-valor", contaId: "c1", tipo: "despesa", valorCentavos: 3600, dataTransacao: "2026-11-08" },
  ];
  assert.equal(acharCorrespondente(b, informados, 3)?.id, "sem-conta");
  informados.push({ id: "mesma-conta", contaId: "c1", tipo: "despesa", valorCentavos: 3500, dataTransacao: "2026-11-06" });
  assert.equal(acharCorrespondente(b, informados, 3)?.id, "mesma-conta"); // mesma conta vence
  assert.equal(acharCorrespondente({ ...b, tipo: "receita" }, informados, 3), null);
  assert.equal(acharCorrespondente({ ...b, dataTransacao: "2026-11-20" }, informados, 3), null);
});

// ---------- Sincronização com Pluggy e banco de mentira ----------

const CATEGORIAS: Categoria[] = [
  { id: "k-alim", nome: "Alimentação", tipo: "despesa" },
  { id: "k-transp", nome: "Transporte", tipo: "despesa" },
  { id: "k-outros", nome: "Outros", tipo: "despesa" },
  { id: "k-outrasr", nome: "Outras receitas", tipo: "receita" },
];

interface Linha {
  id: string;
  contaId: string | null;
  categoriaId: string | null;
  tipo: string;
  status: "informado" | "confirmado" | "cancelado";
  origem: string;
  descricao: string;
  descricaoBanco: string | null;
  valorCentavos: number;
  dataTransacao: string;
  externalId: string | null;
}

class RepoBancoMemoria implements RepositorioBanco {
  contas = new Map<string, ContaSalva & { externalId: string }>();
  transacoes: Linha[] = [];
  sincronizacoes: { conexaoId: string; erro: string | null; consentimentoExpiraEm: string | null }[] = [];
  conexoes: ConexaoBanco[] = [{
    id: "cx1", usuarioId: "u1", itemId: "item-1", instituicao: null, telegramId: "777", ultimaSincronizacao: null,
  }];
  private seq = 0;

  listarConexoes(usuarioId?: string) {
    return Promise.resolve(this.conexoes.filter((c) => !usuarioId || c.usuarioId === usuarioId));
  }
  salvarConta(_u: string, d: DadosContaBanco) {
    const atual = this.contas.get(d.externalId) ??
      { id: `conta${++this.seq}`, externalId: d.externalId, nome: d.nome, tipo: d.tipo, diaFechamento: null, diaVencimento: null };
    Object.assign(atual, { diaFechamento: d.diaFechamento, diaVencimento: d.diaVencimento });
    this.contas.set(d.externalId, atual);
    return Promise.resolve(atual);
  }
  listarCategorias() {
    return Promise.resolve(CATEGORIAS);
  }
  buscarPorExternos(_u: string, externos: string[]) {
    return Promise.resolve(
      this.transacoes.filter((t) => t.externalId && externos.includes(t.externalId))
        .map((t) => ({ id: t.id, externalId: t.externalId!, valorCentavos: t.valorCentavos, dataTransacao: t.dataTransacao })),
    );
  }
  informadosParaConciliar(_u: string, inicio: string, fim: string) {
    return Promise.resolve(
      this.transacoes
        .filter((t) => t.status === "informado" && !t.externalId && t.origem !== "banco" && t.dataTransacao >= inicio && t.dataTransacao <= fim)
        .map((t) => ({ id: t.id, contaId: t.contaId, tipo: t.tipo, valorCentavos: t.valorCentavos, dataTransacao: t.dataTransacao })),
    );
  }
  confirmar(id: string, b: TransacaoBanco) {
    Object.assign(this.transacoes.find((t) => t.id === id)!, {
      externalId: b.externalId, status: "confirmado", contaId: b.contaId, valorCentavos: b.valorCentavos,
      dataTransacao: b.dataTransacao, descricaoBanco: b.descricao,
    });
    return Promise.resolve();
  }
  atualizarDoBanco(id: string, b: TransacaoBanco) {
    Object.assign(this.transacoes.find((t) => t.id === id)!, { valorCentavos: b.valorCentavos, dataTransacao: b.dataTransacao });
    return Promise.resolve();
  }
  inserirDoBanco(_u: string, novas: NovaDoBanco[]) {
    for (const n of novas) {
      this.transacoes.push({
        id: `t${++this.seq}`, contaId: n.contaId, categoriaId: n.categoriaId, tipo: n.tipo, status: "confirmado", origem: "banco",
        descricao: n.descricao, descricaoBanco: n.descricao, valorCentavos: n.valorCentavos, dataTransacao: n.dataTransacao,
        externalId: n.externalId,
      });
    }
    return Promise.resolve();
  }
  tratarAusentes(_u: string, contaId: string, inicio: string, fim: string, presentes: Set<string>) {
    let canceladas = 0;
    for (const t of this.transacoes) {
      if (t.contaId !== contaId || !t.externalId || t.status === "cancelado") continue;
      if (t.dataTransacao < inicio || t.dataTransacao > fim || presentes.has(t.externalId)) continue;
      if (t.origem === "banco") {
        t.status = "cancelado";
        canceladas++;
      } else Object.assign(t, { status: "informado", externalId: null });
    }
    return Promise.resolve(canceladas);
  }
  registrarSincronizacao(conexaoId: string, d: { erro: string | null; consentimentoExpiraEm: string | null }) {
    this.sincronizacoes.push({ conexaoId, ...d });
    const c = this.conexoes.find((x) => x.id === conexaoId);
    if (c) c.ultimaSincronizacao = new Date().toISOString();
    return Promise.resolve();
  }
  informar(p: Partial<Linha>) {
    const l: Linha = {
      id: `t${++this.seq}`, contaId: null, categoriaId: "k-alim", tipo: "despesa", status: "informado", origem: "telegram",
      descricao: "Almoço", descricaoBanco: null, valorCentavos: 3500, dataTransacao: "2026-11-07", externalId: null, ...p,
    };
    this.transacoes.push(l);
    return l;
  }
}

function pluggyFalsa(transacoes: Record<string, TransacaoPluggy[]>, item: Record<string, unknown> = {}): ClientePluggy {
  return {
    item: (id) => Promise.resolve({ id, status: "UPDATED", connector: { name: "Itaú" }, consentExpiresAt: "2027-11-08T00:00:00.000Z", ...item }),
    contas: () => Promise.resolve([CARTAO, CORRENTE]),
    transacoes: (accountId) => Promise.resolve(transacoes[accountId] ?? []),
  };
}

const AGORA = () => new Date("2026-11-09T15:00:00Z");

Deno.test("sincronização: confirma o que você informou, grava o resto e categoriza", async () => {
  const repo = new RepoBancoMemoria();
  const almoco = repo.informar({ descricao: "Almoço", valorCentavos: 3500, dataTransacao: "2026-11-07" });
  const dados = {
    "acc-cartao": [
      tx({ id: "p1", providerId: "B1", description: "IFD*RESTAURANTE", amount: 35, date: "2026-11-08T00:00:00.000Z" }),
      tx({ id: "p2", providerId: "B2", description: "UBER *TRIP", amount: 23.5, date: "2026-11-08T00:00:00.000Z" }),
      tx({ id: "p3", providerId: "B3", description: "PAGAMENTO EFETUADO", amount: -150, date: "2026-11-02T00:00:00.000Z" }),
    ],
    "acc-cc": [tx({ id: "p4", description: "PIX RECEBIDO FULANO", amount: 200, type: "CREDIT" })],
  };
  const r = await sincronizarConexao(repo.conexoes[0], { repo, pluggy: pluggyFalsa(dados), agora: AGORA });

  assert.equal(r.instituicao, "Itaú");
  assert.equal(r.confirmadas, 1);
  // O almoço que você informou foi confirmado: valor/data/conta do banco, sua descrição e categoria.
  assert.equal(almoco.status, "confirmado");
  assert.equal(almoco.externalId, "pluggy:B1");
  assert.equal(almoco.descricao, "Almoço");
  assert.equal(almoco.descricaoBanco, "IFD*RESTAURANTE");
  assert.equal(almoco.dataTransacao, "2026-11-08");
  assert.equal(almoco.contaId, repo.contas.get("pluggy:acc-cartao")!.id);

  const uber = repo.transacoes.find((t) => t.externalId === "pluggy:B2")!;
  assert.equal(uber.origem, "banco");
  assert.equal(uber.categoriaId, "k-transp");
  assert.equal(uber.valorCentavos, 2350);
  assert.equal(repo.transacoes.find((t) => t.externalId === "pluggy:B3")!.tipo, "pagamento_fatura");
  assert.equal(repo.transacoes.find((t) => t.externalId === "pluggy:p4")!.categoriaId, "k-outrasr");
  assert.equal(r.novas.length, 3);

  const texto = textoSincronizacao(r, "2026-11-09")!;
  assert.match(texto, /Itaú atualizado/);
  assert.match(texto, /1 lançamento que você informou foi confirmado/);
  assert.match(texto, /🆕 2 novos vindos do banco/); // pagamento de fatura não conta como gasto
  assert.match(texto, /R\$ 23,50 — UBER \*TRIP · Transporte · ontem/);

  // Rodar de novo não duplica nada.
  const total = repo.transacoes.length;
  const r2 = await sincronizarConexao(repo.conexoes[0], { repo, pluggy: pluggyFalsa(dados), agora: AGORA });
  assert.equal(repo.transacoes.length, total);
  assert.equal(r2.novas.length + r2.confirmadas + r2.canceladas, 0);
  assert.equal(textoSincronizacao(r2, "2026-11-09"), null);
  assert.match(textoSincronizacao(r2, "2026-11-09", true)!, /Nada novo/);

  // O banco apagou o Uber e o "almoço": o Uber é desfeito, o almoço volta a ser só "informado".
  const r3 = await sincronizarConexao(repo.conexoes[0], {
    repo,
    pluggy: pluggyFalsa({ ...dados, "acc-cartao": [dados["acc-cartao"][2]] }),
    agora: AGORA,
  });
  assert.equal(r3.canceladas, 1);
  assert.equal(uber.status, "cancelado");
  assert.equal(almoco.status, "informado");
  assert.equal(almoco.externalId, null);
});

Deno.test("sincronização avisa autorização perto de vencer e conexão com erro", async () => {
  const repo = new RepoBancoMemoria();
  const r = await sincronizarConexao(repo.conexoes[0], {
    repo,
    pluggy: pluggyFalsa({}, { consentExpiresAt: "2026-11-20T00:00:00.000Z", status: "LOGIN_ERROR", error: { code: "USER_AUTHORIZATION_EXPIRED" } }),
    agora: AGORA,
  });
  assert.equal(r.avisos.length, 2);
  assert.match(r.avisos[0], /USER_AUTHORIZATION_EXPIRED/);
  assert.match(r.avisos[1], /vence em 20\/11/);
});

Deno.test("sincronizador: rodada automática avisa no Telegram, pula quem acabou de sincronizar e registra erro", async () => {
  const repo = new RepoBancoMemoria();
  const avisos: [string, string][] = [];
  const logs: string[] = [];
  const s = criarSincronizador({
    repo,
    pluggy: pluggyFalsa({ "acc-cc": [tx({ id: "p9", description: "MERCADO", amount: -80 })] }),
    agora: AGORA,
    avisar: (id, texto) => (avisos.push([id, texto]), Promise.resolve()),
    log: (e) => logs.push(e),
  });
  assert.deepEqual(await s.sincronizarTodos(), { conexoes: 1, novas: 1, confirmadas: 0, erros: 0 });
  assert.equal(avisos[0][0], "777");
  assert.match(avisos[0][1], /MERCADO/);
  // Logo em seguida: pulado (protege a URL pública e o limite da API).
  repo.conexoes[0].ultimaSincronizacao = AGORA().toISOString();
  assert.equal((await s.sincronizarTodos()).conexoes, 0);

  const comErro = criarSincronizador({
    repo,
    pluggy: { ...pluggyFalsa({}), item: () => Promise.reject(new Error("auth 401: CLIENT_KEYS_UNAUTHORIZED")) },
    agora: AGORA,
    avisar: () => Promise.resolve(),
    log: (e) => logs.push(e),
  });
  assert.match(await comErro.sincronizarUsuario("u1"), /Não consegui ler/);
  assert.deepEqual(logs, ["erro_sincronizacao"]);
  assert.match(repo.sincronizacoes.at(-1)!.erro!, /CLIENT_KEYS_UNAUTHORIZED/);

  repo.conexoes = [];
  assert.match(await comErro.sincronizarUsuario("u1"), /Nenhum banco conectado/);
});

Deno.test("cliente Pluggy: autentica uma vez, reaproveita a chave e segue a paginação", async () => {
  const chamadas: string[] = [];
  const cliente = criarClientePluggy({
    clientId: "id",
    clientSecret: "segredo",
    agora: () => 0,
    fetch: (url, init) => {
      const u = String(url);
      chamadas.push(`${init?.method ?? "GET"} ${u.replace("https://api.pluggy.ai", "")}`);
      if (u.endsWith("/auth")) {
        assert.deepEqual(JSON.parse(init!.body as string), { clientId: "id", clientSecret: "segredo" });
        return Promise.resolve(Response.json({ apiKey: "CHAVE" }));
      }
      assert.equal((init!.headers as Record<string, string>)["X-API-KEY"], "CHAVE");
      if (u.includes("after=2")) return Promise.resolve(Response.json({ results: [{ id: "b" }], next: null }));
      if (u.includes("/v2/transactions")) {
        return Promise.resolve(Response.json({ results: [{ id: "a" }], next: "?accountId=acc&after=2" }));
      }
      if (u.includes("/accounts")) return Promise.resolve(Response.json({ results: [CARTAO] }));
      return Promise.resolve(new Response("nao achei", { status: 404 }));
    },
  });
  assert.deepEqual((await cliente.transacoes("acc", "2026-09-10", "2027-12-14")).map((t) => t.id), ["a", "b"]);
  assert.equal((await cliente.contas("item-1"))[0].id, "acc-cartao");
  await assert.rejects(cliente.item("item-x"), /404/);
  assert.deepEqual(chamadas, [
    "POST /auth",
    "GET /v2/transactions?accountId=acc&dateFrom=2026-09-10&dateTo=2027-12-14",
    "GET /v2/transactions?accountId=acc&after=2",
    "GET /accounts?itemId=item-1",
    "GET /items/item-x",
  ]);
});

Deno.test("rota ?acao=sincronizar e comando 'atualizar' no bot", async () => {
  let rodadas = 0;
  const base = { segredo: "s", processar: () => Promise.resolve(), emSegundoPlano: () => {}, configurar: () => Promise.resolve({ ok: true }), log: () => {} };
  const com = criarHandlerTelegram({ ...base, sincronizar: () => (rodadas++, Promise.resolve({ conexoes: 1 })) });
  const r = await com(new Request("https://x/?acao=sincronizar"));
  assert.deepEqual(await r.json(), { ok: true, conexoes: 1 });
  assert.equal(rodadas, 1);
  assert.equal((await criarHandlerTelegram(base)(new Request("https://x/?acao=sincronizar"))).status, 503);

  const { deps, enviadas } = criarDeps();
  deps.sincronizarBanco = (u) => Promise.resolve(`sincronizado ${u}`);
  await processarMensagem(mensagemTelegram(`/start ${CODIGO_VINCULO}`), deps);
  await processarMensagem(mensagemTelegram("Atualizar"), deps);
  assert.equal(enviadas[1].texto, "sincronizado u1");
});
