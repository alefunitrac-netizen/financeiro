// Interpretador sem IA: lê a mensagem por regras. Grátis, instantâneo e previsível.
// Cobre o jeito comum de anotar gasto ("almoço 35 no nubank", "uber 23 ontem", "tv 3000 em 10x").
// Quando não entende, devolve null e quem chamou decide (IA, se houver, ou pedir para reescrever).
import { dataValida, diasNoMes, somarDias, somarMeses } from "./datas.ts";
import { paraCentavos } from "./dinheiro.ts";
import { acharBanco } from "./bancos.ts";
import { chave } from "./texto.ts";

export { chave };
import type {
  Categoria,
  Conta,
  ContextoInterpretacao,
  DataISO,
  Interpretacao,
  LancamentoInterpretado,
  Meio,
  PedidoFatura,
  PedidoResumo,
  TipoLancamento,
} from "./tipos.ts";

// ---------- Vocabulário ----------

/** Palavras que indicam cada categoria padrão. A frase mais longa vence ("mercado livre" > "mercado"). */
const PALAVRAS_DESPESA: Record<string, string[]> = {
  "Alimentação": [
    "almoco", "almocei", "almocar", "jantar", "jantei", "janta", "cafe", "cafe da manha", "lanche", "lanchei",
    "lanchonete", "ifood", "uber eats", "rappi", "delivery", "restaurante", "pizza", "pizzaria", "hamburguer",
    "hamburgueria", "burger", "sushi", "japones", "padaria", "pao", "acai", "sorvete", "marmita", "marmitex", "comida",
    "bar", "boteco", "cerveja", "chopp", "mcdonalds", "mc donalds", "mc donald", "mcdonald", "burger king", "bk", "subway", "starbucks",
    "salgado", "refrigerante", "quentinha",
  ],
  "Mercado": [
    "mercado", "supermercado", "feira", "hortifruti", "sacolao", "atacadao", "assai", "carrefour", "guanabara",
    "prezunic", "mundial", "zona sul", "pao de acucar", "compras do mes", "acougue", "carne", "arroz", "feijao",
    "verdura", "verduras", "fruta", "frutas",
  ],
  "Transporte": [
    "uber", "99", "99pop", "taxi", "onibus", "metro", "trem", "brt", "vlt", "barca", "combustivel", "gasolina",
    "etanol", "diesel", "abastecer", "abasteci", "posto", "estacionamento", "pedagio", "riocard", "bilhete unico",
    "passagem de onibus", "lava jato", "oficina", "mecanico", "pneu", "shellbox", "shell", "ipiranga", "petrobras", "auto posto",
  ],
  "Moradia": ["aluguel", "condominio", "iptu", "reforma", "diarista", "faxina", "faxineira", "moveis"],
  "Contas da casa": [
    "luz", "energia", "conta de luz", "light", "enel", "agua", "conta de agua", "cedae", "gas", "internet", "wifi",
    "claro", "vivo", "tim", "telefone", "celular", "plano de celular", "sky",
  ],
  "Saúde": [
    "farmacia", "drogaria", "remedio", "remedios", "medico", "consulta", "exame", "exames", "dentista",
    "plano de saude", "hospital", "academia", "psicologo", "terapia", "fisioterapia", "otica", "oculos",
  ],
  "Educação": ["escola", "faculdade", "curso", "livro", "livros", "apostila", "material escolar", "udemy", "alura"],
  "Lazer": [
    "cinema", "show", "teatro", "ingresso", "ingressos", "jogo", "game", "steam", "playstation", "xbox", "praia",
    "passeio", "festa", "balada", "parque", "museu", "clube",
  ],
  "Compras": [
    "roupa", "roupas", "sapato", "tenis", "camisa", "calca", "shopping", "amazon", "mercado livre", "shopee",
    "magalu", "shein", "aliexpress", "geladeira", "fogao", "tv", "televisao", "notebook", "computador",
    "celular novo", "eletrodomestico",
  ],
  "Assinaturas": [
    "netflix", "spotify", "disney", "hbo", "prime video", "amazon prime", "youtube premium", "globoplay", "deezer",
    "icloud", "google one", "assinatura", "chatgpt", "claude",
  ],
  "Pets": ["pet", "petshop", "pet shop", "racao", "veterinario", "banho e tosa"],
  "Viagem": ["viagem", "hotel", "pousada", "airbnb", "hospedagem", "passagem aerea", "passagem", "voo", "aeroporto"],
  "Impostos e taxas": ["imposto", "impostos", "taxa", "tarifa", "iof", "ipva", "multa", "anuidade", "juros", "darf", "encargos", "mora"],
  "Presentes e doações": ["presente", "presentes", "doacao", "dizimo", "oferta", "vaquinha", "caridade"],
};

const PALAVRAS_RECEITA: Record<string, string[]> = {
  "Salário": ["salario", "salarios", "pagto salario", "holerite", "adiantamento", "decimo terceiro", "ferias", "plr"],
  "Renda extra": ["freela", "freelance", "bico", "extra", "venda", "vendi", "comissao"],
  "Reembolso": ["reembolso", "estorno", "devolucao", "ressarcimento"],
  "Rendimentos": ["rendimento", "rendimentos", "rendeu", "dividendo", "dividendos", "juros", "cdb", "cashback"],
};

