import assert from "node:assert/strict";
import { criarInterpretadorHibrido } from "../_shared/interpretador_hibrido.ts";
import { categoriaPorTexto, interpretarPorRegras } from "../_shared/interpretador_regras.ts";
import { processarMensagem } from "../_shared/processador.ts";
import { TEXTO_NAO_ENTENDI } from "../_shared/respostas.ts";
import type { Categoria, ContextoInterpretacao, Interpretacao, LancamentoInterpretado } from "../_shared/tipos.ts";
import { CONTAS, criarDeps, mensagemTelegram, CODIGO_VINCULO } from "./fakes.ts";

// As mesmas categorias que o banco cria para todo usuário novo.
const CATEGORIAS_PADRAO: Categoria[] = [
  ...["Alimentação", "Mercado", "Transporte", "Moradia", "Contas da casa", "Saúde", "Educação", "Lazer", "Compras",
    "Assinaturas", "Pets", "Viagem", "Impostos e taxas", "Presentes e doações", "Outros"]
    .map((nome, i) => ({ id: `d${i}`, nome, tipo: "despesa" as const })),
  ...["Salário", "Renda extra", "Reembolso", "Rendimentos", "Outras receitas"]
    .map((nome, i) => ({ id: `r${i}`, nome, tipo: "receita" as const })),
];

// Hoje é sábado, 07/11/2026.
const ler = (texto: string) =>
  interpretarPorRegras({
    texto,
    hoje: "2026-11-07",
    diaDaSemana: "sábado",
    contas: CONTAS,
    categorias: CATEGORIAS_PADRAO,
  } satisfies ContextoInterpretacao);

function umLancamento(texto: string): LancamentoInterpretado {
  const r = ler(texto);
  assert.equal(r?.intencao, "registrar", `"${texto}" deveria registrar`);
  assert.equal(r!.lancamentos.length, 1, `"${texto}" deveria ter 1 lançamento`);
  return r!.lancamentos[0];
}

const BASE = {
  tipo: "despesa",
  estabelecimento: null,
  valor_refere_se_a: "total",
  parcelas: null,
  data: "2026-11-07",
  conta: null,
  meio: null,
};

Deno.test("as frases que você mandou", () => {
  assert.deepEqual(umLancamento("Almoço 35 em dinheiro"), {
    ...BASE, descricao: "Almoço", valor: "35.00", conta: "Dinheiro", categoria: "Alimentação",
  });
  assert.deepEqual(umLancamento("Gastei 35 em almoço"), {
    ...BASE, descricao: "Almoço", valor: "35.00", categoria: "Alimentação",
  });
  assert.deepEqual(umLancamento("Gastei 35,50 em almoço"), {
    ...BASE, descricao: "Almoço", valor: "35.50", categoria: "Alimentação",
  });
});

Deno.test("conta por nome ou apelido, com 'no cartão', 'na conta'...", () => {
  const ifood = umLancamento("gastei 45,90 no ifood no nubank");
  assert.equal(ifood.valor, "45.90");
  assert.equal(ifood.conta, "Nubank crédito");
  assert.equal(ifood.descricao, "iFood");
  assert.equal(ifood.categoria, "Alimentação");

  const tv = umLancamento("tv 3000 em 10x no cartão itaú");
  assert.deepEqual(tv, {
    ...BASE, descricao: "TV", valor: "3000.00", parcelas: 10, conta: "Itaú", categoria: "Compras", meio: "credito",
  });
  assert.equal(umLancamento("mercado 230 no roxinho").conta, "Nubank crédito");
  assert.equal(umLancamento("mercado 230").conta, null);
});

Deno.test("parcelas: total dividido ou valor de cada parcela", () => {
  const g = umLancamento("geladeira 12x de 250 no roxinho");
  assert.equal(g.parcelas, 12);
  assert.equal(g.valor, "250.00");
  assert.equal(g.valor_refere_se_a, "parcela");
  assert.equal(g.descricao, "Geladeira");

  const ml = umLancamento("mercado livre 300 em 3x");
  assert.equal(ml.parcelas, 3);
  assert.equal(ml.valor_refere_se_a, "total");
  assert.equal(ml.categoria, "Compras"); // "mercado livre" ganha de "mercado"
  assert.equal(ml.descricao, "Mercado Livre");
});

