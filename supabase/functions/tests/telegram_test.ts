import assert from "node:assert/strict";
import { processarMensagem } from "../_shared/processador.ts";
import {
  configurarBotTelegram,
  criarHandlerTelegram,
  criarMensageiroTelegram,
  extrairMensagemTelegram,
  paraHtmlTelegram,
  segredoDoWebhook,
  semMarcacao,
} from "../_shared/telegram.ts";
import type { MensagemRecebida } from "../_shared/tipos.ts";
import { CODIGO_VINCULO, criarDeps, interpretacao, mensagemTelegram } from "./fakes.ts";

// Formato real de uma atualização do Telegram (campos irrelevantes omitidos)
function atualizacao(parcial: Record<string, unknown> = {}) {
  return {
    update_id: 900001,
    message: {
      message_id: 42,
      from: { id: 777000111, is_bot: false, first_name: "Maria", last_name: "Silva", language_code: "pt-br" },
      chat: { id: 777000111, first_name: "Maria", type: "private" },
      date: 1794188307,
      text: "uber 23",
      ...parcial,
    },
  };
}

Deno.test("lê mensagem de texto em conversa privada", () => {
  assert.deepEqual(extrairMensagemTelegram(atualizacao()), {
    canal: "telegram",
    idExterno: "777000111:42",
    remetente: "777000111",
    nomePerfil: "Maria Silva",
    tipo: "text",
    texto: "uber 23",
    chatId: 777000111,
    messageId: 42,
  });
});

Deno.test("ignora grupos, bots, edições e lixo; identifica áudio e foto", () => {
  assert.equal(extrairMensagemTelegram(atualizacao({ chat: { id: -100, type: "group" } })), null);
  assert.equal(extrairMensagemTelegram(atualizacao({ from: { id: 1, is_bot: true } })), null);
  assert.equal(extrairMensagemTelegram({ update_id: 1, edited_message: atualizacao().message }), null);
  assert.equal(extrairMensagemTelegram(null), null);
  assert.equal(extrairMensagemTelegram({ message: "x" }), null);

  const voz = extrairMensagemTelegram(atualizacao({ text: undefined, voice: { file_id: "F" } }));
  assert.equal(voz?.tipo, "voice");
  assert.equal(voz?.texto, null);
  assert.equal(extrairMensagemTelegram(atualizacao({ text: undefined, photo: [] }))?.tipo, "photo");
});

Deno.test("converte a marcação para HTML do Telegram, escapando o resto", () => {
  assert.equal(paraHtmlTelegram("✅ *Registrado:* R$ 47,90 — iFood"), "✅ <b>Registrado:</b> R$ 47,90 — iFood");
  assert.equal(
    paraHtmlTelegram("_Errei? Responda *desfazer* ou *corrigir: …*_"),
    "<i>Errei? Responda <b>desfazer</b> ou <b>corrigir: …</b></i>",
  );
  assert.equal(paraHtmlTelegram("• _uber 23 ontem_\n• x"), "• <i>uber 23 ontem</i>\n• x");
  assert.equal(paraHtmlTelegram("tipo: _almoço 35_."), "tipo: <i>almoço 35</i>.");
  assert.equal(paraHtmlTelegram("A&B <script> café_da_manhã"), "A&amp;B &lt;script&gt; café_da_manhã");
  assert.equal(semMarcacao("✅ *Registrado:* x\n_Errei? *desfazer*_"), "✅ Registrado: x\nErrei? desfazer");
});

Deno.test("segredo do webhook é fixo para o mesmo token e muda com o token", async () => {
  const a = await segredoDoWebhook("123:ABC");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await segredoDoWebhook("123:ABC"));
  assert.notEqual(a, await segredoDoWebhook("123:ABD"));
});

function criarHandler() {
  const processadas: MensagemRecebida[] = [];
  const tarefas: Promise<unknown>[] = [];
  let configurou = 0;
  const handler = criarHandlerTelegram({
    segredo: "segredo-certo",
    processar: (m) => {
      processadas.push(m);
      return Promise.resolve();
    },
    emSegundoPlano: (t) => tarefas.push(t),
    configurar: () => {
      configurou++;
      return Promise.resolve({ ok: true, bot: "meu_financeiro_bot" });
    },
    log: () => {},
  });
  return { handler, processadas, tarefas, configurou: () => configurou };
}

