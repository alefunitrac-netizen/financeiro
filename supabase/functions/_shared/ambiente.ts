// O que as duas funções (WhatsApp e Telegram) montam igual: variáveis, log, banco, IA e segundo plano.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { criarInterpretadorClaude } from "./interpretador_claude.ts";
import { criarInterpretadorHibrido } from "./interpretador_hibrido.ts";
import { criarRepositorioSupabase } from "./repositorio_supabase.ts";
import type { Dependencias } from "./processador.ts";
import type { Mensageiro } from "./tipos.ts";

export const env = (nome: string) => Deno.env.get(nome) ?? "";

export function log(evento: string, dados: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ evento, ...dados }));
}

export function avisarSeFaltar(nomes: string[]) {
  const faltando = nomes.filter((n) => !env(n));
  if (faltando.length) log("configuracao_incompleta", { faltando });
}

function chaveSecretaSupabase(): string {
  // Chaves novas (sb_secret_...) vêm em JSON; a legada service_role é o plano B.
  try {
    const chave = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}").default;
    if (chave) return chave;
  } catch { /* segue para a legada */ }
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

export function montarDependencias(mensageiro: Mensageiro): Dependencias {
  const db = createClient(env("SUPABASE_URL"), chaveSecretaSupabase(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // A IA é opcional: sem ANTHROPIC_API_KEY (ou com INTERPRETADOR=regras), o bot usa só as regras.
  const apiKey = env("ANTHROPIC_API_KEY");
  const usarIa = apiKey && env("INTERPRETADOR") !== "regras";
  const ia = usarIa ? criarInterpretadorClaude({ apiKey, modelo: env("CLAUDE_MODEL") || "claude-opus-5-5" }) : null;
  return {
    repo: criarRepositorioSupabase(db),
    interpretador: criarInterpretadorHibrido(ia, log),
    mensageiro,
    agora: () => new Date(),
    novoId: () => crypto.randomUUID(),
    log,
  };
}

type RuntimeSupabase = { waitUntil(p: Promise<unknown>): void };
const runtime = (globalThis as { EdgeRuntime?: RuntimeSupabase }).EdgeRuntime;

/** Mantém a função viva até a tarefa terminar, depois de já ter respondido 200. */
export function emSegundoPlano(tarefa: Promise<unknown>) {
  if (runtime) runtime.waitUntil(tarefa);
}

addEventListener("unhandledrejection", (ev) => {
  log("promessa_rejeitada", { motivo: String(ev.reason) });
  ev.preventDefault();
});