Deno.test("valores no jeito brasileiro", () => {
  assert.equal(umLancamento("R$ 1.234,56 aluguel").valor, "1234.56");
  assert.equal(umLancamento("aluguel 1.200").valor, "1200.00");
  assert.equal(umLancamento("mercado 1,5k").valor, "1500.00");
  assert.equal(umLancamento("reforma 2 mil").valor, "2000.00");
  assert.equal(umLancamento("2 pizzas 80").valor, "80.00");
  assert.equal(umLancamento("99 23").valor, "23.00"); // 99 é o app
  assert.equal(umLancamento("99 23").categoria, "Transporte");
  assert.equal(umLancamento("estacionamento 15 às 14h").valor, "15.00"); // 14h não é dinheiro
  assert.equal(umLancamento("uber 47.90").valor, "47.90");
});

Deno.test("datas: ontem, anteontem, dia N, dd/mm, dia da semana", () => {
  assert.equal(umLancamento("uber 23 ontem").data, "2026-11-06");
  assert.equal(umLancamento("uber 23 anteontem").data, "2026-11-05");
  assert.equal(umLancamento("mercado 1,5k dia 3").data, "2026-11-03");
  assert.equal(umLancamento("mercado 100 dia 20").data, "2026-10-20"); // dia 20 ainda não chegou: mês passado
  assert.equal(umLancamento("padaria 12 05/11").data, "2026-11-05");
  assert.equal(umLancamento("padaria 12 20/12").data, "2025-12-20"); // data futura: ano passado
  assert.equal(umLancamento("farmácia 42 sexta").data, "2026-11-06");
  assert.equal(umLancamento("farmácia 42 na segunda-feira").data, "2026-11-02");
  assert.equal(umLancamento("cinema 50 sábado passado").data, "2026-10-31");
  assert.equal(umLancamento("uber 23 ontem").descricao, "Uber");
});

Deno.test("categorias por palavra-chave e receitas", () => {
  assert.equal(umLancamento("paguei 120 de luz").categoria, "Contas da casa");
  assert.equal(umLancamento("paguei 120 de luz").descricao, "Luz");
  assert.equal(umLancamento("farmácia 42").categoria, "Saúde");
  assert.equal(umLancamento("netflix 55,90").categoria, "Assinaturas");
  assert.equal(umLancamento("ração 89").categoria, "Pets");
  assert.equal(umLancamento("parafuso 12").categoria, "Outros");
  assert.equal(umLancamento("parafuso 12").descricao, "Parafuso");

  const salario = umLancamento("recebi 5000 de salário");
  assert.equal(salario.tipo, "receita");
  assert.equal(salario.categoria, "Salário");
  assert.equal(salario.descricao, "Salário");

  const pix = umLancamento("recebi pix de 50 do joão");
  assert.equal(pix.tipo, "receita");
  assert.equal(pix.categoria, "Outras receitas");
  assert.equal(pix.descricao, "Pix joão");

  // Descrições como vêm do banco
  const cat = (texto: string, tipo: "despesa" | "receita" = "despesa") =>
    categoriaPorTexto(texto, tipo, CATEGORIAS_PADRAO);
  assert.equal(cat("Entrada PAGTO Salários", "receita"), "Salário");
  assert.equal(cat("Pagamento de Pix QR Code MC DONALD'S"), "Alimentação");
  assert.equal(cat("EC *SHELLBOXOSASCOBRA"), null); // nome colado na cidade: não dá para separar com segurança
  assert.equal(cat("SHELLBOX OSASCO"), "Transporte");
  assert.equal(cat("ENCARGOS REFINANCIAMENTO"), "Impostos e taxas");
  assert.equal(cat("Compra débito Uber Uber *trip Help.u"), "Transporte");

  assert.equal(umLancamento("paguei o salário da diarista 300").tipo, "despesa");
  assert.equal(umLancamento("paguei o salário da diarista 300").categoria, "Moradia");
});

Deno.test("vários lançamentos numa mensagem, só quando cada parte tem valor", () => {
  const r = ler("uber 23 e almoço 45");
  assert.equal(r?.lancamentos.length, 2);
  assert.deepEqual(r!.lancamentos.map((l) => [l.descricao, l.valor]), [["Uber", "23.00"], ["Almoço", "45.00"]]);

  assert.equal(ler("almoço 35, uber 20 ontem")?.lancamentos.length, 2);

  const lista = umLancamento("arroz, feijão e carne 80");
  assert.equal(lista.valor, "80.00");
  assert.equal(lista.categoria, "Mercado");
  assert.equal(lista.descricao, "Arroz feijão carne");
});