const post = (corpo: unknown, segredo?: string) =>
  new Request("https://x/", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: segredo ? { "x-telegram-bot-api-secret-token": segredo } : {},
  });

Deno.test("webhook: só aceita chamadas com o segredo certo", async () => {
  const { handler, processadas, tarefas } = criarHandler();
  assert.equal((await handler(post(atualizacao()))).status, 401);
  assert.equal((await handler(post(atualizacao(), "segredo-errado"))).status, 401);
  assert.equal(tarefas.length, 0);

  const ok = await handler(post(atualizacao(), "segredo-certo"));
  assert.equal(ok.status, 200);
  await Promise.all(tarefas);
  assert.equal(processadas[0].texto, "uber 23");
});

Deno.test("webhook: responde 200 a atualizações que não são mensagem, sem processar", async () => {
  const { handler, tarefas } = criarHandler();
  const r = await handler(post({ update_id: 5, my_chat_member: {} }, "segredo-certo"));
  assert.equal(r.status, 200);
  assert.equal(tarefas.length, 0);
});

Deno.test("webhook: segredo vazio (token não configurado) recusa tudo", async () => {
  const handler = criarHandlerTelegram({
    segredo: "",
    processar: () => Promise.resolve(),
    emSegundoPlano: () => {},
    configurar: () => Promise.resolve({ ok: false }),
    log: () => {},
  });
  assert.equal((await handler(post(atualizacao(), ""))).status, 401);
});

Deno.test("webhook: GET ?acao=configurar registra o bot", async () => {
  const { handler, configurou } = criarHandler();
  const r = await handler(new Request("https://x/?acao=configurar"));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, bot: "meu_financeiro_bot" });
  assert.equal(configurou(), 1);
  assert.equal((await handler(new Request("https://x/"))).status, 200);
  assert.equal(configurou(), 1);
  assert.equal((await handler(new Request("https://x/", { method: "PUT" }))).status, 405);
});

Deno.test("configurarBotTelegram aponta o webhook, cadastra comandos e devolve o nome do bot", async () => {
  const chamadas: { metodo: string; corpo: Record<string, unknown> }[] = [];
  const r = await configurarBotTelegram({
    token: "123:ABC",
    segredo: "s3gr3do",
    url: "https://proj.supabase.co/functions/v1/telegram-webhook",
    fetch: (url, init) => {
      const metodo = String(url).split("/").pop()!;
      chamadas.push({ metodo, corpo: JSON.parse(init!.body as string) });
      const result = metodo === "getMe" ? { username: "meu_financeiro_bot" } : true;
      return Promise.resolve(Response.json({ ok: true, result }));
    },
  });
  assert.deepEqual(r, { ok: true, bot: "meu_financeiro_bot" });
  assert.deepEqual(chamadas.map((c) => c.metodo), ["setWebhook", "setMyCommands", "getMe"]);
  assert.equal(chamadas[0].corpo.url, "https://proj.supabase.co/functions/v1/telegram-webhook");
  assert.equal(chamadas[0].corpo.secret_token, "s3gr3do");
  assert.deepEqual(chamadas[0].corpo.allowed_updates, ["message"]);

  assert.deepEqual(await configurarBotTelegram({ token: "", segredo: "", url: "" }), {
    ok: false,
    erro: "TELEGRAM_BOT_TOKEN não configurado",
  });
  const falha = await configurarBotTelegram({
    token: "1:X",
    segredo: "s",
    url: "u",
    fetch: () => Promise.resolve(Response.json({ ok: false, description: "Unauthorized" }, { status: 401 })),
  });
  assert.deepEqual(falha, { ok: false, erro: "setWebhook: Unauthorized" });
});

