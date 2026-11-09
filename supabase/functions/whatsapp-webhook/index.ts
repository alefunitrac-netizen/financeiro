// Edge Function: https://<projeto>.supabase.co/functions/v1/whatsapp-webhook
// Publicar com verify_jwt = false — a Meta não manda JWT; a autenticação é a assinatura HMAC.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { criarInterpretadorClaude } from "../_shared/interpretador_claude.ts";
import { processarMensagem } from "../_shared/processador.ts";
import { criarRepositorioSupabase } from "../_shared/repositorio_supabase.ts";
import { criarHandler } from "../_shared/webhook.ts";
import { criarEnviadorWhatsApp } from "../_shared/whatsapp.ts";

function log(evento: string, dados: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ evento, ...dados }));
}

const env = (nome: string) => Deno.env.get(nome) ?? "";

function chaveSecretaSupabase(): string {
  // Chaves novas (sb_secret_...) vêm em JSON; a legada service_role é o plano B.
  try {
    const chave = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}").default;
    if (chave) return chave;
  } catch { /* segue para a legada */ }
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

const faltando = ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_ACCESS_TOKEN", "ANTHROPIC_API_KEY"]
  .filter((n) => !env(n));
if (faltando.length) log("configuracao_incompleta", { faltando });

const db = createClient(env("SUPABASE_URL"), chaveSecretaSupabase(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const deps = {
  repo: criarRepositorioSupabase(db),
  interpretador: criarInterpretadorClaude({
    apiKey: env("ANTHROPIC_API_KEY"),
    modelo: env("CLAUDE_MODEL") || "claude-opus-5-5",
  }),
  whatsapp: criarEnviadorWhatsApp({
    accessToken: env("WHATSAPP_ACCESS_TOKEN"),
    versaoApi: env("WHATSAPP_API_VERSION") || "v25.0",
  }),
  agora: () => new Date(),
  novoId: () => crypto.randomUUID(),
  log,
};

type RuntimeSupabase = { waitUntil(p: Promise<unknown>): void };
const runtime = (globalThis as { EdgeRuntime?: RuntimeSupabase }).EdgeRuntime;

addEventListener("unhandledrejection", (ev) => {
  log("promessa_rejeitada", { motivo: String(ev.reason) });
  ev.preventDefault();
});

Deno.serve(
  criarHandler({
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    processar: (m) => processarMensagem(m, deps),
    emSegundoPlano: (tarefa) => (runtime ? runtime.waitUntil(tarefa) : void tarefa),
    log,
  }),
);