Deno.test("resumos: período e categoria", () => {
  const resumo = (t: string) => {
    const r = ler(t);
    assert.equal(r?.intencao, "resumo", `"${t}" deveria ser resumo`);
    return r!.resumo;
  };
  assert.deepEqual(resumo("quanto gastei esse mês?"), { periodo: "mes_atual", inicio: null, fim: null, categoria: null, conta: null });
  assert.equal(resumo("resumo da semana")?.periodo, "semana");
  assert.equal(resumo("quanto gastei hoje")?.periodo, "hoje");
  assert.equal(resumo("gastos do mês passado")?.periodo, "mes_anterior");
  assert.deepEqual(resumo("quanto foi de mercado em outubro?"), {
    periodo: "intervalo", inicio: "2026-10-01", fim: "2026-10-31", categoria: "Mercado", conta: null,
  });
  assert.deepEqual(resumo("quanto gastei em dezembro"), {
    periodo: "intervalo", inicio: "2025-12-01", fim: "2025-12-31", categoria: null, conta: null,
  });
  assert.deepEqual(resumo("quanto gastei dia 3"), {
    periodo: "intervalo", inicio: "2026-11-03", fim: "2026-11-03", categoria: null, conta: null,
  });
  assert.equal(resumo("quanto gastei com uber")?.categoria, "Transporte");
});

Deno.test("corrigir, desfazer e ajuda", () => {
  const corr = (t: string) => {
    const r = ler(t);
    assert.equal(r?.intencao, "corrigir", `"${t}" deveria corrigir`);
    return r!.correcao;
  };
  assert.deepEqual(corr("corrigir: era 52"), { valor: "52.00", data: null, conta: null, categoria: null, descricao: null, meio: null });
  assert.equal(corr("corrige: foi no nubank")?.conta, "Nubank crédito");
  assert.equal(corr("corrigir categoria mercado")?.categoria, "Mercado");
  assert.equal(corr("corrigir data ontem")?.data, "2026-11-06");

  assert.equal(ler("desfazer o último")?.intencao, "desfazer");
  assert.equal(ler("cancela isso")?.intencao, "desfazer");
  assert.equal(ler("como funciona?")?.intencao, "ajuda");
});

Deno.test("o jeito que você escreve no dia a dia: fatura, cartão, correção curta, perguntas", () => {
  // Sem Nubank cadastrado: o banco é reconhecido pelo nome e a conta será criada.
  const semNubank = (texto: string) =>
    interpretarPorRegras({
      texto,
      hoje: "2026-11-10",
      diaDaSemana: "terça-feira",
      contas: CONTAS.filter((c) => c.id !== "c-nu"),
      categorias: CATEGORIAS_PADRAO,
    });

  const fatura = semNubank("Adicionar fatura Nubank 1547");
  assert.equal(fatura?.intencao, "fatura");
  assert.deepEqual(fatura?.fatura, { conta: "Nubank", valor: "1547.00", vencimento: null, paga: false });
  assert.deepEqual(semNubank("fatura do nubank 1.547,90 vence dia 15")?.fatura, {
    conta: "Nubank", valor: "1547.90", vencimento: "2026-11-15", paga: false,
  });
  assert.equal(semNubank("fatura nubank vence dia 5")?.fatura?.vencimento, "2026-12-05"); // dia 5 já passou
  assert.equal(semNubank("fatura nubank vence dia 5")?.fatura?.valor, null);
  assert.equal(semNubank("paguei a fatura do nubank 1547")?.fatura?.paga, true);

  assert.deepEqual(semNubank("nubank fecha dia 3 e vence dia 10")?.cartao, { conta: "Nubank", diaFechamento: 3, diaVencimento: 10 });
  assert.equal(semNubank("cartão nubank fechamento 28 vencimento 5")?.intencao, "configurar_cartao");

  const parcela = semNubank("Parcela de 3x 16,78")!.lancamentos[0];
  assert.equal(parcela.parcelas, 3);
  assert.equal(parcela.valor_refere_se_a, "parcela");
  assert.equal(parcela.descricao, "Compra parcelada");
  assert.equal(parcela.meio, "credito");

  const nu = semNubank("almoço 30 no nubank")!.lancamentos[0];
  assert.equal(nu.conta, "Nubank");
  assert.equal(nu.descricao, "Almoço");
  assert.equal(semNubank("uber 20 no débito do nubank")!.lancamentos[0].meio, "debito");
  assert.equal(semNubank("caixa de som 200")!.lancamentos[0].conta, null); // "caixa" aqui não é banco
  assert.equal(semNubank("pix 50 na conta da caixa")!.lancamentos[0].conta, "Caixa");

  // Correção sem "corrigir:"
  for (const t of ["Foi no Nubank", "foi na nubank", "no nubank"]) {
    assert.equal(semNubank(t)?.intencao, "corrigir", t);
    assert.equal(semNubank(t)?.correcao?.conta, "Nubank", t);
  }
  assert.equal(semNubank("Corrigir: foi na Nubank")?.correcao?.conta, "Nubank");
  assert.equal(semNubank("era 52")?.correcao?.valor, "52.00");
  assert.equal(semNubank("foi no débito")?.correcao?.meio, "debito");
  assert.equal(semNubank("foi ontem")?.correcao?.data, "2026-11-09");

  // Perguntas e consultas
  assert.equal(semNubank("Está parcela foi em qual banco")?.intencao, "ultimo");
  assert.equal(semNubank("qual foi o último lançamento?")?.intencao, "ultimo");
  assert.equal(semNubank("Por banco")?.intencao, "resumo");
  assert.equal(semNubank("Resumo total")?.intencao, "resumo");
  assert.equal(semNubank("resumo por banco")?.resumo?.conta, null);
  assert.equal(semNubank("quanto gastei no nubank?")?.resumo?.conta, "Nubank");
  assert.equal(semNubank("minhas contas")?.intencao, "contas");
  assert.equal(semNubank("como está a fatura?")?.intencao, "contas");
});

