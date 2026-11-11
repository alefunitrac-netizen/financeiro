// Lembretes automáticos: fatura vencendo, resumo da semana, saldo negativo, e o liga/desliga.
import assert from "node:assert/strict";
import { criarInterpretadorHibrido } from "../_shared/interpretador_hibrido.ts";
import { criarLembretes } from "../_shared/lembretes.ts";
import { processarMensagem } from "../_shared/processador.ts";
import { criarHandlerTelegram } from "../_shared/telegram.ts";
import { criarDeps, mensagem } from "./fakes.ts";

function cenario() {
  const r = criarDeps();
  r.deps.interpretador = criarInterpretadorHibrido(null, () => {});
  r.repo.usuarios[0].telegramId = "777000111";
  let agora = new Date("2026-11-07T11:07:00Z"); // sábado, 8h07 em São Paulo
  const avisos: { para: string; texto: string }[] = [];
  let falhar = false;
  const lembretes = criarLembretes({
    repo: r.repo,
    agora: () => agora,
    avisar: (para, texto) => {
      if (falhar) return Promise.reject(new Error("Telegram fora"));
      avisos.push({ para, texto });
      return Promise.resolve();
    },
    log: () => {},
  });
  const enviar = async (texto: string) => {
    await processarMensagem(mensagem(texto), r.deps);
    return r.enviadas[r.enviadas.length - 1].texto;
  };
  /** Roda os lembretes no dia dado (8h07 de São Paulo) e devolve só o que saiu nessa rodada. */
  const rodarEm = async (dia: string) => {
    agora = new Date(`${dia}T11:07:00Z`);
    const antes = avisos.length;
    const total = await lembretes.rodar();
    return { total, novos: avisos.slice(antes).map((a) => a.texto) };
  };
  return { ...r, avisos, enviar, rodarEm, falhar: (v: boolean) => (falhar = v) };
}

Deno.test("fatura informada: avisa 3 dias antes, no dia e depois de vencer, sem repetir", async () => {
  const c = cenario();
  await c.enviar("fatura nubank 1547 vence dia 10");
  const itau = c.repo.contas.find((x) => x.id === "c-itau")!;
  itau.saldoCentavos = 50000;
  itau.saldoAtualizadoEm = "2026-11-06T23:00:00Z";

  let r = await c.rodarEm("2026-11-07");
  assert.equal(r.novos.length, 1);
  assert.match(r.novos[0], /Fatura do Nubank crédito vence em 3 dias\* \(terça-feira, 10\/11\): \*R\$ 1\.547,00\*/);
  assert.match(r.novos[0], /faltam \*R\$ 1\.047,00\* para cobrir/);
  assert.match(r.novos[0], /Quando pagar, responda: paguei a fatura do nubank/);

  // A rodada pode rodar de novo (ou no dia seguinte) sem repetir o aviso.
  assert.equal((await c.rodarEm("2026-11-07")).novos.length, 0);
  assert.equal((await c.rodarEm("2026-11-08")).novos.length, 0);

  r = await c.rodarEm("2026-11-10");
  assert.equal(r.novos.length, 1);
  assert.match(r.novos[0], /vence hoje\*: \*R\$ 1\.547,00\*/);

  r = await c.rodarEm("2026-11-11");
  assert.match(r.novos[0], /venceu ontem\*/);
  assert.match(r.novos[0], /Já pagou\? responda: paguei a fatura do nubank/);

  // "paguei a fatura do nubank" (sem valor) tira a fatura de "a pagar".
  const resposta = await c.enviar("paguei a fatura do nubank");
  assert.match(resposta, /Fatura paga:\*? R\$ 1\.547,00/);
  assert.equal(c.repo.transacoes.find((t) => t.tipo === "pagamento_fatura")!.status, "confirmado");
  assert.match(await c.enviar("desfazer"), /Desfeito:\* o pagamento de R\$ 1\.547,00/);
  assert.equal(c.repo.transacoes.find((t) => t.tipo === "pagamento_fatura")!.status, "informado");
});

Deno.test("fatura calculada pelas compras avisa com o valor até agora", async () => {
  const c = cenario();
  c.repo.contas.find((x) => x.id === "c-nu")!.diaFechamento = 1; // compra de hoje vai para a fatura de 10/12
  await c.enviar("tv 3000 em 10x no nubank");
  const r = await c.rodarEm("2026-12-08");
  assert.equal(r.novos.length, 1);
  assert.match(r.novos[0], /vence em 2 dias\* \(quinta-feira, 10\/12\): \*R\$ 300,00\* _\(compras até agora\)_/);
  assert.match(r.novos[0], /fatura nubank 1547 vence dia 10/);
});

