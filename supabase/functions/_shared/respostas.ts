// Textos que o bot devolve (WhatsApp e Telegram). Marcação: *negrito*, _itálico_.
import { dataAmigavel, hojeNoFuso, vencimentoFatura } from "./datas.ts";
import { formatarReais } from "./dinheiro.ts";
import { chave } from "./texto.ts";
import type {
  Categoria,
  Conta,
  DataISO,
  LinhaFatura,
  LinhaResumo,
  LinhaResumoConta,
  LancamentoResumido,
  TipoTransacao,
  Transacao,
} from "./tipos.ts";

export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Um lançamento como a pessoa o vê: uma compra parcelada é UM item com N valores. */
export interface ItemLancamento {
  tipo: TipoTransacao;
  descricao: string;
  estabelecimento: string | null;
  valores: number[];
  data: DataISO;
  conta: Conta | null;
  categoria: Categoria | null;
  pagamentos: (DataISO | null)[];
}

const total = (valores: number[]) => valores.reduce((a, b) => a + b, 0);

function titulo(item: ItemLancamento): string {
  const e = item.estabelecimento;
  return e && normalizar(e) !== normalizar(item.descricao) ? `${item.descricao} · ${e}` : item.descricao;
}

function valorTexto(item: ItemLancamento): string {
  const n = item.valores.length;
  const t = formatarReais(total(item.valores));
  if (n === 1) return t;
  const primeira = item.valores[0];
  const demais = item.valores[n - 1];
  return primeira === demais
    ? `${t} em ${n}x de ${formatarReais(demais)}`
    : `${t} em ${n}x (1ª de ${formatarReais(primeira)}, demais de ${formatarReais(demais)})`;
}

const icone = (tipo: string | null | undefined) => (tipo === "cartao_credito" ? "💳" : tipo === "dinheiro" ? "💵" : "🏦");

function contaTexto(conta: Conta | null): string {
  if (!conta) return "sem conta";
  return `${icone(conta.tipo)} ${conta.nome}`;
}

function linhaFatura(item: ItemLancamento, hoje: DataISO): string | null {
  if (item.conta?.tipo !== "cartao_credito") return null;
  const primeiro = item.pagamentos[0];
  const ultimo = item.pagamentos[item.pagamentos.length - 1];
  if (!primeiro || !ultimo) return null;
  if (item.valores.length === 1) return `🧾 Cai na fatura que vence em ${dataAmigavel(primeiro, hoje)}.`;
  return `🧾 1ª parcela na fatura de ${dataAmigavel(primeiro, hoje)}, última em ${dataAmigavel(ultimo, hoje)}.`;
}

const RODAPE = "\n_Errou? Responda *desfazer*._";

export function textoRegistro(itens: ItemLancamento[], hoje: DataISO, cabecalho?: string): string {
  if (itens.length === 1 && itens[0].tipo === "pagamento_fatura") {
    const item = itens[0];
    return `${cabecalho ?? "🧾 *Fatura:*"} ${valorTexto(item)} — ${contaTexto(item.conta)}\n📅 ${
      item.pagamentos[0] ? `Vence ${dataAmigavel(item.pagamentos[0], hoje)}` : "Vencimento a definir"
    }${RODAPE}`;
  }
  if (itens.length === 1) {
    const item = itens[0];
    const rotulo = cabecalho ?? (item.tipo === "receita" ? "✅ *Receita registrada:*" : "✅ *Registrado:*");
    const linhas = [
      `${rotulo} ${valorTexto(item)} — ${titulo(item)}`,
      `📂 ${item.categoria?.nome ?? "Sem categoria"} · ${contaTexto(item.conta)} · 📅 ${dataAmigavel(item.data, hoje)}`,
    ];
    const fatura = linhaFatura(item, hoje);
    if (fatura) linhas.push(fatura);
    return linhas.join("\n") + RODAPE;
  }

  const linhas = [cabecalho ?? `✅ *Registrei ${itens.length} lançamentos:*`];
  for (const item of itens) {
    const sinal = item.tipo === "receita" ? "➕ " : "";
    linhas.push(
      `• ${sinal}${valorTexto(item)} — ${titulo(item)} (${item.categoria?.nome ?? "Sem categoria"} · ${
        item.conta?.nome ?? "sem conta"
      } · ${dataAmigavel(item.data, hoje)})`,
    );
  }
  const despesas = total(itens.filter((i) => i.tipo === "despesa").flatMap((i) => i.valores));
  if (despesas > 0) linhas.push(`*Total de despesas:* ${formatarReais(despesas)}`);
  return linhas.join("\n") + RODAPE;
}