Deno.test("o que não entende devolve null (sem chutar)", () => {
  assert.equal(ler("me conta uma piada"), null);
  assert.equal(ler("almocei fora"), null);
  assert.equal(ler(""), null);
});

// ---------- Híbrido: regras primeiro, IA como reserva ----------

const ctxSimples: ContextoInterpretacao = {
  texto: "",
  hoje: "2026-11-07",
  diaDaSemana: "sábado",
  contas: CONTAS,
  categorias: CATEGORIAS_PADRAO,
};

Deno.test("híbrido: quando as regras entendem, a IA nem é chamada", async () => {
  let chamadasIa = 0;
  const h = criarInterpretadorHibrido({ interpretar: () => (chamadasIa++, Promise.reject(new Error("x"))) }, () => {});
  const r = await h.interpretar({ ...ctxSimples, texto: "uber 23" });
  assert.equal(r.intencao, "registrar");
  assert.equal(chamadasIa, 0);
});

Deno.test("híbrido: frase difícil vai para a IA; se a IA falhar (sem crédito), pede para reescrever", async () => {
  const respostaIa: Interpretacao = { intencao: "fora_do_escopo", lancamentos: [], resumo: null, correcao: null, pergunta: null };
  const comIa = criarInterpretadorHibrido({ interpretar: () => Promise.resolve(respostaIa) }, () => {});
  assert.equal((await comIa.interpretar({ ...ctxSimples, texto: "me conta uma piada" })).intencao, "fora_do_escopo");

  const logs: string[] = [];
  const iaSemCredito = criarInterpretadorHibrido(
    { interpretar: () => Promise.reject(new Error("Your credit balance is too low")) },
    (e) => logs.push(e),
  );
  const r = await iaSemCredito.interpretar({ ...ctxSimples, texto: "almocei fora" });
  assert.equal(r.intencao, "esclarecer");
  assert.equal(r.pergunta, TEXTO_NAO_ENTENDI);
  assert.deepEqual(logs, ["ia_indisponivel"]);

  const semIa = criarInterpretadorHibrido(null, () => {});
  assert.equal((await semIa.interpretar({ ...ctxSimples, texto: "almocei fora" })).pergunta, TEXTO_NAO_ENTENDI);
});

Deno.test("de ponta a ponta sem IA: a mensagem do Telegram vira lançamento", async () => {
  const { deps, repo, enviadas } = criarDeps();
  deps.interpretador = criarInterpretadorHibrido(null, () => {});
  await processarMensagem(mensagemTelegram(`/start ${CODIGO_VINCULO}`), deps);
  await processarMensagem(mensagemTelegram("Almoço 35 em dinheiro"), deps);
  await processarMensagem(mensagemTelegram("almocei fora"), deps);

  assert.equal(repo.transacoes.length, 1);
  assert.equal(repo.transacoes[0].valorCentavos, 3500);
  assert.equal(repo.transacoes[0].contaId, "c-din");
  assert.equal(repo.transacoes[0].categoriaId, "k-alim");
  assert.match(enviadas[1].texto, /R\$ 35,00 — Almoço/);
  assert.equal(enviadas[2].texto, TEXTO_NAO_ENTENDI);
});