Deno.test("resumo da semana sai na segunda, comparado com a semana anterior", async () => {
  const c = cenario();
  await c.enviar("mercado 100 dia 30"); // 30/10, semana anterior
  await c.enviar("uber 23 ontem"); // 06/11
  await c.enviar("almoço 45"); // 07/11

  assert.equal((await c.rodarEm("2026-11-08")).novos.length, 0, "domingo não tem resumo");
  const r = await c.rodarEm("2026-11-09");
  assert.equal(r.novos.length, 1);
  const texto = r.novos[0];
  assert.match(texto, /Semana passada \(02\/11 a 08\/11\)/);
  assert.match(texto, /Saiu: \*R\$ 68,00\*/);
  assert.match(texto, /Alimentação: R\$ 45,00/);
  assert.doesNotMatch(texto, /Mercado/);
  assert.match(texto, /🔻 Gastou 32% a menos que na semana anterior \(R\$ 100,00\)/);
  assert.equal((await c.rodarEm("2026-11-09")).novos.length, 0);

  // Semana sem nada registrado: não manda resumo vazio.
  assert.equal((await c.rodarEm("2026-11-23")).novos.length, 0);
});

Deno.test("conta no negativo avisa no máximo uma vez por semana", async () => {
  const c = cenario();
  const itau = c.repo.contas.find((x) => x.id === "c-itau")!;
  itau.saldoCentavos = -23000;
  itau.saldoAtualizadoEm = "2026-11-10T23:00:00Z";
  let r = await c.rodarEm("2026-11-11");
  assert.match(r.novos[0], /Itaú está no negativo\*: -R\$ 230,00/);
  assert.equal((await c.rodarEm("2026-11-12")).novos.length, 0);
  itau.saldoAtualizadoEm = "2026-11-16T23:00:00Z";
  r = await c.rodarEm("2026-11-17");
  assert.equal(r.novos.length, 1, "semana nova, avisa de novo");
  // Saldo velho (banco sem atualizar há dias) não gera aviso.
  itau.saldoAtualizadoEm = "2026-11-16T23:00:00Z";
  assert.equal((await c.rodarEm("2026-11-25")).novos.length, 0);
});

Deno.test("se o envio falha, o aviso fica para a próxima rodada", async () => {
  const c = cenario();
  await c.enviar("fatura nubank 1547 vence dia 10");
  c.falhar(true);
  const r = await c.rodarEm("2026-11-07");
  assert.equal(r.total.erros, 1);
  assert.equal(c.repo.avisos.size, 0);
  c.falhar(false);
  assert.equal((await c.rodarEm("2026-11-07")).novos.length, 1);
});

Deno.test("parar, ligar e consultar os lembretes", async () => {
  const c = cenario();
  await c.enviar("fatura nubank 1547 vence dia 10");
  assert.match(await c.enviar("parar lembretes"), /Lembretes desligados/);
  assert.equal(c.repo.lembretes, false);
  assert.equal((await c.rodarEm("2026-11-07")).total.usuarios, 0);
  assert.match(await c.enviar("lembretes"), /desligados/);
  assert.match(await c.enviar("ligar lembretes"), /Lembretes ligados/);
  assert.match(await c.enviar("quero os avisos de volta"), /Lembretes ligados/);
  assert.match(await c.enviar("desativar avisos"), /desligados/);
  assert.match(await c.enviar("não quero lembretes"), /desligados/);
  assert.equal(c.repo.transacoes.length, 1, "nada disso virou lançamento");
});

Deno.test("webhook: GET ?acao=lembretes roda a rodada do dia", async () => {
  let rodou = 0;
  const handler = criarHandlerTelegram({
    segredo: "s",
    processar: () => Promise.resolve(),
    emSegundoPlano: () => {},
    configurar: () => Promise.resolve({ ok: true }),
    lembretes: () => {
      rodou++;
      return Promise.resolve({ usuarios: 1, mensagens: 1, erros: 0 });
    },
    log: () => {},
  });
  const r = await handler(new Request("https://x/?acao=lembretes"));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, usuarios: 1, mensagens: 1, erros: 0 });
  assert.equal(rodou, 1);
});