/** Reagrupa transações gravadas (parcelas viram um item só) para mostrar na resposta. */
export function itensDeTransacoes(ts: Transacao[], contas: Conta[], categorias: Categoria[]): ItemLancamento[] {
  const grupos = new Map<string, Transacao[]>();
  for (const t of ts) {
    const chave = t.grupoParcelamento ?? t.id;
    grupos.set(chave, [...(grupos.get(chave) ?? []), t]);
  }
  return [...grupos.values()].map((g) => {
    g.sort((a, b) => (a.parcelaNumero ?? 1) - (b.parcelaNumero ?? 1));
    const p = g[0];
    return {
      tipo: p.tipo,
      descricao: p.descricao,
      estabelecimento: p.estabelecimento,
      valores: g.map((t) => t.valorCentavos),
      data: p.dataTransacao,
      conta: contas.find((c) => c.id === p.contaId) ?? null,
      categoria: categorias.find((c) => c.id === p.categoriaId) ?? null,
      pagamentos: g.map((t) => t.dataPagamento),
    };
  });
}

/** Como um registro aparece no "desfeito": "R$ 50,34 — Compra parcelada (3 parcelas)". */
export function resumoParaDesfazer(itens: ItemLancamento[]): string {
  return itens
    .map((i) => {
      const parcelas = i.valores.length > 1 ? ` (${i.valores.length} parcelas)` : "";
      return `${formatarReais(total(i.valores))} — ${titulo(i)}${parcelas}`;
    })
    .join("; ");
}

export function textoDesfeito(resumo: string): string {
  return `↩️ *Desfeito:* ${resumo}`;
}

const vencimentoTexto = (v: DataISO | null, hoje: DataISO) =>
  !v ? "vencimento a definir" : v < hoje ? `venceu ${dataAmigavel(v, hoje)}` : `vence ${dataAmigavel(v, hoje)}`;

/**
 * Faturas a mostrar, por cartão: as que você informou e a próxima calculada pelas compras.
 * A informada vale mais que a calculada do mesmo vencimento; informada sem vencimento esconde a
 * calculada (não dá para saber se é a mesma). Ordem: as que vencem primeiro.
 */
export function faturasParaMostrar(linhas: LinhaFatura[]): LinhaFatura[] {
  const porCartao = new Map<string, LinhaFatura[]>();
  for (const l of linhas) porCartao.set(l.contaId, [...(porCartao.get(l.contaId) ?? []), l]);
  const saida: LinhaFatura[] = [];
  for (const ls of porCartao.values()) {
    const informadas = ls.filter((l) => l.informada);
    saida.push(...informadas);
    if (informadas.some((l) => !l.vencimento)) continue;
    const ultimaInformada = informadas.map((l) => l.vencimento!).sort().at(-1) ?? "";
    const proxima = ls
      .filter((l) => !l.informada && l.totalCentavos > 0 && (l.vencimento ?? "") > ultimaInformada)
      .sort((a, b) => (a.vencimento ?? "").localeCompare(b.vencimento ?? ""))[0];
    if (proxima) saida.push(proxima);
  }
  return saida.sort((a, b) => (a.vencimento ?? "9999").localeCompare(b.vencimento ?? "9999"));
}

function linhasFaturas(linhas: LinhaFatura[], hoje: DataISO): string[] {
  const mostrar = faturasParaMostrar(linhas);
  if (!mostrar.length) return [];
  const total = mostrar.reduce((a, l) => a + l.totalCentavos, 0);
  return [
    "",
    `🧾 *Faturas a pagar: ${formatarReais(total)}*`,
    ...mostrar.map((l) =>
      `• 💳 ${l.conta}: ${formatarReais(l.totalCentavos)} · ${vencimentoTexto(l.vencimento, hoje)}${
        l.informada ? "" : " _(compras até agora)_"
      }`
    ),
  ];
}

