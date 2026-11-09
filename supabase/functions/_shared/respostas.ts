// Textos que o bot devolve no WhatsApp. Formatação do WhatsApp: *negrito*, _itálico_.
import { dataAmigavel } from "./datas.ts";
import { formatarReais } from "./dinheiro.ts";
import type { Categoria, Conta, DataISO, LinhaResumo, TipoLancamento, Transacao } from "./tipos.ts";

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
  tipo: TipoLancamento;
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

function contaTexto(conta: Conta | null): string {
  if (!conta) return "sem conta";
  const icone = conta.tipo === "cartao_credito" ? "💳" : conta.tipo === "dinheiro" ? "💵" : "🏦";
  return `${icone} ${conta.nome}`;
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

export function textoResumo(linhas: LinhaResumo[], rotulo: string, categoriaFiltro: string | null): string {
  if (categoriaFiltro) {
    const doFiltro = linhas.filter((l) => normalizar(l.categoria) === normalizar(categoriaFiltro));
    if (doFiltro.length === 0) return `📊 Nada em *${categoriaFiltro}* em ${rotulo}.`;
    const soma = doFiltro.reduce((a, l) => a + l.totalCentavos, 0);
    const qtd = doFiltro.reduce((a, l) => a + l.quantidade, 0);
    return `📊 *${doFiltro[0].categoria}* em ${rotulo}: ${formatarReais(soma)} (${qtd} lançamento${qtd > 1 ? "s" : ""})`;
  }

  const despesas = linhas.filter((l) => l.tipo === "despesa");
  const receitas = linhas.filter((l) => l.tipo === "receita");
  if (despesas.length === 0 && receitas.length === 0) return `📊 Nada registrado em ${rotulo} ainda.`;

  const totalDespesas = despesas.reduce((a, l) => a + l.totalCentavos, 0);
  const totalReceitas = receitas.reduce((a, l) => a + l.totalCentavos, 0);
  const partes = [`📊 *Resumo — ${rotulo}*`];
  if (despesas.length) {
    partes.push(
      "",
      `*Despesas: ${formatarReais(totalDespesas)}*`,
      ...despesas.map((l) => `• ${l.categoria}: ${formatarReais(l.totalCentavos)}${porcentagem(l.totalCentavos, totalDespesas)}`),
    );
  }
  if (receitas.length) {
    partes.push(
      "",
      `*Receitas: ${formatarReais(totalReceitas)}*`,
      ...receitas.map((l) => `• ${l.categoria}: ${formatarReais(l.totalCentavos)}`),
    );
  }
  if (despesas.length && receitas.length) {
    partes.push("", `*Saldo do período:* ${formatarReais(totalReceitas - totalDespesas)}`);
  }
  return partes.join("\n");
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

Errou? *desfazer* cancela o último registro e *corrigir: era 52* ajusta.`;
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