Deno.test("mensageiro manda HTML respondendo à mensagem e cai para texto puro se o Telegram recusar", async () => {
  const corpos: Record<string, unknown>[] = [];
  const status = [400, 200];
  const mensageiro = criarMensageiroTelegram({
    token: "123:ABC",
    fetch: (url, init) => {
      assert.equal(String(url), "https://api.telegram.org/bot123:ABC/sendMessage");
      corpos.push(JSON.parse(init!.body as string));
      return Promise.resolve(new Response("{}", { status: status.shift() }));
    },
  });
  const msg = extrairMensagemTelegram(atualizacao())!;
  await mensageiro.responder(msg, "✅ *Registrado:* R$ 23,00");

  assert.equal(corpos[0].parse_mode, "HTML");
  assert.equal(corpos[0].text, "✅ <b>Registrado:</b> R$ 23,00");
  assert.equal(corpos[0].chat_id, 777000111);
  assert.deepEqual(corpos[0].reply_parameters, { message_id: 42, allow_sending_without_reply: true });
  assert.equal(corpos[1].parse_mode, undefined);
  assert.equal(corpos[1].text, "✅ Registrado: R$ 23,00");

  const quebrado = criarMensageiroTelegram({
    token: "1:X",
    fetch: () => Promise.resolve(new Response("erro", { status: 500 })),
  });
  await assert.rejects(quebrado.responder(msg, "x"), /Telegram respondeu 500/);
});

// ---------- Vínculo do Telegram no núcleo ----------

Deno.test("link de vínculo liga o Telegram ao usuário e o código não serve duas vezes", async () => {
  const { deps, repo, enviadas } = criarDeps([interpretacao({ lancamentos: [] })]);

  await processarMensagem(mensagemTelegram(`/start ${CODIGO_VINCULO}`), deps);
  assert.match(enviadas[0].texto, /Seu Telegram está ligado/);
  assert.match(enviadas[0].texto, /Oi, Maria!/);
  assert.equal(repo.usuarios[0].telegramId, "777000111");
  assert.equal(repo.usuarios[0].codigoVinculo, null);

  // Outra pessoa tentando o mesmo código: não vincula e só recebe o aviso de bot privado.
  await processarMensagem(mensagemTelegram(`/start ${CODIGO_VINCULO}`, "999"), deps);
  assert.equal(enviadas[1].texto, "🔒 Este bot é privado.");
  assert.equal(repo.usuarios[0].telegramId, "777000111");
});

Deno.test("depois de vinculado, o Telegram registra gastos como o WhatsApp", async () => {
  const { deps, repo, enviadas } = criarDeps([
    interpretacao({
      lancamentos: [{
        tipo: "despesa",
        descricao: "Uber",
        estabelecimento: null,
        valor: "23.00",
        valor_refere_se_a: "total",
        parcelas: null,
        data: "2026-11-07",
        conta: "Nubank crédito",
        categoria: "Transporte",
      }],
    }),
  ]);
  await processarMensagem(mensagemTelegram(`/start ${CODIGO_VINCULO}`), deps);
  await processarMensagem(mensagemTelegram("uber 23 no nubank"), deps);
  await processarMensagem(mensagemTelegram("/start"), deps); // abrir o bot de novo mostra a ajuda

  assert.equal(repo.transacoes.length, 1);
  assert.equal(repo.transacoes[0].valorCentavos, 2300);
  assert.match(enviadas[1].texto, /R\$ 23,00 — Uber/);
  assert.equal(enviadas[1].canal, "telegram");
  assert.match(enviadas[2].texto, /Oi, Maria!/);
  assert.deepEqual([...repo.mensagens.values()].map((m) => m.canal), ["telegram", "telegram", "telegram"]);
});

Deno.test("desconhecido no Telegram: /start recebe aviso curto, o resto é ignorado e nada é gravado", async () => {
  const { deps, repo, enviadas, pedidosIA } = criarDeps([]);
  await processarMensagem(mensagemTelegram("/start", "555"), deps);
  await processarMensagem(mensagemTelegram("gastei 50", "555"), deps);
  await processarMensagem(mensagemTelegram("/start codigo-que-nao-existe-123", "555"), deps);
  assert.deepEqual(enviadas.map((e) => e.texto), ["🔒 Este bot é privado.", "🔒 Este bot é privado."]);
  assert.equal(repo.mensagens.size, 0);
  assert.equal(pedidosIA.length, 0);
});

Deno.test("mesma mensagem do Telegram entregue duas vezes não duplica", async () => {
  const { deps, repo, enviadas } = criarDeps([]);
  await processarMensagem(mensagemTelegram(`/start ${CODIGO_VINCULO}`), deps);
  const m = mensagemTelegram("ajuda");
  await processarMensagem(m, deps);
  await processarMensagem(m, deps);
  assert.equal(enviadas.length, 2);
  assert.equal(repo.mensagens.size, 2);
});
