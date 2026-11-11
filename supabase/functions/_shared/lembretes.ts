// Lembretes que o bot manda sozinho, uma vez por dia de manhã (agendado no banco):
//  • fatura do cartão: até 3 dias antes, no dia e, se você informou e não marcou como paga, logo depois;
//  • resumo da semana passada, toda segunda;
//  • conta corrente no negativo (saldo vindo do banco), no máximo uma vez por semana.
// Cada aviso tem uma chave e só sai uma vez (tabela avisos_enviados): rodar duas vezes não repete nada.
import { dataAmigavel, diaDaSemana, hojeNoFuso, intervaloDoPeriodo, somarDias } from "./datas.ts";
import { formatarReais } from "./dinheiro.ts";
import { montarResumo } from "./processador.ts";
import { apelidoDoCartao, faturasParaMostrar } from "./respostas.ts";
import type { Categoria, Conta, DataISO, LinhaFatura, LinhaResumo, Repositorio } from "./tipos.ts";

export interface Aviso {
  chave: string;
  texto: string;
}

const DIAS_ANTES = 3;
const diasEntre = (a: DataISO, b: DataISO) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
const quando = (data: DataISO, hoje: DataISO) => `${diaDaSemana(data)}, ${dataAmigavel(data, hoje)}`;
const ehConta = (c: Conta) => c.tipo === "corrente" || c.tipo === "poupanca";

/** Fatura que vence em breve, que vence hoje, ou (informada por você) que venceu e não foi marcada como paga. */
export function avisosDeFatura(faturas: LinhaFatura[], contas: Conta[], hoje: DataISO): Aviso[] {
  const avisos: Aviso[] = [];
  const comSaldo = contas.filter((c) => ehConta(c) && c.saldoCentavos != null);
  const saldo = comSaldo.reduce((a, c) => a + c.saldoCentavos!, 0);

  for (const f of faturasParaMostrar(faturas)) {
    if (!f.vencimento || f.totalCentavos <= 0) continue;
    const dias = diasEntre(f.vencimento, hoje);
    const cartao = contas.find((c) => c.id === f.contaId);
    const apelido = cartao ? apelidoDoCartao(cartao) : "nubank";
    const valor = `*${formatarReais(f.totalCentavos)}*${f.informada ? "" : " _(compras até agora)_"}`;
    let momento: string;
    let titulo: string;
    if (dias >= 1 && dias <= DIAS_ANTES) {
      momento = "antes";
      titulo = `🔔 *Fatura do ${f.conta} vence ${dias === 1 ? "amanhã" : `em ${dias} dias`}* (${quando(f.vencimento, hoje)}): ${valor}`;
    } else if (dias === 0) {
      momento = "dia";
      titulo = `🔔 *Fatura do ${f.conta} vence hoje*: ${valor}`;
    } else if (dias < 0 && dias >= -5 && f.informada) {
      momento = "atrasada";
      titulo = `⏰ *Fatura do ${f.conta} venceu ${dataAmigavel(f.vencimento, hoje)}*: ${valor}`;
    } else continue;

    const linhas = [titulo];
    if (momento !== "atrasada" && comSaldo.length && saldo < f.totalCentavos) {
      linhas.push(`⚠️ Saldo em conta: ${formatarReais(saldo)} — faltam *${formatarReais(f.totalCentavos - saldo)}* para cobrir.`);
    }
    linhas.push(
      f.informada
        ? `_${momento === "atrasada" ? "Já pagou?" : "Quando pagar,"} responda: paguei a fatura do ${apelido}._`
        : `_Sabe o valor fechado? Responda: fatura ${apelido} 1547 vence dia ${Number(f.vencimento.slice(8))}._`,
    );
    avisos.push({ chave: `fatura:${f.contaId}:${f.vencimento}:${momento}`, texto: linhas.join("\n") });
  }
  return avisos;
}

/** Conta no negativo pelo saldo que o banco informou nos últimos 3 dias. Uma vez por semana. */
export function avisosDeSaldo(contas: Conta[], hoje: DataISO): Aviso[] {
  const semana = intervaloDoPeriodo("semana", hoje).inicio;
  return contas
    .filter((c) =>
      ehConta(c) && c.saldoCentavos != null && c.saldoCentavos < 0 && c.saldoAtualizadoEm &&
      diasEntre(hoje, hojeNoFuso("America/Sao_Paulo", new Date(c.saldoAtualizadoEm))) <= 3
    )
    .map((c) => ({
      chave: `saldo:${c.id}:${semana}`,
      texto: `⚠️ *${c.nome} está no negativo*: ${formatarReais(c.saldoCentavos!)}. ` +
        "_Cheque especial cobra juros altos; vale cobrir logo._",
    }));
}

