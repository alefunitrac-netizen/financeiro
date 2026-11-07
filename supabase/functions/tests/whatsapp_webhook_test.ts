import assert from "node:assert/strict";
import { criarHandler } from "../_shared/webhook.ts";
import { assinaturaValida, criarEnviadorWhatsApp, extrairMensagens } from "../_shared/whatsapp.ts";
import type { MensagemRecebida } from "../_shared/tipos.ts";

const SEGREDO = "app-secret-de-teste";

async function assinar(corpo: string, segredo = SEGREDO): Promise<string> {
  const chave = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(corpo));
  return "sha256=" + Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Formato real do webhook da Meta (campos irrelevantes omitidos)
function payloadTexto(texto: string, wamid = "wamid.ABC") {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "5511900000000", phone_number_id: "PHONE1" },
          contacts: [{ profile: { name: "Maria" }, wa_id: "551187654321" }],
          messages: [{ from: "551187654321", id: wamid, timestamp: "1762538400", type: "text", text: { body: texto } }],
        },
      }],
    }],
  };
}

Deno.test("assinatura HMAC: aceita a certa, recusa errada/ausente/sem segredo", async () => {
  const corpo = JSON.stringify(payloadTexto("almoço 45 — açaí"));
  const bytes = new TextEncoder().encode(corpo);
  assert.ok(await assinaturaValida(bytes, await assinar(corpo), SEGREDO));
  assert.ok(!(await assinaturaValida(bytes, await assinar(corpo, "outro"), SEGREDO)));
  assert.ok(!(await assinaturaValida(bytes, null, SEGREDO)));
  assert.ok(!(await assinaturaValida(bytes, "md5=abc", SEGREDO)));
  assert.ok(!(await assinaturaValida(bytes, await assinar(corpo), "")));
  assert.ok(!(await assinaturaValida(new TextEncoder().encode(corpo + " "), await assinar(corpo), SEGREDO)));
});

Deno.test("extrai mensagens de texto e ignora status de entrega", () => {
  const msgs = extrairMensagens(payloadTexto("uber 23"));
  assert.deepEqual(msgs, [{
    wamid: "wamid.ABC",
    de: "551187654321",
    nomePerfil: "Maria",
    tipo: "text",
    texto: "uber 23",
    phoneNumberId: "PHONE1",
  }]);

  const status = {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "P" }, statuses: [{ id: "x", status: "read" }] } }] }],
  };
  assert.deepEqual(extrairMensagens(status), []);
  assert.deepEqual(extrairMensagens({ object: "page" }), []);
  assert.deepEqual(extrairMensagens(null), []);
  assert.deepEqual(extrairMensagens({ object: "whatsapp_business_account", entry: "lixo" }), []);
});

Deno.test("mensagem de áudio vem sem texto", () => {
  const p = payloadTexto("x");
  // deno-lint-ignore no-explicit-any
  (p.entry[0].changes[0].value.messages[0] as any) = { from: "551187654321", id: "w2", type: "audio", audio: { id: "MEDIA" } };
  const [m] = extrairMensagens(p);
  assert.equal(m.tipo, "audio");
  assert.equal(m.texto, null);
});

function criar() {
  const processadas: MensagemRecebida[] = [];
  const tarefas: Promise<unknown>[] = [];
  const handler = criarHandler({
    verifyToken: "token-verificacao",
    appSecret: SEGREDO,
    processar: (m) => {
      processadas.push(m);
      return Promise.resolve();
    },
    emSegundoPlano: (t) => tarefas.push(t),
    log: () => {},
  });
  return { handler, processadas, tarefas };
}

Deno.test("webhook: verificação GET da Meta", async () => {
  const { handler } = criar();
  const ok = await handler(new Request("https://x/?hub.mode=subscribe&hub.verify_token=token-verificacao&hub.challenge=12345"));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "12345");
  const ruim = await handler(new Request("https://x/?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=12345"));
  assert.equal(ruim.status, 403);
});

Deno.test("webhook: POST assinado responde 200 e processa em segundo plano", async () => {
  const { handler, processadas, tarefas } = criar();
  const corpo = JSON.stringify(payloadTexto("mercado 230"));
  const resp = await handler(
    new Request("https://x/", { method: "POST", body: corpo, headers: { "x-hub-signature-256": await assinar(corpo) } }),
  );
  assert.equal(resp.status, 200);
  await Promise.all(tarefas);
  assert.equal(processadas.length, 1);
  assert.equal(processadas[0].texto, "mercado 230");
});

Deno.test("webhook: POST sem assinatura válida é recusado e nada é processado", async () => {
  const { handler, processadas, tarefas } = criar();
  const corpo = JSON.stringify(payloadTexto("mercado 230"));
  const resp = await handler(
    new Request("https://x/", { method: "POST", body: corpo, headers: { "x-hub-signature-256": "sha256=00" } }),
  );
  assert.equal(resp.status, 401);
  assert.equal(tarefas.length, 0);
  assert.equal(processadas.length, 0);
  assert.equal((await handler(new Request("https://x/", { method: "PUT" }))).status, 405);
});

Deno.test("enviador monta a chamada da Cloud API e propaga erro", async () => {
  const chamadas: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const enviador = criarEnviadorWhatsApp({
    accessToken: "TOKEN",
    versaoApi: "v23.0",
    fetch: (url, init) => {
      chamadas.push({ url: String(url), init: init! });
      return Promise.resolve(new Response("{}", { status }));
    },
  });
  await enviador.enviarTexto({ phoneNumberId: "PHONE1", para: "551187654321", texto: "oi", responderA: "wamid.ABC" });
  assert.equal(chamadas[0].url, "https://graph.facebook.com/v23.0/PHONE1/messages");
  assert.equal((chamadas[0].init.headers as Record<string, string>).Authorization, "Bearer TOKEN");
  assert.deepEqual(JSON.parse(chamadas[0].init.body as string), {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "551187654321",
    type: "text",
    text: { body: "oi", preview_url: false },
    context: { message_id: "wamid.ABC" },
  });

  status = 401;
  await assert.rejects(enviador.enviarTexto({ phoneNumberId: "P", para: "1", texto: "x" }), /WhatsApp respondeu 401/);
});
