// Integração com a WhatsApp Cloud API (oficial da Meta).
import type { EnviadorWhatsApp, MensagemRecebida } from "./tipos.ts";

const codificador = new TextEncoder();

function paraHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparação em tempo constante, para não vazar a assinatura por tempo de resposta. */
function iguaisTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

/**
 * Confere o cabeçalho X-Hub-Signature-256 (HMAC-SHA256 do corpo BRUTO com o App Secret).
 * Sem isso, qualquer pessoa que descobrir a URL do webhook consegue lançar gastos.
 */
export async function assinaturaValida(
  corpo: Uint8Array,
  cabecalho: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!cabecalho?.startsWith("sha256=") || !appSecret) return false;
  const chave = await crypto.subtle.importKey(
    "raw",
    codificador.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const esperado = paraHex(await crypto.subtle.sign("HMAC", chave, corpo as BufferSource));
  return iguaisTempoConstante(esperado, cabecalho.slice("sha256=".length).toLowerCase());
}

/** Responde ao "aperto de mão" que a Meta faz quando você cadastra o webhook. */
export function respostaVerificacao(url: URL, verifyToken: string): Response {
  const modo = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const desafio = url.searchParams.get("hub.challenge");
  if (modo === "subscribe" && verifyToken && token === verifyToken && desafio) {
    return new Response(desafio, { status: 200 });
  }
  return new Response("Proibido", { status: 403 });
}

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const texto = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Extrai as mensagens do payload do webhook. Ignora avisos de entrega/leitura (`statuses`).
 * Parsing defensivo: o formato vem de fora, então nada de confiar cegamente nele.
 */
export function extrairMensagens(payload: unknown): MensagemRecebida[] {
  if (!ehObj(payload) || payload.object !== "whatsapp_business_account") return [];
  const resultado: MensagemRecebida[] = [];

  for (const entrada of lista(payload.entry)) {
    if (!ehObj(entrada)) continue;
    for (const mudanca of lista(entrada.changes)) {
      if (!ehObj(mudanca) || mudanca.field !== "messages" || !ehObj(mudanca.value)) continue;
      const valor = mudanca.value;
      const phoneNumberId = ehObj(valor.metadata) ? texto(valor.metadata.phone_number_id) : null;
      if (!phoneNumberId) continue;

      const nomes = new Map<string, string>();
      for (const contato of lista(valor.contacts)) {
        if (!ehObj(contato)) continue;
        const waId = texto(contato.wa_id);
        const nome = ehObj(contato.profile) ? texto(contato.profile.name) : null;
        if (waId && nome) nomes.set(waId, nome);
      }

      for (const m of lista(valor.messages)) {
        if (!ehObj(m)) continue;
        const wamid = texto(m.id);
        const de = texto(m.from);
        const tipo = texto(m.type);
        if (!wamid || !de || !tipo) continue;
        resultado.push({
          wamid,
          de,
          nomePerfil: nomes.get(de) ?? null,
          tipo,
          texto: tipo === "text" && ehObj(m.text) ? texto(m.text.body) : null,
          phoneNumberId,
        });
      }
    }
  }
  return resultado;
}

export function criarEnviadorWhatsApp(opcoes: {
  accessToken: string;
  versaoApi: string;
  fetch?: typeof fetch;
}): EnviadorWhatsApp {
  const fazerFetch = opcoes.fetch ?? fetch;
  return {
    async enviarTexto({ phoneNumberId, para, texto, responderA }) {
      const resposta = await fazerFetch(
        `https://graph.facebook.com/${opcoes.versaoApi}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opcoes.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: para,
            type: "text",
            text: { body: texto, preview_url: false },
            ...(responderA ? { context: { message_id: responderA } } : {}),
          }),
        },
      );
      if (!resposta.ok) {
        const detalhe = (await resposta.text()).slice(0, 500);
        throw new Error(`WhatsApp respondeu ${resposta.status}: ${detalhe}`);
      }
    },
  };
}