/** Grafia bonita para a descrição quando ela é só um nome conhecido. */
const MARCAS: Record<string, string> = {
  "ifood": "iFood",
  "uber": "Uber",
  "uber eats": "Uber Eats",
  "99": "99",
  "netflix": "Netflix",
  "spotify": "Spotify",
  "amazon": "Amazon",
  "mercado livre": "Mercado Livre",
  "shopee": "Shopee",
  "mcdonalds": "McDonald's",
  "carrefour": "Carrefour",
};

/** Palavras que não entram na descrição. */
const VAZIAS = new Set(
  ("gastei gasto gastou paguei pago pagou paga comprei compra comprou recebi recebido ganhei entrou caiu foi foram " +
    "de do da dos das no na nos nas em com pra pro pras pros para por pelo pela o a os as um uma uns umas reais real " +
    "conto contos pila pilas e cartao conta credito debito via valor total meu minha meus minhas ai la aqui so " +
    "era as ao aos adicionar adiciona adicione add lancar lanca lance registrar registra registre anota anotar " +
    "anote coloca colocar coloque parcela parcelas parcelado parcelada").split(" "),
);

const DIAS_SEMANA = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const MESES = [
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

// ---------- Texto ----------

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const frase = (s: string) => escapar(s.trim()).replace(/\s+/g, String.raw`\s+`);

/** O texto da mensagem, com os trechos já entendidos apagados (viram espaço). */
class Texto {
  livre: string;
  constructor(readonly original: string) {
    this.livre = chave(original);
  }
  consumir(inicio: number, fim: number) {
    this.livre = this.livre.slice(0, inicio) + " ".repeat(fim - inicio) + this.livre.slice(fim);
  }
  tirar(re: RegExp): RegExpExecArray | null {
    const m = re.exec(this.livre);
    if (m) this.consumir(m.index, m.index + m[0].length);
    return m;
  }
}

// ---------- Datas ----------

const iso = (a: number, m: number, d: number) =>
  `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const partes = (d: DataISO) => d.split("-").map(Number) as [number, number, number];
const diaDaSemanaDe = (d: DataISO) => {
  const [a, m, dia] = partes(d);
  return new Date(Date.UTC(a, m - 1, dia)).getUTCDay();
};

/** Tira do texto uma data ("ontem", "dia 3", "05/11", "sexta") e a resolve para o passado mais próximo. */
function tirarData(t: Texto, hoje: DataISO): DataISO | null {
  if (t.tirar(/\b(?:(?:no|na|em)\s+)?(?:antes\s+de\s+ontem|anteontem)\b/)) return somarDias(hoje, -2);
  if (t.tirar(/\b(?:de\s+)?ontem\b/)) return somarDias(hoje, -1);
  if (t.tirar(/\b(?:de\s+)?hoje\b/)) return hoje;

  const [a, m, d] = partes(hoje);
  let r = t.tirar(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/);
  if (r) {
    const ano = r[3] ? (r[3].length === 2 ? 2000 + Number(r[3]) : Number(r[3])) : a;
    let data = iso(ano, Number(r[2]), Number(r[1]));
    if (!dataValida(data)) return null;
    if (!r[3] && data > hoje) data = iso(ano - 1, Number(r[2]), Number(r[1]));
    return dataValida(data) ? data : null;
  }

  r = t.tirar(/\b(?:(?:no|na|em)\s+)?dia\s+(\d{1,2})\b/);
  if (r) {
    const dia = Number(r[1]);
    if (dia < 1) return null;
    if (dia <= d) return iso(a, m, dia);
    const [pa, pm] = partes(somarMeses(iso(a, m, 1), -1));
    return dia <= diasNoMes(pa, pm) ? iso(pa, pm, dia) : null;
  }

  r = t.tirar(/\b(?:(?:no|na|em)\s+)?(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:[\s-]+feira)?(\s+passad[oa])?\b/);
  if (r) {
    let atras = (diaDaSemanaDe(hoje) - DIAS_SEMANA.indexOf(r[1]) + 7) % 7;
    if (atras === 0 && r[2]) atras = 7;
    return somarDias(hoje, -atras);
  }
  return null;
}

// ---------- Valores e parcelas ----------

const NUMERO = String.raw`(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
const MILHAR = String.raw`(?:\s*(k|mil)\b)?`;
const NAO_E_DINHEIRO =
  String.raw`(?!\s*(?:h|hs|hrs|horas?|min|minutos?|km|kg|g|gr|ml|l|litros?|%|x|vezes|parcelas?|unidades?)\b)`;

/** "12x de 250", "10x 300" — parcelas com o valor de cada uma. */
const RE_PARCELA_DE = new RegExp(String.raw`\b(?:em\s+)?(\d{1,2})\s*x\s*(?:de\s*)?(r\$\s*)?` + NUMERO + MILHAR);
/** "em 10x", "3 vezes", "12 parcelas" — só o número de parcelas. */
const RE_PARCELAS = /\b(?:em\s+)?(\d{1,2})\s*(?:x|vezes|parcelas)\b/;
const RE_VALOR = new RegExp(String.raw`(r\$\s*)?(?<![\w.,])` + NUMERO + String.raw`(?!\d)` + MILHAR + NAO_E_DINHEIRO, "g");

function emCentavos(numero: string, milhar: string | undefined): number | null {
  const c = paraCentavos(numero);
  if (c === null) return null;
  const total = milhar ? c * 1000 : c;
  return Number.isSafeInteger(total) ? total : null;
}

/** Tira o valor do texto. Com vários números: o que tem "R$"; senão o maior ("2 pizzas 80" = 80). */
function tirarValor(t: Texto): number | null {
  let candidatos = [...t.livre.matchAll(RE_VALOR)]
    .map((m) => ({ m, centavos: emCentavos(m[2], m[3]), comCifrao: Boolean(m[1]) }))
    .filter((c) => c.centavos !== null);
  // "99 23": o 99 é o app de corrida, não o valor.
  if (candidatos.length > 1) {
    candidatos = candidatos.filter((c) => !(c.m[2] === "99" && !c.comCifrao && !c.m[3]));
  }
  if (candidatos.length === 0) return null;
  const escolhido = candidatos.find((c) => c.comCifrao) ??
    candidatos.reduce((a, b) => (b.centavos! > a.centavos! ? b : a));
  t.consumir(escolhido.m.index!, escolhido.m.index! + escolhido.m[0].length);
  return escolhido.centavos;
}

const centavosEmTexto = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

// ---------- Conta e categoria ----------

/** Tira a conta citada (nome ou apelido), junto com "no cartão do", "na conta", "em"... */
function tirarConta(t: Texto, contas: Conta[]): Conta | null {
  let melhor: { conta: Conta; m: RegExpExecArray; tamanho: number } | null = null;
  for (const conta of contas) {
    for (const nome of [conta.nome, ...conta.apelidos]) {
      const n = chave(nome).trim();
      if (!n) continue;
      const re = new RegExp(
        String.raw`(?:\b(?:no|na|em|pelo|pela|via|com|do|da)\s+)?(?:\b(?:cartao|conta|debito|credito)\s+(?:(?:do|da|de)\s+)?)?(?<![\w])` +
          frase(n) + String.raw`(?![\w])`,
      );
      const m = re.exec(t.livre);
      if (m && (!melhor || n.length > melhor.tamanho)) melhor = { conta, m, tamanho: n.length };
    }
  }
  if (!melhor) return null;
  t.consumir(melhor.m.index, melhor.m.index + melhor.m[0].length);
  return melhor.conta;
}

/**
 * Banco citado que ainda não é uma conta sua ("no nubank" sem Nubank cadastrado). Devolve o nome
 * oficial; quem registra cria a conta.
 */
function tirarBanco(t: Texto): string | null {
  const b = acharBanco(t.livre, true);
  if (!b) return null;
  // Leva junto o "no cartão do", "na conta da"... que vem antes do nome.
  const antes = t.livre.slice(0, b.inicio);
  const prefixo = /(?:\b(?:no|na|em|pelo|pela|via|com|do|da)\s+)?(?:\b(?:cartao|conta|debito|credito)\s+(?:(?:do|da|de)\s+)?)?$/
    .exec(antes);
  t.consumir(b.inicio - (prefixo?.[0].length ?? 0), b.fim);
  return b.nome;
}

/** Conta cadastrada ou banco conhecido citado no texto. */
function tirarContaOuBanco(t: Texto, contas: Conta[]): string | null {
  return tirarConta(t, contas)?.nome ?? tirarBanco(t);
}

const RE_MEIO_CREDITO = /\b(cartao|credito|fatura)\b/;
const RE_MEIO_DEBITO = /\b(debito|pix|ted|boleto|transferencia|transferi)\b/;

/** Como foi pago, pelas palavras usadas. Débito/Pix explícito vence "cartão" ("cartão de débito"). */
function meioDe(k: string, parcelado = false): Meio | null {
  if (RE_MEIO_DEBITO.test(k)) return "debito";
  if (RE_MEIO_CREDITO.test(k) || parcelado) return "credito";
  return null;
}

/** Procura a categoria pelas palavras do dicionário e pelos próprios nomes das categorias do usuário. */
function acharCategoria(texto: string, tipos: TipoLancamento[], categorias: Categoria[]): string | null {
  let melhor: { nome: string; tamanho: number; posicao: number } | null = null;
  for (const tipo of tipos) {
    const dicionario = tipo === "receita" ? PALAVRAS_RECEITA : PALAVRAS_DESPESA;
    const porChave = new Map(Object.entries(dicionario).map(([nome, ps]) => [chave(nome), ps]));
    for (const cat of categorias.filter((c) => c.tipo === tipo)) {
      const k = chave(cat.nome);
      for (const palavra of [k, ...(porChave.get(k) ?? [])]) {
        const m = new RegExp(String.raw`(?<![\w])` + frase(palavra) + String.raw`(?![\w])`).exec(texto);
        if (!m) continue;
        const tamanho = palavra.length;
        if (!melhor || tamanho > melhor.tamanho || (tamanho === melhor.tamanho && m.index < melhor.posicao)) {
          melhor = { nome: cat.nome, tamanho, posicao: m.index };
        }
      }
    }
  }
  return melhor?.nome ?? null;
}

/** Categoria de um texto qualquer (ex.: descrição que veio do banco, "IFD*IFOOD SAO PAULO"). */
export function categoriaPorTexto(texto: string, tipo: TipoLancamento, categorias: Categoria[]): string | null {
  return acharCategoria(chave(texto), [tipo], categorias);
}

const RE_VERBO_DESPESA = /\b(gastei|gasto|gastou|paguei|pago|pagou|comprei|comprou|transferi|mandei)\b/;
const RE_RECEITA =
  /\b(recebi|recebido|recebemos|ganhei|entrou|entrada|caiu|salario|reembolso|estorno|rendimentos?|rendeu|dividendos?|vendi|freela|freelance|bonus|plr|decimo terceiro|cashback)\b/;

function tipoDe(k: string): TipoLancamento {
  return !RE_VERBO_DESPESA.test(k) && RE_RECEITA.test(k) ? "receita" : "despesa";
}

/** O que sobrou do texto, sem as palavras de ligação, vira a descrição ("gastei 45 no ifood" → "iFood"). */
function descricaoDe(t: Texto, categoria: string, tipo: TipoLancamento, parcelado = false): string {
  const borda = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
  const palavras: string[] = [];
  for (const m of t.livre.matchAll(/\S+/g)) {
    const k = m[0].replace(borda, "");
    if (!k || VAZIAS.has(k)) continue;
    palavras.push(t.original.slice(m.index!, m.index! + m[0].length).replace(borda, ""));
  }
  let d = palavras.join(" ").trim().slice(0, 80);
  if (!d) {
    d = !["Outros", "Outras receitas"].includes(categoria)
      ? categoria
      : tipo === "receita"
      ? "Receita"
      : parcelado
      ? "Compra parcelada"
      : "Gasto";
  }
  const marca = MARCAS[chave(d)];
  if (marca) return marca;
  // Sigla de 2 letras em maiúsculas (TV, PC); "ar" é palavra.
  return d.length <= 2 && chave(d) !== "ar" ? d.toUpperCase() : d[0].toUpperCase() + d.slice(1);
}

// ---------- Intenções ----------

const VAZIO = { lancamentos: [], resumo: null, correcao: null, pergunta: null };
const RE_CORRIGIR = /^\W*(?:corrigir|corrige|corrija|corrigi|correcao|corrigindo)\b\W*/;
// Com os erros de digitação comuns: "desafazer", "desfaze", "dezfazer", "cancelaa"...
const RE_DESFAZER =
  /\b(?:de[sz]\w{0,2}fa[zcç]\w*|cancel\w*|apag\w*|exclu\w*|remov\w*|delet\w*|volta\s+atras|voltar)\b/;
const RE_RESUMO =
  /\b(resumo|extrato|balanco|relatorio|por\s+(?:banco|bancos|conta|contas|cartao|cartoes)|quanto\s+(?:eu\s+)?(?:gastei|gasto|paguei|recebi|ganhei|entrou|saiu|foi|deu)|total\s+(?:de|do|da|gasto)|gastos?\s+(?:de|do|da|dos|das|com|na|no|em|esse|este|nesse|neste))\b/;
const RE_AJUDA = /\b(ajuda|socorro|como\s+(?:funciona|usa|usar|uso)|o\s+que\s+(?:voce|vc)\s+(?:faz|sabe)|comandos|exemplos?)\b/;

function lerLancamento(segmento: string, ctx: ContextoInterpretacao): LancamentoInterpretado | null {
  const t = new Texto(segmento);
  const data = tirarData(t, ctx.hoje) ?? ctx.hoje;

  let parcelas: number | null = null;
  let refere: "total" | "parcela" = "total";
  let centavos: number | null = null;
  const pd = t.tirar(RE_PARCELA_DE);
  if (pd) {
    parcelas = Number(pd[1]);
    centavos = emCentavos(pd[3], pd[4]);
    refere = "parcela";
  } else {
    const p = t.tirar(RE_PARCELAS);
    if (p) parcelas = Number(p[1]);
  }
  if (centavos === null) centavos = tirarValor(t);
  if (centavos === null) return null;
  if (parcelas !== null && parcelas < 2) parcelas = null;

  const conta = tirarContaOuBanco(t, ctx.contas);
  const tipo = tipoDe(chave(segmento));
  const categoria = acharCategoria(t.livre, [tipo], ctx.categorias) ??
    (tipo === "receita" ? "Outras receitas" : "Outros");

  return {
    tipo,
    descricao: descricaoDe(t, categoria, tipo, parcelas !== null),
    estabelecimento: null,
    valor: centavosEmTexto(centavos),
    valor_refere_se_a: refere,
    parcelas,
    data,
    conta,
    categoria,
    meio: tipo === "despesa" ? meioDe(chave(segmento), parcelas !== null) : null,
  };
}

/** "uber 23 e almoço 45" são dois lançamentos — mas só se cada pedaço tiver o seu valor. */
function dividir(texto: string, ctx: ContextoInterpretacao): string[] {
  const pedacos = texto.split(/\s*(?:\n|;|,\s+|\s\+\s|\s+e\s+)\s*/i).map((s) => s.trim()).filter(Boolean);
  if (pedacos.length < 2) return [texto];
  return pedacos.every((p) => lerLancamento(p, ctx) !== null) ? pedacos : [texto];
}

function pedidoResumo(texto: string, ctx: ContextoInterpretacao): PedidoResumo {
  const k = chave(texto);
  const categoria = acharCategoria(k, ["despesa", "receita"], ctx.categorias);
  // "quanto gastei no nubank?" filtra a conta; "resumo por banco" não (é só o jeito de agrupar).
  const semAgrupamento = new Texto(texto.replace(/\bpor\s+\S+/gi, (m) => " ".repeat(m.length)));
  const conta = /\b(contas|bancos|cartoes)\b/.test(k) ? null : tirarContaOuBanco(semAgrupamento, ctx.contas);
  const base = { inicio: null, fim: null, categoria, conta };
  if (/\b(mes\s+passado|mes\s+anterior|ultimo\s+mes)\b/.test(k)) return { periodo: "mes_anterior", ...base };

  const mes = new RegExp(String.raw`\b(${MESES.join("|")})(?:\s+(?:de\s+)?(\d{4}))?\b`).exec(k);
  if (mes) {
    const [a, m] = partes(ctx.hoje);
    const numero = MESES.indexOf(mes[1]) + 1;
    const ano = mes[2] ? Number(mes[2]) : numero > m ? a - 1 : a;
    return {
      periodo: "intervalo",
      inicio: iso(ano, numero, 1),
      fim: iso(ano, numero, diasNoMes(ano, numero)),
      categoria,
      conta,
    };
  }
  if (/\bsemana\b/.test(k)) return { periodo: "semana", ...base };
  if (/\bontem\b/.test(k)) return { periodo: "ontem", ...base };
  if (/\bhoje\b/.test(k)) return { periodo: "hoje", ...base };
  const dia = tirarData(new Texto(texto), ctx.hoje);
  if (dia) return { periodo: "intervalo", inicio: dia, fim: dia, categoria, conta };
  return { periodo: "mes_atual", ...base };
}

function lerCorrecao(texto: string, ctx: ContextoInterpretacao): Interpretacao {
  const t = new Texto(texto);
  t.tirar(RE_CORRIGIR);
  t.tirar(RE_INICIO_CORRECAO);
  const meio = meioDe(t.livre);
  const data = tirarData(t, ctx.hoje);
  const conta = tirarContaOuBanco(t, ctx.contas);
  const centavos = tirarValor(t);
  const categoria = acharCategoria(t.livre, ["despesa", "receita"], ctx.categorias);
  return {
    intencao: "corrigir",
    ...VAZIO,
    correcao: {
      valor: centavos === null ? null : centavosEmTexto(centavos),
      data,
      conta,
      categoria,
      descricao: null,
      meio,
    },
  };
}

const correcaoVazia = (i: Interpretacao) => !i.correcao || Object.values(i.correcao).every((v) => v === null);

// "era 52", "na verdade foi no itaú": correção do último lançamento, mesmo com valor.
const RE_INICIO_CORRECAO = /^\W*(?:era|na\s+verdade|ops|opa|errei|errado|foi)\b[\s,:]*/;
const RE_ERA = /^\W*(?:era|na\s+verdade|ops|opa|errei|errado)\b/;
// "foi no nubank", "no débito", "foi ontem": sem valor, fala de onde/quando foi.
const RE_SO_LUGAR = /^\W*(?:foi\s+)?(?:no|na|em|pelo|pela|via|com)\b|^\W*foi\b/;

// "essa parcela foi em qual banco?", "qual foi o último?"
const RE_ULTIMO =
  /\b(?:qual|que|onde)\b.*\b(?:banco|conta|cartao|categoria)\b|\b(?:ultimo|ultima)\s+(?:lancamento|registro|gasto|compra)\b|\bo\s+que\s+(?:eu\s+)?(?:registrei|lancei|anotei)\b|\bqual\s+foi\s+o\s+ultimo\b/;

// "saldo", "minhas contas", "como está a fatura?", "vencimento nubank", "quando fecha o itaú?"
const RE_CONTAS =
  /\b(saldos?|minhas\s+contas|contas|faturas?|limites?|vencimentos?|vence|fechamento|fecha|cartoes|cartao)\b/;

// ---------- Fatura do cartão ----------

const RE_FECHA = /\b(?:fecha|fechamento|fechando)\s*(?:e\s+)?(?:em\s+|no\s+)?(?:dia\s+)?(\d{1,2})\b/;
const RE_VENCE =
  /\b(?:que\s+)?(?:vence|vencimento|vencendo|vcto|venc)\s*(?::\s*)?(?:em\s+|no\s+|na\s+)?(?:dia\s+)?(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{4}|\d{2}))?)?\b/;
