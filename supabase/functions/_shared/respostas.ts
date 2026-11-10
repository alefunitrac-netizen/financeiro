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

const RODAPE = "\n\n_Errei? Responda *desfazer* ou *corrigir: …*_";

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

export function textoDesfeito(itens: ItemLancamento[]): string {
  if (itens.length === 1) {
    const item = itens[0];
    const parcelas = item.valores.length > 1 ? ` (${item.valores.length} parcelas)` : "";
    return `↩️ *Desfeito:* ${formatarReais(total(item.valores))} — ${titulo(item)}${parcelas}`;
  }
  return [
    `↩️ *Desfiz ${itens.length} lançamentos:*`,
    ...itens.map((i) => `• ${formatarReais(total(i.valores))} — ${titulo(i)}`),
  ].join("\n");
}

function porcentagem(parte: number, todo: number): string {
  return todo > 0 ? ` (${Math.round((parte * 100) / todo)}%)` : "";
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

function linhasPorConta(porConta: LinhaResumoConta[], tipo: "despesa" | "receita", total: number): string[] {
  const doTipo = porConta.filter((l) => l.tipo === tipo);
  // Só vale separar se ao menos um lançamento tem conta.
  if (!doTipo.some((l) => l.conta)) return [];
  return [
    "_Por conta_",
    ...doTipo
      .sort((a, b) => b.totalCentavos - a.totalCentavos)
      .map((l) =>
        `• ${l.conta ? `${icone(l.tipoConta)} ${l.conta}` : "❔ Sem conta"}: ${formatarReais(l.totalCentavos)}${
          tipo === "despesa" ? porcentagem(l.totalCentavos, total) : ""
        }`
      ),
  ];
}

export interface ExtrasResumo {
  porConta: LinhaResumoConta[];
  faturas: LinhaFatura[];
  /** Resumo de uma conta só ("quanto gastei no nubank?"). */
  conta: Conta | null;
  hoje: DataISO;
}

export function textoResumo(
  linhas: LinhaResumo[],
  rotulo: string,
  categoriaFiltro: string | null,
  extras: ExtrasResumo = { porConta: [], faturas: [], conta: null, hoje: "" },
): string {
  const ondeTexto = extras.conta ? ` no ${extras.conta.nome}` : "";
  if (categoriaFiltro) {
    const doFiltro = linhas.filter((l) => normalizar(l.categoria) === normalizar(categoriaFiltro));
    if (doFiltro.length === 0) return `📊 Nada em *${categoriaFiltro}*${ondeTexto} em ${rotulo}.`;
    const soma = doFiltro.reduce((a, l) => a + l.totalCentavos, 0);
    const qtd = doFiltro.reduce((a, l) => a + l.quantidade, 0);
    return `📊 *${doFiltro[0].categoria}*${ondeTexto} em ${rotulo}: ${formatarReais(soma)} (${qtd} lançamento${qtd > 1 ? "s" : ""})`;
  }

  const despesas = linhas.filter((l) => l.tipo === "despesa");
  const receitas = linhas.filter((l) => l.tipo === "receita");
  const faturas = linhasFaturas(extras.faturas, extras.hoje);
  if (despesas.length === 0 && receitas.length === 0) {
    return [`📊 Nada registrado${ondeTexto} em ${rotulo} ainda.`, ...faturas].join("\n");
  }

  const totalDespesas = despesas.reduce((a, l) => a + l.totalCentavos, 0);
  const totalReceitas = receitas.reduce((a, l) => a + l.totalCentavos, 0);
  const partes = [extras.conta ? `📊 *${extras.conta.nome} — ${rotulo}*` : `📊 *Resumo — ${rotulo}*`];
  if (despesas.length) {
    const contas = linhasPorConta(extras.porConta, "despesa", totalDespesas);
    partes.push(
      "",
      `💸 *Despesas: ${formatarReais(totalDespesas)}*`,
      ...contas,
      ...(contas.length ? ["_Por categoria_"] : []),
      ...despesas.map((l) => `• ${l.categoria}: ${formatarReais(l.totalCentavos)}${porcentagem(l.totalCentavos, totalDespesas)}`),
    );
  }
  if (receitas.length) {
    const contas = linhasPorConta(extras.porConta, "receita", totalReceitas);
    partes.push(
      "",
      `💰 *Receitas: ${formatarReais(totalReceitas)}*`,
      ...contas,
      ...(contas.length ? ["_Por categoria_"] : []),
      ...receitas.map((l) => `• ${l.categoria}: ${formatarReais(l.totalCentavos)}`),
    );
  }
  if (despesas.length && receitas.length) {
    partes.push("", `*Saldo do período:* ${formatarReais(totalReceitas - totalDespesas)}`);
  }
  partes.push(...faturas);
  return partes.join("\n");
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
    linhas.push(`_Quando vence? Responda: fatura ${k} vence dia 15 — ou cadastre o cartão: ${k} fecha dia 3 vence dia 10._`);
  }
  linhas.push("_Fica em \"faturas a pagar\" e não soma nas despesas: as despesas são as compras dentro dela._");
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
export function textoContas(contas: Conta[], faturas: LinhaFatura[], hoje: DataISO): string {
  if (!contas.length) {
    return "🏦 Nenhuma conta ainda. Elas aparecem quando você cita o banco (_almoço 35 no nubank_) ou conecta pelo Meu Pluggy.";
  }
  const linhas = ["🏦 *Suas contas*"];
  const ordem = [...contas].sort((a, b) => Number(a.tipo === "cartao_credito") - Number(b.tipo === "cartao_credito") || a.nome.localeCompare(b.nome));
  for (const c of ordem) {
    let detalhe: string;
    if (c.saldoCentavos == null) detalhe = "_cadastrada por você_";
    else if (c.tipo === "cartao_credito") {
      detalhe = `usado ${formatarReais(c.saldoCentavos)}${c.limiteCentavos ? ` de ${formatarReais(c.limiteCentavos)}` : ""}`;
    } else detalhe = `saldo ${formatarReais(c.saldoCentavos)}`;
    const quando = c.saldoAtualizadoEm ? ` · banco ${dataAmigavel(hojeNoFuso("America/Sao_Paulo", new Date(c.saldoAtualizadoEm)), hoje)}` : "";
    const dias = c.tipo === "cartao_credito" && c.diaFechamento ? ` · fecha ${c.diaFechamento}, vence ${c.diaVencimento}` : "";
    linhas.push(`• ${icone(c.tipo)} ${c.nome}: ${detalhe}${quando}${dias}`);
  }
  const blocoFaturas = linhasFaturas(faturas, hoje);
  linhas.push(...(blocoFaturas.length ? blocoFaturas : ["", "🧾 Nenhuma fatura em aberto."]));
  return linhas.join("\n");
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
• _contas_ mostra saldos e faturas a pagar

Errou? *desfazer* cancela o último registro. Para ajustar: _era 52_, _foi no nubank_, _foi no débito_.
_em qual banco foi?_ mostra o último registro.
Com banco conectado, *atualizar* busca as novidades do banco.`;
}

export function textoVinculado(nome: string): string {
  return `✅ Pronto! Seu Telegram está ligado ao seu controle financeiro.\n\n${textoAjuda(nome)}`;
}

export const TEXTO_BOT_PRIVADO = "🔒 Este bot é privado.";

export const TEXTO_NAO_ENTENDI = `🤔 Não entendi. Escreve com o valor, assim:

• _almoço 35 em dinheiro_
• _uber 23 ontem no nubank_
• _tv 3000 em 10x no itaú_
• _recebi 5000 de salário_

Ou peça: _resumo da semana_.`;

export const TEXTO_SO_TEXTO =
  "Por enquanto eu só entendo mensagens de texto 🙂 Escreve o gasto, tipo: _almoço 35 no nubank_.";

export const TEXTO_FORA_DO_ESCOPO =
  "Eu cuido só das suas finanças 🙂 Me manda um gasto (_mercado 230 no itaú_) ou peça um resumo (_quanto gastei esse mês?_). Digite *ajuda* para ver tudo.";

export const TEXTO_ERRO = "😕 Tive um problema para processar isso agora. Tenta de novo em instantes?";
