import assert from "node:assert/strict";
import { betaZodOutputFormat } from "npm:@anthropic-ai/sdk@1.6.0/helpers/beta/zod";
import { EsquemaInterpretacao, montarMensagemUsuario } from "../_shared/interpretador_claude.ts";
import { CATEGORIAS, CONTAS } from "./fakes.ts";

Deno.test("mensagem para a IA leva data, contas com apelidos, categorias e o texto", () => {
  const m = montarMensagemUsuario({
    texto: "gastei 45 no roxinho",
    hoje: "2026-11-07",
    diaDaSemana: "sábado",
    contas: CONTAS,
    categorias: CATEGORIAS,
  });
  assert.match(m, /Hoje é sábado, 2026-11-07\./);
  assert.match(m, /- Nubank crédito \(cartao_credito; apelidos: nubank, roxinho\)/);
  assert.match(m, /Categorias de despesa: Alimentação, Transporte/);
  assert.match(m, /Categorias de receita: Salário, Outras receitas/);
  assert.match(m, /<mensagem>\ngastei 45 no roxinho\n<\/mensagem>/);
});

Deno.test("esquema de saída estruturada: JSON Schema estrito e parse de uma resposta típica", () => {
  const formato = betaZodOutputFormat(EsquemaInterpretacao);
  assert.equal(formato.type, "json_schema");
  const schema = formato.schema as { additionalProperties?: boolean; required?: string[] };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required?.sort(), ["correcao", "intencao", "lancamentos", "pergunta", "resumo"]);

  const exemplo = {
    intencao: "registrar",
    lancamentos: [{
      tipo: "despesa",
      descricao: "iFood",
      estabelecimento: "iFood",
      valor: "47.90",
      valor_refere_se_a: "total",
      parcelas: null,
      data: "2026-11-07",
      conta: "Nubank crédito",
      categoria: "Alimentação",
    }],
    resumo: null,
    correcao: null,
    pergunta: null,
  };
  assert.deepEqual(EsquemaInterpretacao.parse(exemplo), exemplo);
  assert.throws(() => EsquemaInterpretacao.parse({ ...exemplo, intencao: "piada" }));
});