const RE_PAGUEI = /\b(paguei|pago|paga|quitei|quitado|quitada)\b/;

/** Próxima data com esse dia (hoje conta), ou a data dd/mm[/aaaa] dita. Vencimento é sempre para frente. */
function dataDeVencimento(hoje: DataISO, dia: number, mes?: number, ano?: number): DataISO | null {
  const [a, m, d] = partes(hoje);
  if (dia < 1 || dia > 31) return null;
  if (mes) {
    let data = iso(ano ?? a, mes, dia);
    if (!dataValida(data)) return null;
    if (!ano && data < somarDias(hoje, -5)) data = iso(a + 1, mes, dia);
    return dataValida(data) ? data : null;
  }
  const esteMes = iso(a, m, Math.min(dia, diasNoMes(a, m)));
  return dia >= d ? esteMes : somarMeses(iso(a, m, 1), 1, dia);
}

function tirarVencimento(t: Texto, hoje: DataISO): DataISO | null {
  const r = t.tirar(RE_VENCE);
  if (!r) return null;
  const ano = r[3] ? (r[3].length === 2 ? 2000 + Number(r[3]) : Number(r[3])) : undefined;
  return dataDeVencimento(hoje, Number(r[1]), r[2] ? Number(r[2]) : undefined, ano);
}

