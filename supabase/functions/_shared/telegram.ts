// Integração com a Bot API do Telegram (oficial, gratuita, sem verificação de empresa).
import type { Mensageiro, MensagemRecebida } from "./tipos.ts";

const API = "https://api.telegram.org";

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const inteiro = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const texto = (v: unknown): string | null => (typeof v === "string" ? v : null);

function iguaisTempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

/**
 * Segredo que o Telegram manda no cabeçalho X-Telegram-Bot-Api-Secret-Token de cada chamada.
 * É derivado do token do bot, então não existe mais um segredo para você guardar.
 */
export async function segredoDoWebhook(tokenBot: string): Promise<string> {
  const dados = new TextEncoder().encode(`financeiro-telegram-webhook:${tokenBot}`);
  const hash = await crypto.subtle.digest("SHA-256", dados);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lê uma atualização do Telegram. Só aceita mensagens em conversa privada, enviadas por pessoas. */
export function extrairMensagemTelegram(atualizacao: unknown): MensagemRecebida | null {
  if (!ehObj(atualizacao) || !ehObj(atualizacao.message)) return null;
  const m = atualizacao.message;
  if (!ehObj(m.chat) || m.chat.type !== "private") return null;
  if (!ehObj(m.from) || m.from.is_bot === true) return null;

  const chatId = inteiro(m.chat.id);
  const messageId = inteiro(m.message_id);
  const usuarioId = inteiro(m.from.id);
  if (chatId === null || messageId === null || usuarioId === null) return null;

  const corpo = texto(m.text);
  const tipo = corpo !== null
    ? "text"
    : (["voice", "audio", "photo", "video", "document", "sticker", "location", "contact"].find((k) => k in m) ??
      "outro");
  const nome = [texto(m.from.first_name), texto(m.from.last_name)].filter(Boolean).join(" ");

  return {
    canal: "telegram",
    idExterno: `${chatId}:${messageId}`,
    remetente: String(usuarioId),
    nomePerfil: nome || null,
    tipo,
    texto: corpo,
    chatId,
    messageId,
  };
}

function escaparHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Converte a marcação do WhatsApp (*negrito*, _itálico_) para o HTML que o Telegram aceita. */
export function paraHtmlTelegram(s: string): string {
  return escaparHtml(s)
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");
}

/** Plano B se o Telegram recusar o HTML: texto puro, sem os símbolos de marcação. */
export function semMarcacao(s: string): string {
  return s.replace(/\*([^*\n]+)\*/g, "$1").replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1$2");
}

export function criarMensageiroTelegram(opcoes: { token: string; fetch?: typeof fetch }): Mensageiro {
  const fazerFetch = opcoes.fetch ?? fetch;

  async function enviar(corpo: Obj): Promise<Response> {
    return await fazerFetch(`${API}/bot${opcoes.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
  }

  return {
    async responder(msg, texto) {
      if (msg.canal !== "telegram") throw new Error(`Mensageiro do Telegram não responde no canal ${msg.canal}`);
      const base = {
        chat_id: msg.chatId,
        reply_parameters: { message_id: msg.messageId, allow_sending_without_reply: true },
        link_preview_options: { is_disabled: true },
      };
      let resposta = await enviar({ ...base, text: paraHtmlTelegram(texto), parse_mode: "HTML" });
      if (resposta.status === 400) {
        await resposta.body?.cancel();
        resposta = await enviar({ ...base, text: semMarcacao(texto) });
      }
      if (!resposta.ok) {
        const detalhe = (await resposta.text()).slice(0, 500);
        throw new Error(`Telegram respondeu ${resposta.status}: ${detalhe}`);
      }
    },
  };
}

/**
 * Aponta o bot para esta função e cadastra o menu de comandos. Pode ser chamada quantas vezes
 * quiser: sempre aponta para a mesma URL, com o mesmo segredo.
 */
export async function configurarBotTelegram(opcoes: {
  token: string;
  segredo: string;
  url: string;
  fetch?: typeof fetch;
}): Promise<{ ok: boolean; bot?: string; erro?: string }> {
  const fazerFetch = opcoes.fetch ?? fetch;
  if (!opcoes.token) return { ok: false, erro: "TELEGRAM_BOT_TOKEN não configurado" };

  async function chamar(metodo: string, corpo: Obj): Promise<Obj> {
    const r = await fazerFetch(`${API}/bot${opcoes.token}/${metodo}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const json = await r.json() as Obj;
    if (json.ok !== true) throw new Error(`${metodo}: ${String(json.description ?? r.status)}`);
    return json;
  }

  try {
    await chamar("setWebhook", {
      url: opcoes.url,
      secret_token: opcoes.segredo,
      allowed_updates: ["message"],
      max_connections: 1,
    });
    await chamar("setMyCommands", {
      commands: [
        { command: "resumo", description: "Resumo do mês" },
        { command: "desfazer", description: "Cancela o último lançamento" },
        { command: "ajuda", description: "Exemplos do que eu entendo" },
      ],
    });
    const eu = await chamar("getMe", {});
    const usuario = ehObj(eu.result) ? texto(eu.result.username) : null;
    return { ok: true, bot: usuario ?? undefined };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
}

export interface OpcoesWebhookTelegram {
  segredo: string;
  processar: (m: MensagemRecebida) => Promise<void>;
  emSegundoPlano: (tarefa: Promise<unknown>) => void;
  configurar: () => Promise<{ ok: boolean; bot?: string; erro?: string }>;
  log: (evento: string, dados?: Record<string, unknown>) => void;
}

/** Camada HTTP do webhook do Telegram. GET ?acao=configurar registra o webhook no Telegram. */
export function criarHandlerTelegram(op: OpcoesWebhookTelegram): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "GET") {
      if (new URL(req.url).searchParams.get("acao") !== "configurar") return new Response("ok", { status: 200 });
      const r = await op.configurar();
      return Response.json(r, { status: r.ok ? 200 : 500 });
    }
    if (req.method !== "POST") return new Response("Método não permitido", { status: 405 });

    const recebido = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!op.segredo || !iguaisTempoConstante(recebido, op.segredo)) {
      op.log("segredo_invalido");
      return new Response("Não autorizado", { status: 401 });
    }

    let atualizacao: unknown;
    try {
      atualizacao = await req.json();
    } catch {
      return new Response("JSON inválido", { status: 400 });
    }

    const msg = extrairMensagemTelegram(atualizacao);
    if (msg) {
      op.emSegundoPlano(op.processar(msg).catch((e) => {
        op.log("erro_inesperado", { id: msg.idExterno, erro: e instanceof Error ? e.message : String(e) });
      }));
    }
    // Sempre 200: senão o Telegram reenvia a mesma atualização sem parar.
    return new Response("ok", { status: 200 });
  };
}
