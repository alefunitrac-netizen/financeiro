// Regras primeiro (grátis e instantâneo); IA só para o que as regras não entendem, se houver.
// Sem IA (ou se ela falhar, ex.: sem crédito), o bot pede para reescrever em vez de dar erro.
import { interpretarPorRegras } from "./interpretador_regras.ts";
import { TEXTO_NAO_ENTENDI } from "./respostas.ts";
import type { Interpretacao, Interpretador } from "./tipos.ts";

export function criarInterpretadorHibrido(
  ia: Interpretador | null,
  log: (evento: string, dados?: Record<string, unknown>) => void,
): Interpretador {
  return {
    async interpretar(ctx) {
      const porRegras = interpretarPorRegras(ctx);
      if (porRegras) return porRegras;
      if (ia) {
        try {
          return await ia.interpretar(ctx);
        } catch (e) {
          log("ia_indisponivel", { erro: e instanceof Error ? e.message.slice(0, 300) : String(e) });
        }
      }
      const naoEntendi: Interpretacao = {
        intencao: "esclarecer",
        lancamentos: [],
        resumo: null,
        correcao: null,
        pergunta: TEXTO_NAO_ENTENDI,
      };
      return naoEntendi;
    },
  };
}