/** Uma linha por conta, com o que saiu e o que entrou. Só aparece com mais de uma conta. */
function linhasPorConta(porConta: LinhaResumoConta[]): string[] {
  const contas = new Map<string, { nome: string; tipo: string | null; saiu: number; entrou: number }>();
  for (const l of porConta) {
    const k = l.contaId ?? "-";
    const c = contas.get(k) ?? { nome: l.conta ?? "Sem conta", tipo: l.conta ? l.tipoConta : null, saiu: 0, entrou: 0 };
    if (l.tipo === "despesa") c.saiu += l.totalCentavos;
    else c.entrou += l.totalCentavos;
    contas.set(k, c);
  }
  if (contas.size < 2) return [];
  const linhas = [...contas.values()]
    .sort((a, b) => b.saiu + b.entrou - (a.saiu + a.entrou))
    .map((c) => {
      const partes = [];
      if (c.saiu) partes.push(`saiu ${formatarReais(c.saiu)}`);
      if (c.entrou) partes.push(`entrou ${formatarReais(c.entrou)}`);
      return `• ${c.tipo ? icone(c.tipo) : "❔"} ${c.nome}: ${partes.join(" · ")}`;
    });
  return ["", "*Por conta*", ...linhas];
}

/** "Pix enviado Roberto Augusto Costa de Souza" → "Pix enviado Roberto Augusto Costa…" */
const encurtar = (s: string, max = 34) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export interface ExtrasResumo {
  porConta: LinhaResumoConta[];
  faturas: LinhaFatura[];
  /** Resumo de uma conta só ("quanto gastei no nubank?"). */
  conta: Conta | null;
  hoje: DataISO;
  /** Maiores lançamentos de "Outros" e "Outras receitas", para dizer o que tem lá dentro. */
  destaques?: Map<string, LancamentoResumido[]>;
}

const maiuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function textoResumo(
  linhas: LinhaResumo[],
  rotulo: string,
  _categoriaFiltro: string | null,
  extras: ExtrasResumo = { porConta: [], faturas: [], conta: null, hoje: "" },
): string {
  const titulo = extras.conta ? `📊 *${extras.conta.nome} · ${rotulo}*` : `📊 *${maiuscula(rotulo)}*`;
  const despesas = linhas.filter((l) => l.tipo === "despesa").sort((a, b) => b.totalCentavos - a.totalCentavos);
  const receitas = linhas.filter((l) => l.tipo === "receita").sort((a, b) => b.totalCentavos - a.totalCentavos);
  const faturas = linhasFaturas(extras.faturas, extras.hoje);
  if (despesas.length === 0 && receitas.length === 0) {
    return [titulo, "Nada registrado ainda.", ...faturas].join("\n");
  }

  const totalDespesas = despesas.reduce((a, l) => a + l.totalCentavos, 0);
  const totalReceitas = receitas.reduce((a, l) => a + l.totalCentavos, 0);
  const saldo = totalReceitas - totalDespesas;
  const partes = [titulo, ""];
  if (receitas.length) partes.push(`💰 Entrou: *${formatarReais(totalReceitas)}*`);
  if (despesas.length) partes.push(`💸 Saiu: *${formatarReais(totalDespesas)}*`);
  if (despesas.length && receitas.length) partes.push(`${saldo >= 0 ? "📈" : "📉"} Saldo: *${formatarReais(saldo)}*`);

  const comDestaque = (l: LinhaResumo) => {
    const linha = `• ${l.categoria}: ${formatarReais(l.totalCentavos)}`;
    const itens = extras.destaques?.get(l.categoria) ?? [];
    if (!itens.length) return [linha];
    return [linha, `   _${itens.map((i) => `${encurtar(i.descricao)} ${formatarReais(i.valorCentavos)}`).join("; ")}_`];
  };
  if (despesas.length) partes.push("", "*Para onde foi*", ...despesas.flatMap(comDestaque));
  if (receitas.length) partes.push("", "*De onde veio*", ...receitas.flatMap(comDestaque));
  partes.push(...linhasPorConta(extras.porConta));
  partes.push(...faturas);
  if (extras.destaques && [...extras.destaques.values()].some((i) => i.length)) {
    partes.push("", "_Detalhe uma categoria: o que é outros? · Mude a categoria: roberto é moradia_");
  }
  return partes.join("\n");
}

