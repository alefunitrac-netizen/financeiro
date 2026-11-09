// Implementações em memória para testar o núcleo sem banco, sem canal de mensagem e sem IA.
import type { Dependencias } from "../_shared/processador.ts";
import type {
  CamposCorrecao,
  Canal,
  Categoria,
  Conta,
  ContextoInterpretacao,
  Interpretacao,
  LinhaResumo,
  MensagemRecebida,
  NovaTransacao,
  Repositorio,
  Transacao,
  Usuario,
} from "../_shared/tipos.ts";

export const USUARIO: Usuario = {
  id: "u1",
  nome: "Maria Silva",
  whatsapp: "5511987654321",
  fusoHorario: "America/Sao_Paulo",
};

export const CODIGO_VINCULO = "codigo-secreto-0123456789";

export const CONTAS: Conta[] = [
  { id: "c-nu", nome: "Nubank crédito", tipo: "cartao_credito", apelidos: ["nubank", "roxinho"], diaFechamento: 3, diaVencimento: 10 },
  { id: "c-itau", nome: "Itaú", tipo: "corrente", apelidos: ["itau"], diaFechamento: null, diaVencimento: null },
  { id: "c-din", nome: "Dinheiro", tipo: "dinheiro", apelidos: ["dinheiro", "especie"], diaFechamento: null, diaVencimento: null },
];

export const CATEGORIAS: Categoria[] = [
  { id: "k-alim", nome: "Alimentação", tipo: "despesa" },
  { id: "k-transp", nome: "Transporte", tipo: "despesa" },
  { id: "k-compras", nome: "Compras", tipo: "despesa" },
  { id: "k-mercado", nome: "Mercado", tipo: "despesa" },
  { id: "k-outros", nome: "Outros", tipo: "despesa" },
  { id: "k-sal", nome: "Salário", tipo: "receita" },
  { id: "k-outrasr", nome: "Outras receitas", tipo: "receita" },
];

interface TransacaoMem extends Transacao {
  status: "informado" | "cancelado";
  ordem: number;
}

interface UsuarioMem extends Usuario {
  telegramId: string | null;
  codigoVinculo: string | null;
}

export class RepoMemoria implements Repositorio {
  usuarios: UsuarioMem[] = [{ ...USUARIO, telegramId: null, codigoVinculo: CODIGO_VINCULO }];
  mensagens = new Map<
    string,
    { id: string; canal: Canal; idExterno: string; status?: string; resposta?: string; erro?: string; interpretacao?: unknown }
  >();
  transacoes: TransacaoMem[] = [];
  private seq = 0;

