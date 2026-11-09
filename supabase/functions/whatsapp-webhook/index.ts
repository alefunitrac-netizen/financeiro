// Edge Function: https://<projeto>.supabase.co/functions/v1/whatsapp-webhook
// Publicar com verify_jwt = false — a Meta não manda JWT; a autenticação é a assinatura HMAC.
import { avisarSeFaltar, emSegundoPlano, env, log, montarDependencias } from "../_shared/ambiente.ts";
import { processarMensagem } from "../_shared/processador.ts";
import { criarHandlerWhatsApp } from "../_shared/webhook_whatsapp.ts";
import { criarMensageiroWhatsApp } from "../_shared/whatsapp.ts";

avisarSeFaltar(["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN"]);

const deps = montarDependencias(
  criarMensageiroWhatsApp({
    accessToken: env("WHATSAPP_ACCESS_TOKEN"),
    versaoApi: env("WHATSAPP_API_VERSION") || "v25.0",
  }),
);

Deno.serve(
  criarHandlerWhatsApp({
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    processar: (m) => processarMensagem(m, deps),
    emSegundoPlano,
    log,
  }),
);