const totalDespesas = (ls: LinhaResumo[]) => ls.filter((l) => l.tipo === "despesa").reduce((a, l) => a + l.totalCentavos, 0);

/** Na segunda: o resumo da semana anterior (segunda a domingo), comparado com a semana antes dela. */
export async function avisoSemanal(
  repo: Repositorio,
  usuarioId: string,
  categorias: Categoria[],
  hoje: DataISO,
): Promise<Aviso | null> {
  if (diaDaSemana(hoje) !== "segunda-feira") return null;
  const inicio = somarDias(hoje, -7);
  const fim = somarDias(hoje, -1);
  const [semana, anterior] = await Promise.all([
    repo.resumoPorCategoria(usuarioId, inicio, fim),
    repo.resumoPorCategoria(usuarioId, somarDias(inicio, -7), somarDias(fim, -7)),
  ]);
  if (!semana.length) return null; // semana sem nada registrado: não manda resumo vazio
  const ddmm = (d: DataISO) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const rotulo = `semana passada (${ddmm(inicio)} a ${ddmm(fim)})`;
  const texto = await montarResumo(repo, usuarioId, categorias, { inicio, fim, rotulo }, hoje);
  const agora = totalDespesas(semana);
  const antes = totalDespesas(anterior);
  let comparacao = "";
  if (agora && antes) {
    const diferenca = Math.round(((agora - antes) / antes) * 100);
    comparacao = diferenca === 0
      ? "\n\n↔️ Gastou o mesmo que na semana anterior."
      : `\n\n${diferenca > 0 ? "🔺" : "🔻"} Gastou ${Math.abs(diferenca)}% ${diferenca > 0 ? "a mais" : "a menos"} que na semana anterior (${formatarReais(antes)}).`;
  }
  return { chave: `semana:${inicio}`, texto: `🗓️ Bom dia! Seu resumo:\n\n${texto}${comparacao}` };
}

export interface DependenciasLembretes {
  repo: Repositorio;
  agora: () => Date;
  avisar: (telegramId: string, texto: string) => Promise<void>;
  log: (evento: string, dados?: Record<string, unknown>) => void;
}

export interface Lembretes {
  /** Rodada do dia: monta e envia os avisos de todos os usuários com lembretes ligados. */
  rodar(): Promise<{ usuarios: number; mensagens: number; erros: number }>;
}

export function criarLembretes(deps: DependenciasLembretes): Lembretes {
  const { repo } = deps;

  /** Reserva as chaves ainda não enviadas e manda os textos delas numa mensagem só. */
  async function enviar(usuarioId: string, telegramId: string, avisos: Aviso[]): Promise<boolean> {
    const novos: Aviso[] = [];
    for (const a of avisos) if (await repo.reservarAviso(usuarioId, a.chave)) novos.push(a);
    if (!novos.length) return false;
    try {
      await deps.avisar(telegramId, novos.map((a) => a.texto).join("\n\n"));
      return true;
    } catch (e) {
      for (const a of novos) await repo.liberarAviso(usuarioId, a.chave).catch(() => {});
      throw e;
    }
  }

  return {
    async rodar() {
      const total = { usuarios: 0, mensagens: 0, erros: 0 };
      for (const { usuario, telegramId } of await repo.destinatariosLembretes()) {
        total.usuarios++;
        try {
          const hoje = hojeNoFuso(usuario.fusoHorario, deps.agora());
          const [contas, categorias, faturas] = await Promise.all([
            repo.listarContas(usuario.id),
            repo.listarCategorias(usuario.id),
            repo.faturasAbertas(usuario.id, hoje),
          ]);
          // Contas e faturas numa mensagem; o resumo da semana, que é longo, em outra.
          const urgentes = [...avisosDeFatura(faturas, contas, hoje), ...avisosDeSaldo(contas, hoje)];
          if (await enviar(usuario.id, telegramId, urgentes)) total.mensagens++;
          const semanal = await avisoSemanal(repo, usuario.id, categorias, hoje);
          if (semanal && await enviar(usuario.id, telegramId, [semanal])) total.mensagens++;
        } catch (e) {
          total.erros++;
          deps.log("erro_lembretes", { erro: e instanceof Error ? e.message : String(e) });
        }
      }
      return total;
    },
  };
}