/** "fatura nubank 1547", "fatura do itaú 820 vence dia 15", "paguei a fatura do nubank 1547". */
function lerFatura(texto: string, ctx: ContextoInterpretacao): Interpretacao | null {
  const t = new Texto(texto);
  const conta = tirarContaOuBanco(t, ctx.contas);
  const vencimento = tirarVencimento(t, ctx.hoje);
  t.tirar(RE_FECHA);
  tirarData(t, ctx.hoje);
  const centavos = tirarValor(t);
  const paga = RE_PAGUEI.test(chave(texto));
  // "paguei a fatura do nubank" (sem valor): a fatura informada sai de "a pagar".
  if (centavos === null && !vencimento && !paga) return null;
  const fatura: PedidoFatura = {
    conta,
    valor: centavos === null ? null : centavosEmTexto(centavos),
    vencimento,
    paga,
  };
  return { intencao: "fatura", ...VAZIO, fatura };
}

/** "nubank fecha dia 3 e vence dia 10". */
function lerCartao(texto: string, ctx: ContextoInterpretacao): Interpretacao | null {
  const t = new Texto(texto);
  const fecha = t.tirar(RE_FECHA);
  const vence = t.tirar(RE_VENCE);
  if (!fecha || !vence) return null;
  const diaFechamento = Number(fecha[1]);
  const diaVencimento = Number(vence[1]);
  if (diaFechamento < 1 || diaFechamento > 31 || diaVencimento < 1 || diaVencimento > 31) return null;
  return {
    intencao: "configurar_cartao",
    ...VAZIO,
    cartao: { conta: tirarContaOuBanco(t, ctx.contas), diaFechamento, diaVencimento },
  };
}

