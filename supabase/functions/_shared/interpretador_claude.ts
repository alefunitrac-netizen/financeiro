// Interpreta a mensagem livre ("gastei 45 no ifood no nubank") com o Claude,
// usando saída estruturada: o modelo é obrigado a devolver JSON neste formato.
// O modelo NUNCA calcula centavos, parcelas nem vencimentos: ele só extrai.
// Toda conta financeira é feita no código, onde é testável.
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";
import { betaZodOutputFormat } from "npm:@anthropic-ai/sdk@1.6.0/helpers/beta/zod";
import { z } from "npm:zod@4.6.7";
import type { ContextoInterpretacao, Interpretacao, Interpretador } from "./tipos.ts";

const data = z.string().describe("Data no formato YYYY-MM-DD");

const EsquemaLancamento = z.object({
  tipo: z.enum(["despesa", "receita"]),
  descricao: z.string(),
  estabelecimento: z.string().nullable(),
  valor: z.string().describe('Valor com ponto decimal e duas casas, sem símbolo. Ex.: "47.90"'),
  valor_refere_se_a: z.enum(["total", "parcela"]),
  parcelas: z.number().int().nullable(),
  data,
  conta: z.string().nullable(),
  categoria: z.string(),
});

export const EsquemaInterpretacao = z.object({
  intencao: z.enum(["registrar", "resumo", "desfazer", "corrigir", "ajuda", "esclarecer", "fora_do_escopo"]),
  lancamentos: z.array(EsquemaLancamento),
  resumo: z
    .object({
      periodo: z.enum(["hoje", "ontem", "semana", "mes_atual", "mes_anterior", "intervalo"]),
      inicio: data.nullable(),
      fim: data.nullable(),
      categoria: z.string().nullable(),
    })
    .nullable(),
  correcao: z
    .object({
      valor: z.string().nullable(),
      data: data.nullable(),
      conta: z.string().nullable(),
      categoria: z.string().nullable(),
      descricao: z.string().nullable(),
    })
    .nullable(),
  pergunta: z.string().nullable(),
});

// Garante em tempo de compilação que o esquema e o tipo de domínio não se desencontram.
type SaidaDoEsquema = z.infer<typeof EsquemaInterpretacao>;
const _esquemaCompativel: SaidaDoEsquema extends Interpretacao ? true : never = true;
void _esquemaCompativel;

export const PROMPT_SISTEMA = `Você é o interpretador de um bot de controle financeiro pessoal no WhatsApp, usado por uma pessoa no Brasil. Você recebe UMA mensagem dela e devolve a intenção e os dados estruturados. Você não conversa: o sistema usa a sua saída para gravar lançamentos e montar a resposta.

Intenções:
- registrar: a mensagem relata um ou mais gastos ou receitas. Uma mensagem pode ter vários lançamentos ("uber 23 e almoço 45" são dois).
- resumo: pede totais ou um resumo de gastos/receitas ("quanto gastei esse mês?", "resumo da semana", "quanto foi de mercado em setembro?").
- desfazer: quer cancelar o último registro.
- corrigir: quer alterar o último registro ("era 52", "foi no itaú", "muda pra mercado"). Preencha só os campos que mudam; os demais ficam null.
- ajuda: pergunta o que o bot faz ou como usar.
- esclarecer: parece um lançamento, mas falta o valor ou está ambíguo demais. Escreva em "pergunta" uma pergunta curta e simpática.
- fora_do_escopo: qualquer outro assunto. Este bot só cuida de lançamentos e resumos financeiros.

Lançamentos:
- valor: texto com ponto decimal e duas casas, sem símbolo ("47.90", "1500.00"). Entenda o jeito brasileiro de escrever: "45 conto" = 45.00, "1,5k" ou "1,5 mil" = 1500.00, "R$ 12,90" = 12.90, "1.200" = 1200.00.
- valor_refere_se_a: "parcela" quando a pessoa diz o valor de cada parcela ("12x de 250"); "total" nos demais casos ("TV de 3000 em 12x").
- parcelas: número de parcelas quando parcelado (2 ou mais); null quando à vista.
- data: resolva "ontem", "anteontem", "sexta", "dia 3" em relação à data de hoje informada, sempre para o passado mais próximo. Sem menção de data, use hoje.
- conta: o nome EXATO de uma das contas listadas, reconhecendo nome, apelido, banco ou cartão citados. Se a pessoa não citar conta ou nenhuma corresponder, null.
- categoria: o nome EXATO de uma das categorias listadas do mesmo tipo do lançamento. Se nenhuma servir, "Outros" (despesa) ou "Outras receitas" (receita).
- descricao: curta, com inicial maiúscula ("Almoço", "Uber", "TV"). estabelecimento: nome do lugar ou empresa se citado (iFood, Uber, Carrefour), senão null.
- tipo: "receita" para dinheiro que entra (salário, pix recebido, reembolso, venda); "despesa" para o resto.

Resumo:
- periodo: hoje, ontem, semana, mes_atual ou mes_anterior. Para qualquer outro período (um mês específico, "últimos 15 dias"), use "intervalo" e preencha inicio e fim. Sem menção de período, mes_atual.
- categoria: o nome exato da categoria se a pessoa perguntar por uma específica, senão null.

Campos que não se aplicam à intenção: lancamentos = [], resumo = null, correcao = null, pergunta = null.`;