  private publico(u: UsuarioMem | undefined): Usuario | null {
    return u ? { id: u.id, nome: u.nome, whatsapp: u.whatsapp, fusoHorario: u.fusoHorario } : null;
  }
  buscarUsuarioPorWhatsapp(numero: string) {
    return Promise.resolve(this.publico(this.usuarios.find((u) => u.whatsapp === numero)));
  }
  buscarUsuarioPorTelegram(id: string) {
    return Promise.resolve(this.publico(this.usuarios.find((u) => u.telegramId === id)));
  }
  vincularTelegram(codigo: string, id: string) {
    const u = this.usuarios.find((x) => x.codigoVinculo === codigo);
    if (!u || this.usuarios.some((x) => x.telegramId === id && x !== u)) return Promise.resolve(null);
    u.telegramId = id;
    u.codigoVinculo = null;
    return Promise.resolve(this.publico(u));
  }
  registrarMensagem(m: { canal: Canal; idExterno: string }) {
    if ([...this.mensagens.values()].some((x) => x.canal === m.canal && x.idExterno === m.idExterno)) {
      return Promise.resolve(null);
    }
    const id = `m${++this.seq}`;
    this.mensagens.set(id, { id, canal: m.canal, idExterno: m.idExterno });
    return Promise.resolve(id);
  }
  finalizarMensagem(id: string, d: { status: string; resposta?: string; erro?: string; interpretacao?: unknown }) {
    Object.assign(this.mensagens.get(id)!, d);
    return Promise.resolve();
  }
  listarContas() {
    return Promise.resolve(CONTAS);
  }
  listarCategorias() {
    return Promise.resolve(CATEGORIAS);
  }
  inserirTransacoes(ts: NovaTransacao[]) {
    const ordem = ++this.seq;
    const novas = ts.map((t) => ({ ...t, id: `t${++this.seq}`, status: "informado" as const, ordem }));
    this.transacoes.push(...novas);
    return Promise.resolve(novas);
  }
  ativas() {
    return this.transacoes.filter((t) => t.status !== "cancelado");
  }
  transacoesDaUltimaMensagem() {
    const ativas = this.ativas();
    if (ativas.length === 0) return Promise.resolve([]);
    const ultima = ativas.reduce((a, b) => (b.ordem > a.ordem ? b : a));
    return Promise.resolve(ativas.filter((t) => t.mensagemId === ultima.mensagemId));
  }
  cancelarTransacoes(ids: string[]) {
    for (const t of this.transacoes) if (ids.includes(t.id)) t.status = "cancelado";
    return Promise.resolve();
  }
  atualizarTransacao(id: string, campos: CamposCorrecao) {
    Object.assign(this.transacoes.find((t) => t.id === id)!, campos);
    return Promise.resolve();
  }
  resumoPorCategoria(_u: string, inicio: string, fim: string): Promise<LinhaResumo[]> {
    const mapa = new Map<string, LinhaResumo>();
    for (const t of this.ativas()) {
      if (t.dataTransacao < inicio || t.dataTransacao > fim) continue;
      const categoria = CATEGORIAS.find((c) => c.id === t.categoriaId)?.nome ?? "Sem categoria";
      const chave = `${t.tipo}|${categoria}`;
      const l = mapa.get(chave) ?? { tipo: t.tipo, categoria, totalCentavos: 0, quantidade: 0 };
      l.totalCentavos += t.valorCentavos;
      l.quantidade += 1;
      mapa.set(chave, l);
    }
    return Promise.resolve([...mapa.values()].sort((a, b) => b.totalCentavos - a.totalCentavos));
  }
}

export function interpretacao(parcial: Partial<Interpretacao>): Interpretacao {
  return { intencao: "registrar", lancamentos: [], resumo: null, correcao: null, pergunta: null, ...parcial };
}

export function criarDeps(respostasIA: Interpretacao[] = []) {
  const repo = new RepoMemoria();
  const enviadas: { canal: Canal; para: string; texto: string }[] = [];
  const pedidosIA: ContextoInterpretacao[] = [];
  const logs: string[] = [];
  let id = 0;
  const deps: Dependencias = {
    repo,
    interpretador: {
      interpretar(ctx) {
        pedidosIA.push(ctx);
        const r = respostasIA.shift();
        return r ? Promise.resolve(r) : Promise.reject(new Error("IA indisponível"));
      },
    },
    mensageiro: {
      responder(msg, texto) {
        enviadas.push({ canal: msg.canal, para: msg.remetente, texto });
        return Promise.resolve();
      },
    },
    // 07/11/2026 15:00 em São Paulo (18:00 UTC), um sábado
    agora: () => new Date("2026-11-07T18:00:00Z"),
    novoId: () => `g${++id}`,
    log: (evento) => logs.push(evento),
  };
  return { deps, repo, enviadas, pedidosIA, logs };
}

let seqMsg = 0;

/** Mensagem de WhatsApp vinda do número cadastrado (por padrão). */
export function mensagem(texto: string, de = "5511987654321"): MensagemRecebida {
  return {
    canal: "whatsapp",
    idExterno: `wamid.${++seqMsg}`,
    remetente: de,
    nomePerfil: "Maria",
    tipo: "text",
    texto,
    phoneNumberId: "PHONE1",
  };
}

/** Mensagem de Telegram em conversa privada. */
export function mensagemTelegram(texto: string, usuarioId = "777000111"): MensagemRecebida {
  const messageId = ++seqMsg;
  return {
    canal: "telegram",
    idExterno: `${usuarioId}:${messageId}`,
    remetente: usuarioId,
    nomePerfil: "Maria",
    tipo: "text",
    texto,
    chatId: Number(usuarioId),
    messageId,
  };
}
