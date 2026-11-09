// Camada HTTP do webhook do WhatsApp: valida a origem, responde rápido e processa em segundo plano.
import type { MensagemRecebida } from "./tipos.ts";
import { assinaturaValida, extrairMensagens, respostaVerificacao } from "./whatsapp.ts";

export interface OpcoesWebhookWhatsApp {
  verifyToken: string;
  appSecret: string;
  processar: (m: MensagemRecebida) => Promise<void>;
  /** A Meta reenvia se não receber 200 em poucos segundos; por isso o trabalho pesado roda depois da resposta. */
  emSegundoPlano: (tarefa: Promise<unknown>) => void;
  log: (evento: string, dados?: Record<string, unknown>) => void;
}

export function criarHandlerWhatsApp(op: OpcoesWebhookWhatsApp): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "GET") return respostaVerificacao(new URL(req.url), op.verifyToken);
    if (req.method !== "POST") return new Response("Método não permitido", { status: 405 });

    const corpo = new Uint8Array(await req.arrayBuffer());
    if (!(await assinaturaValida(corpo, req.headers.get("x-hub-signature-256"), op.appSecret))) {
      op.log("assinatura_invalida");
      return new Response("Assinatura inválida", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(corpo));
    } catch {
      return new Response("JSON inválido", { status: 400 });
    }

    const mensagens = extrairMensagens(payload);
    if (mensagens.length > 0) {
      // Em ordem: "uber 20" seguido de "desfazer" precisa desfazer o uber.
      op.emSegundoPlano((async () => {
        for (const m of mensagens) {
          try {
            await op.processar(m);
          } catch (e) {
            op.log("erro_inesperado", { id: m.idExterno, erro: e instanceof Error ? e.message : String(e) });
          }
        }
      })());
    }
    return new Response("ok", { status: 200 });
  };
}