/** "o que é outros?": os maiores lançamentos da categoria no período. */
export function textoCategoria(
  categoria: Categoria,
  rotulo: string,
  conta: Conta | null,
  itens: LancamentoResumido[],
  quantidade: number,
  total: number,
  hoje: DataISO,
  pergunta: string | null = null,
): string {
  const onde = conta ? ` no ${conta.nome}` : "";
  if (!itens.length) return `📂 Nada em *${categoria.nome}*${onde} em ${rotulo}.`;
  const linhas = [
    `📂 *${categoria.nome}*${onde} · ${rotulo}: *${formatarReais(total)}* (${quantidade} lançamento${quantidade > 1 ? "s" : ""})`,
    ...itens.map((i) =>
      `• ${formatarReais(i.valorCentavos)} — ${encurtar(i.descricao, 40)} · ${dataAmigavel(i.dataTransacao, hoje)}${
        i.conta ? ` · ${i.conta}` : ""
      }`
    ),
  ];
  if (quantidade > itens.length) linhas.push(`_e mais ${quantidade - itens.length} menores._`);
  if (pergunta) linhas.push("", pergunta);
  else if (["outros", "outras receitas"].includes(normalizar(categoria.nome))) {
    linhas.push("", "_Para mudar a categoria, diga quem é: roberto é moradia, larissa é lazer._");
  }
  return linhas.join("\n");
}

/** Pergunta a categoria de um lançamento que caiu em "Outros". A resposta pode ser só a categoria. */
export function textoPerguntaCategoria(descricao: string, valorCentavos: number, exemplos: string[]): string {
  return `❓ *${encurtar(descricao, 40)}* (${formatarReais(valorCentavos)}) é de qual categoria?\n` +
    `_Responda só o nome — ${exemplos.map((e) => e.toLowerCase()).join(", ")}… — ou *pular*._`;
}

/** "roberto é moradia" aplicado. */
export function textoCategorizado(termo: string, categoria: string, mudados: number, total: number): string {
  const linhas = [`📂 Combinado: o que tiver *${termo}* vai para *${categoria}*.`];
  linhas.push(
    mudados
      ? `✅ Mudei ${mudados} lançamento${mudados > 1 ? "s" : ""} (${formatarReais(total)}).`
      : "Nenhum lançamento de agora tinha esse nome; vale para os próximos.",
  );
  return linhas.join("\n") + RODAPE;
}

/** Resposta ao informar uma fatura. Ela não soma nas despesas: os gastos são as compras dentro dela. */
export function textoFatura(t: Transacao, cartao: Conta | null, hoje: DataISO, cabecalho = "🧾 *Fatura registrada:*"): string {
  const linhas = [
    `${cabecalho} ${formatarReais(t.valorCentavos)} — ${contaTexto(cartao)}`,
    cabecalho.startsWith("✅")
      ? `📅 Paga ${dataAmigavel(t.dataPagamento ?? hoje, hoje)}`
      : `📅 ${t.dataPagamento ? `Vence ${dataAmigavel(t.dataPagamento, hoje)}` : "Vencimento a definir"}`,
  ];
  if (!t.dataPagamento && !cabecalho.startsWith("✅")) {
    const k = chave(cartao?.instituicao || cartao?.nome.replace(/^Cartão\s+/i, "") || "nubank").trim();
    linhas.push(`_Quando vence? Responda: fatura ${k} vence dia 15._`);
  }
  return linhas.join("\n") + RODAPE;
}

export function textoCartaoConfigurado(c: Conta, atualizados: number, hoje: DataISO): string {
  const linhas = [`💳 *${c.nome}*: fecha dia ${c.diaFechamento}, vence dia ${c.diaVencimento}.`];
  if (c.diaFechamento && c.diaVencimento) {
    linhas.push(`🧾 Uma compra hoje cai na fatura que vence ${dataAmigavel(vencimentoFatura(hoje, c.diaFechamento, c.diaVencimento), hoje)}.`);
  }
  if (atualizados) linhas.push(`✅ Atualizei ${atualizados} lançamento${atualizados > 1 ? "s" : ""} desse cartão.`);
  return linhas.join("\n");
}

