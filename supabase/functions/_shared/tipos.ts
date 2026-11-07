// Tipos de domínio. Nenhum import externo aqui: o núcleo do sistema
// não depende de Supabase, WhatsApp nem do modelo de IA — só destas interfaces.

export type TipoConta =
  | "corrente"
  | "poupanca"
  | "cartao_credito"
  | "dinheiro"
  | "vale"
  | "investimento"
  | "outro";

export type TipoLancamento = "despesa" | "receita";

/** Data no formato YYYY-MM-DD (sem fuso: é um dia do calendário). */
export type DataISO = string;

export interface Usuario {
  id: string;
  nome: string;
  whatsapp: string;
  fusoHorario: string;
}

export interface Conta {
  id: string;
  nome: string;
  tipo: TipoConta;
  apelidos: string[];
  diaFechamento: number | null;
  diaVencimento: number | null;
}

export interface Categoria {
  id: string;
  nome: string;
  tipo: TipoLancamento;
}

export interface NovaTransacao {
  usuarioId: string;
  contaId: string | null;
  categoriaId: string | null;
  mensagemId: string;
  tipo: TipoLancamento;
  descricao: string;
  estabelecimento: string | null;
  valorCentavos: number;
  dataTransacao: DataISO;
  dataPagamento: DataISO | null;
  parcelaNumero: number | null;
  parcelaTotal: number | null;
  grupoParcelamento: string | null;
}

export interface Transacao extends NovaTransacao {
  id: string;
}

export type CamposCorrecao = Partial<
  Pick<
    NovaTransacao,
    "contaId" | "categoriaId" | "descricao" | "valorCentavos" | "dataTransacao" | "dataPagamento"
  >
>;

export interface LinhaResumo {
  tipo: TipoLancamento;
  categoria: string;
  totalCentavos: number;
  quantidade: number;
}

/** Acesso a dados. A implementação real usa Supabase; os testes usam memória. */
export interface Repositorio {
  buscarUsuarioPorWhatsapp(numero: string): Promise<Usuario | null>;
  /** Retorna o id da mensagem, ou null se esse wamid já foi recebido (reenvio da Meta). */
  registrarMensagem(m: {
    usuarioId: string;
    wamid: string;
    tipo: string;
    texto: string | null;
  }): Promise<string | null>;
  finalizarMensagem(
    id: string,
    dados: {
      status: "processada" | "ignorada" | "erro";
      interpretacao?: unknown;
      resposta?: string;
      erro?: string;
    },
  ): Promise<void>;
  listarContas(usuarioId: string): Promise<Conta[]>;
  listarCategorias(usuarioId: string): Promise<Categoria[]>;
  inserirTransacoes(t: NovaTransacao[]): Promise<Transacao[]>;
  /** Transações ativas geradas pela mensagem mais recente que gerou alguma. */
  transacoesDaUltimaMensagem(usuarioId: string): Promise<Transacao[]>;
  cancelarTransacoes(ids: string[]): Promise<void>;
  atualizarTransacao(id: string, campos: CamposCorrecao): Promise<void>;
  resumoPorCategoria(usuarioId: string, inicio: DataISO, fim: DataISO): Promise<LinhaResumo[]>;
}

// ---------- Saída do interpretador (modelo de IA) ----------

export type Intencao =
  | "registrar"
  | "resumo"
  | "desfazer"
  | "corrigir"
  | "ajuda"
  | "esclarecer"
  | "fora_do_escopo";

export type Periodo = "hoje" | "ontem" | "semana" | "mes_atual" | "mes_anterior";

export interface PedidoResumo {
  /** "intervalo" = datas livres em `inicio`/`fim` (ex.: "quanto gastei em setembro?"). */
  periodo: Periodo | "intervalo";
  inicio: DataISO | null;
  fim: DataISO | null;
  categoria: string | null;
}

export interface LancamentoInterpretado {
  tipo: TipoLancamento;
  descricao: string;
  estabelecimento: string | null;
  /** Valor como texto decimal com ponto, ex.: "47.90". Convertido para centavos no código. */
  valor: string;
  /** Se `valor` é o total da compra ou o valor de cada parcela. */
  valor_refere_se_a: "total" | "parcela";
  parcelas: number | null;
  data: DataISO;
  conta: string | null;
  categoria: string;
}

export interface Interpretacao {
  intencao: Intencao;
  lancamentos: LancamentoInterpretado[];
  resumo: PedidoResumo | null;
  correcao: {
    valor: string | null;
    data: DataISO | null;
    conta: string | null;
    categoria: string | null;
    descricao: string | null;
  } | null;
  /** Pergunta curta quando faltou informação (intenção "esclarecer"). */
  pergunta: string | null;
}

export interface ContextoInterpretacao {
  texto: string;
  hoje: DataISO;
  diaDaSemana: string;
  contas: Conta[];
  categorias: Categoria[];
}

export interface Interpretador {
  interpretar(ctx: ContextoInterpretacao): Promise<Interpretacao>;
}

// ---------- WhatsApp ----------

export interface MensagemRecebida {
  wamid: string;
  /** wa_id do remetente, como veio da Meta. Use este valor para responder. */
  de: string;
  nomePerfil: string | null;
  tipo: string;
  texto: string | null;
  phoneNumberId: string;
}

export interface EnviadorWhatsApp {
  enviarTexto(p: {
    phoneNumberId: string;
    para: string;
    texto: string;
    responderA?: string;
  }): Promise<void>;
}
