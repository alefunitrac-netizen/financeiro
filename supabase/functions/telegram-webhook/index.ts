// Edge Function: https://<projeto>.supabase.co/functions/v1/telegram-webhook
// Publicar com verify_jwt = false — o Telegram não manda JWT; a autenticação é o cabeçalho
// X-Telegram-Bot-Api-Secret-Token, derivado do token do bot.
//
// Depois de salvar TELEGRAM_BOT_TOKEN nos segredos, abra uma vez:
//   https://<projeto>.supabase.co/functions/v1/telegram-webhook?acao=configurar
// Com PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET, ?acao=sincronizar lê os bancos (agendado no banco).
// ?acao=lembretes manda os lembretes do dia (agendado às 8h).
import {
  avisarSeFaltar,
  criarClienteBanco,
  emSegundoPlano,
  env,
  log,
  montarDependencias,
} from "../_shared/ambiente.ts";
import { criarLembretes } from "../_shared/lembretes.ts";
import { criarClientePluggy, criarSincronizador } from "../_shared/open_finance.ts";
import { processarMensagem } from "../_shared/processador.ts";
import { criarRepositorioBanco } from "../_shared/repositorio_banco.ts";
import {
  configurarBotTelegram,
  criarHandlerTelegram,
  criarMensageiroTelegram,
  enviarMensagemTelegram,
  segredoDoWebhook,
} from "../_shared/telegram.ts";

avisarSeFaltar(["TELEGRAM_BOT_TOKEN"]);

const token = env("TELEGRAM_BOT_TOKEN");
const segredo = token ? await segredoDoWebhook(token) : "";
const db = criarClienteBanco();
const deps = montarDependencias(criarMensageiroTelegram({ token }), db);

// Open Finance é opcional: só liga com as credenciais da Pluggy.
const clientId = env("PLUGGY_CLIENT_ID");
const clientSecret = env("PLUGGY_CLIENT_SECRET");
const sincronizador = clientId && clientSecret
  ? criarSincronizador({
    repo: criarRepositorioBanco(db),
    pluggy: criarClientePluggy({ clientId, clientSecret }),
    agora: () => new Date(),
    avisar: (telegramId, texto) => enviarMensagemTelegram({ token, chatId: Number(telegramId), texto }),
    log,
    // A pergunta do aviso ("é de qual categoria?") fica valendo por 24h.
    guardarPergunta: (usuarioId, p) => deps.repo.salvarPendencia(usuarioId, p, 24 * 60),
  })
  : null;
const lembretes = criarLembretes({
  repo: deps.repo,
  agora: () => new Date(),
  avisar: (telegramId, texto) => enviarMensagemTelegram({ token, chatId: Number(telegramId), texto }),
  log,
});
if (sincronizador) deps.sincronizarBanco = (usuarioId) => sincronizador.sincronizarUsuario(usuarioId);

Deno.serve(
  criarHandlerTelegram({
    segredo,
    processar: (m) => processarMensagem(m, deps),
    emSegundoPlano,
    configurar: () =>
      configurarBotTelegram({ token, segredo, url: `${env("SUPABASE_URL")}/functions/v1/telegram-webhook` }),
    sincronizar: sincronizador ? () => sincronizador.sincronizarTodos() : undefined,
    lembretes: () => lembretes.rodar(),
    log,
  }),
);