/** "contas"/"saldo": cada conta com o que o banco informou e as faturas em aberto. */
export function textoContas(contas: Conta[], faturas: LinhaFatura[], hoje: DataISO, soEstas = false): string {
  if (!contas.length) {
    return "🏦 Nenhuma conta ainda. Elas aparecem quando você cita o banco (_almoço 35 no nubank_) ou conecta pelo Meu Pluggy.";
  }
  const linhas = soEstas ? [] : ["🏦 *Suas contas*"];
  const ordem = [...contas].sort((a, b) => Number(a.tipo === "cartao_credito") - Number(b.tipo === "cartao_credito") || a.nome.localeCompare(b.nome));
  for (const c of ordem) {
    const partes: string[] = [];
    if (c.saldoCentavos != null) {
      partes.push(
        c.tipo === "cartao_credito"
          ? `usado ${formatarReais(c.saldoCentavos)}${c.limiteCentavos ? ` de ${formatarReais(c.limiteCentavos)}` : ""}`
          : `saldo ${formatarReais(c.saldoCentavos)}`,
      );
      if (c.saldoAtualizadoEm) {
        partes.push(`banco ${dataAmigavel(hojeNoFuso("America/Sao_Paulo", new Date(c.saldoAtualizadoEm)), hoje)}`);
      }
    }
    if (c.tipo === "cartao_credito") {
      partes.push(c.diaFechamento ? `fecha dia ${c.diaFechamento}, vence dia ${c.diaVencimento}` : "sem dias de fechamento e vencimento");
    }
    const nome = soEstas ? `${icone(c.tipo)} *${c.nome}*` : `• ${icone(c.tipo)} ${c.nome}`;
    linhas.push(partes.length ? `${nome} · ${partes.join(" · ")}` : nome);
  }
  const blocoFaturas = linhasFaturas(faturas, hoje);
  const temCartao = contas.some((c) => c.tipo === "cartao_credito");
  if (blocoFaturas.length) linhas.push(...blocoFaturas);
  else if (temCartao) linhas.push("", "🧾 Nenhuma fatura em aberto.");
  return linhas.join("\n").trim();
}

export function textoAjuda(nome: string): string {
  return `Oi, ${nome.split(" ")[0]}! 👋 Eu registro seus gastos e receitas. É só escrever do seu jeito:

• _gastei 45,90 no ifood no nubank_
• _uber 23 ontem_
• _tv 3000 em 10x no cartão itaú_
• _recebi 5000 de salário_
• _quanto gastei esse mês?_
• _resumo da semana_
• _quanto foi de mercado em outubro?_

*Cartões e faturas*
• _fatura nubank 1547 vence dia 15_
• _nubank fecha dia 3 vence dia 10_
• _paguei a fatura do nubank 1547_
• _nubank_ mostra o cartão; _contas_ mostra todas
_A fatura fica em "a pagar" e não soma nas despesas: as despesas são as compras dela._

*desfazer* volta a última coisa que fiz (pode repetir).
Para ajustar o último: _era 52_, _foi no nubank_, _foi no débito_.
_em qual banco foi?_ mostra o último registro.
Com banco conectado, *atualizar* busca as novidades do banco.`;
}

export function textoVinculado(nome: string): string {
  return `✅ Pronto! Seu Telegram está ligado ao seu controle financeiro.\n\n${textoAjuda(nome)}`;
}

export const TEXTO_BOT_PRIVADO = "🔒 Este bot é privado.";

export const TEXTO_NAO_ENTENDI = `🤔 Não entendi. Tente assim:
• _almoço 35 no nubank_
• _fatura nubank 1547 vence dia 10_
• _resumo da semana_ ou _nubank_
Digite *ajuda* para ver tudo.`;

export const TEXTO_SO_TEXTO =
  "Por enquanto eu só entendo mensagens de texto 🙂 Escreve o gasto, tipo: _almoço 35 no nubank_.";

export const TEXTO_FORA_DO_ESCOPO =
  "Eu cuido só das suas finanças 🙂 Me manda um gasto (_mercado 230 no itaú_) ou peça um resumo (_quanto gastei esse mês?_). Digite *ajuda* para ver tudo.";

export const TEXTO_ERRO = "😕 Tive um problema para processar isso agora. Tenta de novo em instantes?";