// "o que são outros?", "o que tem em alimentação", "detalhar mercado", "lançamentos de outros", "outros"
const RE_DETALHAR =
  /^\W*(?:o\s+que\s+(?:e|eh|sao|tem|foi|entrou|saiu|caiu|ta|esta)\s+(?:em\s+|no\s+|na\s+|de\s+|o\s+|a\s+|os\s+)?|quais\s+(?:sao\s+)?(?:os\s+|as\s+)?(?:lancamentos\s+|gastos\s+)?(?:de\s+|do\s+|da\s+|em\s+)?|detalh\w*\s+(?:de\s+|do\s+|da\s+|em\s+)?|list\w*\s+(?:de\s+|do\s+|da\s+|em\s+)?|mostr\w*\s+(?:os\s+|as\s+)?(?:lancamentos\s+|gastos\s+)?(?:de\s+|do\s+|da\s+|em\s+)?|(?:lancamentos|gastos|itens)\s+(?:de|do|da|em)\s+)/;

/** "o que são outros", "Outros", "detalhar mercado em outubro": lista os lançamentos da categoria. */
function lerDetalhe(texto: string, ctx: ContextoInterpretacao): Interpretacao | null {
  const k = chave(texto);
  const prefixo = RE_DETALHAR.exec(k);
  const resto = prefixo ? texto.slice(prefixo[0].length) : texto;
  // Sem prefixo, só o nome exato da categoria ("Outros", "mercado?"); "almocei fora" não é pedido de lista.
  const limpo = chave(resto).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const categoria = prefixo
    ? acharCategoria(chave(resto), ["despesa", "receita"], ctx.categorias)
    : ctx.categorias.find((c) => chave(c.nome) === limpo)?.nome ?? null;
  if (!categoria) return null;
  const resumo = pedidoResumo(resto, ctx);
  return { intencao: "resumo", ...VAZIO, resumo: { ...resumo, categoria } };
}