export function montarMensagemUsuario(ctx: ContextoInterpretacao): string {
  const contas = ctx.contas
    .map((c) => `- ${c.nome} (${c.tipo}${c.apelidos.length ? `; apelidos: ${c.apelidos.join(", ")}` : ""})`)
    .join("\n");
  const despesas = ctx.categorias.filter((c) => c.tipo === "despesa").map((c) => c.nome).join(", ");
  const receitas = ctx.categorias.filter((c) => c.tipo === "receita").map((c) => c.nome).join(", ");
  return `Hoje é ${ctx.diaDaSemana}, ${ctx.hoje}.

Contas:
${contas || "- (nenhuma cadastrada)"}

Categorias de despesa: ${despesas}
Categorias de receita: ${receitas}

<mensagem>
${ctx.texto}
</mensagem>`;
}

export class ErroInterpretacao extends Error {
  constructor(readonly motivo: string, mensagem: string) {
    super(mensagem);
    this.name = "ErroInterpretacao";
  }
}

export function criarInterpretadorClaude(opcoes: { apiKey: string; modelo: string }): Interpretador {
  const cliente = new Anthropic({ apiKey: opcoes.apiKey, timeout: 60_000, maxRetries: 2 });
  // Haiku não tem fallback no servidor; nos demais modelos, se o modelo principal
  // recusar por política, o próprio servidor tenta de novo no modelo recomendado.
  const comFallback = !opcoes.modelo.startsWith("claude-haiku");

  return {
    async interpretar(ctx) {
      let resposta;
      try {
        resposta = await cliente.beta.messages.parse({
          model: opcoes.modelo,
          max_tokens: 8000,
          ...(comFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          // Extração simples: esforço baixo = mais rápido e mais barato, sem perder qualidade.
          output_config: { effort: "low", format: betaZodOutputFormat(EsquemaInterpretacao) },
          system: PROMPT_SISTEMA,
          messages: [{ role: "user", content: montarMensagemUsuario(ctx) }],
        });
      } catch (erro) {
        if (erro instanceof Anthropic.AuthenticationError) {
          throw new ErroInterpretacao("autenticacao", "ANTHROPIC_API_KEY inválida ou ausente");
        } else if (erro instanceof Anthropic.RateLimitError) {
          throw new ErroInterpretacao("limite", "Limite de requisições da API atingido");
        } else if (erro instanceof Anthropic.APIConnectionError) {
          throw new ErroInterpretacao("conexao", `Falha de conexão com a API: ${erro.message}`);
        } else if (erro instanceof Anthropic.APIError) {
          throw new ErroInterpretacao(`api_${erro.status}`, erro.message);
        }
        throw erro;
      }

      if (resposta.stop_reason === "refusal") {
        throw new ErroInterpretacao("recusa", "O modelo recusou interpretar a mensagem");
      }
      if (resposta.stop_reason === "max_tokens") {
        throw new ErroInterpretacao("max_tokens", "Resposta do modelo cortada por max_tokens");
      }
      if (!resposta.parsed_output) {
        throw new ErroInterpretacao("formato", "O modelo não devolveu JSON no formato esperado");
      }
      return resposta.parsed_output;
    },
  };
}
