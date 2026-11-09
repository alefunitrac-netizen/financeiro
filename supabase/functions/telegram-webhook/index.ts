// Edge Function: https://<projeto>.supabase.co/functions/v1/telegram-webhook
// Publicar com verify_jwt = false — o Telegram não manda JWT; a autenticação é o cabeçalho
// X-Telegram-Bot-Api-Secret-Token, derivado do token do bot.
//
// Depois de salvar TELEGRAM_BOT_TOKEN nos segredos, abra uma vez:
//   https://<projeto>.supabase.co/functions/v1/telegram-webhook?acao=configurar
import { avisarSeFaltar, emSegundoPlano, env, log, montarDependencias } from "../_shared/ambiente.ts";
import { processarMensagem } from "../_shared/processador.ts";
import {
  configurarBotTelegram,
  criarHandlerTelegram,
  criarMensageiroTelegram,
  segredoDoWebhook,
} from "../_shared/telegram.ts";

avisarSeFaltar(["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY"]);

const token = env("TELEGRAM_BOT_TOKEN");
const segredo = token ? await segredoDoWebhook(token) : "";
const deps = montarDependencias(criarMensageiroTelegram({ token }));

Deno.serve(
  criarHandlerTelegram({
    segredo,
    processar: (m) => processarMensagem(m, deps),
    emSegundoPlano,
    configurar: () =>
      configurarBotTelegram({ token, segredo, url: `${env("SUPABASE_URL")}/functions/v1/telegram-webhook` }),
    log,
  }),
);