// "roberto é moradia", "pix da larissa vai para lazer", "uber = transporte"
const RE_CATEGORIZAR = /^\s*(?:categoriz\w*\s+)?(.+?)\s+(?:é|eh|=|vai\s+(?:pra|para|em)|entra\s+(?:em|como)|fica\s+(?:em|como))\s+(?:de\s+|da\s+|do\s+|em\s+|como\s+|na\s+|no\s+)?(.+?)\s*[.!]*$/i;
const PALAVRAS_DO_TERMO_VAZIAS = new Set(
  "o a os as pix enviado enviada recebido recebida da do de dos das para pra todo toda todos tudo compra compras lancamento lancamentos gasto gastos".split(" "),
);

function lerCategorizar(texto: string, ctx: ContextoInterpretacao): Interpretacao | null {
  const m = RE_CATEGORIZAR.exec(texto.toLowerCase());
  if (!m) return null;
  const categoria = acharCategoria(chave(m[2]), ["despesa", "receita"], ctx.categorias);
  if (!categoria) return null;
  const termo = chave(m[1]).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((p) => p && !PALAVRAS_DO_TERMO_VAZIAS.has(p)).join(" ");
  if (termo.length < 3) return null;
  return { intencao: "categorizar", ...VAZIO, regra: { termo, categoria } };
}

/** "nubank", "cartão itaú", "débito": a mensagem é só uma conta ou um meio de pagamento. */
function ehSoContaOuMeio(texto: string, ctx: ContextoInterpretacao): boolean {
  const t = new Texto(texto);
  const achou = tirarContaOuBanco(t, ctx.contas) !== null || t.tirar(/\b(?:no\s+|na\s+)?(?:debito|credito|pix)\b/) !== null;
  return achou && !/[\p{L}\p{N}]/u.test(t.livre.replace(/\b(foi|e|o|a)\b/g, ""));
}

// ---------- Respostas curtas (a uma pergunta que o bot fez) ----------

/** Categoria citada num texto curto ("moradia", "é lazer"). */
export function categoriaNoTexto(texto: string, tipos: TipoLancamento[], categorias: Categoria[]): string | null {
  return acharCategoria(chave(texto), tipos, categorias);
}

/** Conta ou banco citado num texto curto ("nubank", "no itaú"). */
export function contaNoTexto(texto: string, contas: Conta[]): string | null {
  return tirarContaOuBanco(new Texto(texto), contas);
}

/** "dia 10", "10", "10/12": a data de vencimento (sempre para frente). */
export function vencimentoNoTexto(texto: string, hoje: DataISO): DataISO | null {
  const limpo = chave(texto).replace(/^\W*(?:(?:no|para\s+o|pro|o)\s+)?(?:vence\w*|vencimento)?\s*(?:(?:no|em)\s+)?(?:dia\s+)?/, "");
  return tirarVencimento(new Texto(`vence dia ${limpo}`), hoje);
}

// "parar lembretes", "desligar avisos", "ligar lembretes", "lembretes"
const RE_LEMBRETES = /\b(lembretes?|avisos?|notificac\w*|alertas?)\b/;
const RE_DESLIGAR = /\b(para|parar|pare|pausa\w*|deslig\w*|desativ\w*|silenci\w*|sem|nao|chega|tir\w*|cancel\w*|stop)\b/;
const RE_LIGAR = /\b(lig\w*|ativ\w*|reativ\w*|volt\w*|quero|religar)\b/;

function lerLembretes(k: string): Interpretacao | null {
  if (!RE_LEMBRETES.test(k) || palavrasDe(k) > 6) return null;
  const lembretes = RE_DESLIGAR.test(k) ? false : RE_LIGAR.test(k) ? true : null;
  return { intencao: "lembretes", ...VAZIO, lembretes };
}

const palavrasDe = (k: string) => k.split(/[^a-z0-9]+/).filter(Boolean).length;

// ---------- Simulação, previsão e renda ----------

// "vou comprar um ar de 500 em 3x", "se eu parcelar...", "posso gastar 300?", "quanto compromete", "cabe?"
const RE_SIMULAR =
  /\b(?:vou\s+(?:comprar|pagar|gastar|parcelar|fazer|pegar)|se\s+eu\s+(?:comprar|gastar|parcelar|pegar|pagar|fizer)|posso\s+(?:comprar|gastar|parcelar|pagar)|(?:da|daria)\s+(?:pra|para)\s+(?:comprar|parcelar|gastar|pagar)|consigo\s+(?:comprar|pagar|parcelar)|quero\s+comprar|pensando\s+em\s+comprar|simul\w*|comprometer|compromete|comprometimento|cabe|caberia|vale\s+a\s+pena)\b/;
// "previsão", "quanto vai sobrar?", "como vou fechar o mês?"
const RE_PREVISAO =
  /\b(?:previsao|projecao|quanto\s+(?:vai|vou|deve|ira)\s+sobrar|vai\s+sobrar|vou\s+fechar|vai\s+fechar|como\s+(?:vou|vai)\s+fechar)\b/;
// "minha renda é 4500", "meu salário é 3200", "ganho 5 mil por mês", "recebo 4000 por mês"
const RE_RENDA =
  /\b(?:minha\s+renda|renda\s+mensal|renda\s+(?:e|eh|de)|meu\s+salario\s+(?:e|eh|de|=)|(?:ganho|recebo)\b.*\b(?:por|ao|no|todo)\s+mes)\b/;
// Palavras da pergunta que não descrevem a compra.
const PALAVRAS_DA_PERGUNTA = new Set(
  ("vou comprar pagar gastar parcelar fazer pegar se eu posso consigo quero pensando da daria quanto isso isto ira irá vai " +
    "comprometer compromete comprometimento renda orcamento orçamento cabe caberia sera será simular simulacao simulação " +
    "vale pena fica ficaria num numa nuns numas minha meu mes mês mensal qual quais como ai aí entao então teria tenho dinheiro sobra sobrar").split(" "),
);

function lerSimulacao(texto: string, ctx: ContextoInterpretacao): Interpretacao | null {
  const limpo = texto.split(/\s+/).filter((p) => !PALAVRAS_DA_PERGUNTA.has(chave(p).replace(/[^a-z0-9]/g, ""))).join(" ");
  const compra = lerLancamento(limpo, ctx);
  if (!compra) return null;
  compra.tipo = "despesa";
  if (compra.descricao === "Gasto") compra.descricao = "Compra";
  return { intencao: "simular", ...VAZIO, simulacao: { compra, texto } };
}

/** O valor citado num texto curto ("4500", "5 mil"), em centavos. */
export function valorNoTexto(texto: string): number | null {
  return tirarValor(new Texto(texto));
}

const RE_ALTERAR = /\b(alter\w*|mud\w*|troc\w*|corrig\w*|ajust\w*)\b/;

/** Entende a mensagem por regras. Devolve null quando não tem certeza do que ela pede. */
export function interpretarPorRegras(ctx: ContextoInterpretacao): Interpretacao | null {
  const texto = ctx.texto.trim();
  if (!texto) return null;
  const k = chave(texto);

  if (RE_CORRIGIR.test(k)) return lerCorrecao(texto, ctx);
  if (RE_FECHA.test(k) && RE_VENCE.test(k)) {
    const cartao = lerCartao(texto, ctx);
    if (cartao) return cartao;
  }
  // "fatura nubank 1547", e também "alterar vencimento nubank dia 10" (sem a palavra fatura).
  if (/\bfatura\b/.test(k) || (/\b(vence|vencimento|vencendo)\b/.test(k) && /\d/.test(k) && !RE_FECHA.test(k))) {
    const fatura = lerFatura(texto, ctx);
    if (fatura) return fatura;
  }
  if (RE_RENDA.test(k)) {
    const centavos = valorNoTexto(texto);
    if (centavos !== null) return { intencao: "renda", ...VAZIO, renda: centavosEmTexto(centavos) };
  }
  if (RE_SIMULAR.test(k)) {
    const simulacao = lerSimulacao(texto, ctx);
    if (simulacao) return simulacao;
  }
  if (RE_ERA.test(k)) {
    const c = lerCorrecao(texto, ctx);
    if (!correcaoVazia(c)) return c;
  }
  // "alterar vencimento nubank": falta o dia; o bot pergunta.
  if (RE_ALTERAR.test(k) && /\bvenc\w*/.test(k) && !/\d/.test(k)) {
    const fatura: PedidoFatura = { conta: contaNoTexto(texto, ctx.contas), valor: null, vencimento: null, paga: false };
    return { intencao: "fatura", ...VAZIO, fatura };
  }

  const lancamentos = dividir(texto, ctx).map((s) => lerLancamento(s, ctx));
  const temValor = lancamentos.every((l) => l !== null);
  if (!temValor) {
    const lembretes = lerLembretes(k);
    if (lembretes) return lembretes;
    if (RE_PREVISAO.test(k) || (RE_SIMULAR.test(k) && /\b(?:sobra|sobrar|renda|orcamento)\b/.test(k))) {
      return { intencao: "simular", ...VAZIO, simulacao: { compra: null, texto } };
    }
    if (RE_DESFAZER.test(k)) {
      const alvo = /\b(vencimento|fatura|parcela|parcelado|parcelada|correcao|fechamento|dias)\b/.exec(k)?.[1] ?? null;
      return { intencao: "desfazer", ...VAZIO, desfazerAlvo: alvo };
    }
    const detalhe = lerDetalhe(texto, ctx);
    if (detalhe) return detalhe;
    const categorizar = lerCategorizar(texto, ctx);
    if (categorizar) return categorizar;
    if (RE_ULTIMO.test(k)) return { intencao: "ultimo", ...VAZIO };
    if (RE_RESUMO.test(k)) return { intencao: "resumo", ...VAZIO, resumo: pedidoResumo(texto, ctx) };
    if (RE_AJUDA.test(k)) return { intencao: "ajuda", ...VAZIO };
    if (RE_CONTAS.test(k) && !RE_SO_LUGAR.test(k)) {
      const conta = /\b(contas|cartoes)\b/.test(k) ? null : tirarContaOuBanco(new Texto(texto), ctx.contas);
      return { intencao: "contas", ...VAZIO, contaConsulta: conta };
    }
    // Só o nome do banco ("Nubank"): mostra a conta. Com "no"/"foi no" é correção (abaixo).
    if (!RE_SO_LUGAR.test(k) && ehSoContaOuMeio(texto, ctx)) {
      const conta = tirarContaOuBanco(new Texto(texto), ctx.contas);
      if (conta) return { intencao: "contas", ...VAZIO, contaConsulta: conta };
    }
    // Sem valor, só dizendo onde ou quando foi: é sobre o último lançamento.
    if (RE_SO_LUGAR.test(k) || ehSoContaOuMeio(texto, ctx)) {
      const c = lerCorrecao(texto, ctx);
      if (!correcaoVazia(c)) return c;
    }
    return null;
  }
  return { intencao: "registrar", ...VAZIO, lancamentos: lancamentos as LancamentoInterpretado[] };
}
