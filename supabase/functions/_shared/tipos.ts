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

/** O que fica gravado: além de despesa e receita, a fatura de cartão (a pagar ou paga). */
export type TipoTransacao = TipoLancamento | "pagamento_fatura";

/** Data no formato YYYY-MM-DD (sem fuso: é um dia do calendário). */
export type DataISO = string;

export interface Usuario {
  id: string;
  nome: string;
  whatsapp: string | null;
  fusoHorario: string;
}

export interface Conta {
  id: string;
  nome: string;
  tipo: TipoConta;
  apelidos: string[];
  diaFechamento: number | null;
  diaVencimento: number | null;
  /** Banco da conta ("Nubank", "Itaú"); serve para achar o cartão e a conta do mesmo banco. */
  instituicao?: string | null;
  /** Saldo (conta) ou valor usado (cartão), quando vem do banco. */
  saldoCentavos?: number | null;
  limiteCentavos?: number | null;
  saldoAtualizadoEm?: string | null;
}

export interface NovaConta {
  nome: string;
  tipo: TipoConta;
  instituicao: string | null;
  apelidos: string[];
}

export interface Categoria {
  id: string;
  nome: string;
  tipo: TipoLancamento;
}

export interface NovaTransacao {
  usuarioId: string;
  /** Canal por onde o lançamento chegou. */
  origem: Canal;
  contaId: string | null;
  categoriaId: string | null;
  mensagemId: string;
  tipo: TipoTransacao;
  /** Padrão "informado"; "confirmado" quando você mesmo diz que já aconteceu (ex.: "paguei a fatura"). */
  status?: "informado" | "confirmado";
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

export interface LinhaResumoConta {
  contaId: string | null;
  /** Null = lançamento sem conta. */
  conta: string | null;
  tipoConta: TipoConta | null;
  tipo: TipoLancamento;
  totalCentavos: number;
  quantidade: number;
}

export interface LinhaFatura {
  contaId: string;
  conta: string;
  vencimento: DataISO | null;
  totalCentavos: number;
  /** true = você informou o valor; false = soma das compras do cartão. */
  informada: boolean;
}

/** Acesso a dados. A implementação real usa Supabase; os testes usam memória. */
export interface Repositorio {
  buscarUsuarioPorWhatsapp(numero: string): Promise<Usuario | null>;
  buscarUsuarioPorTelegram(telegramId: string): Promise<Usuario | null>;
  /** Liga o Telegram ao usuário dono do código de vínculo (uso único). Null se o código não existe. */
  vincularTelegram(codigo: string, telegramId: string): Promise<Usuario | null>;
  /** Retorna o id da mensagem, ou null se ela já foi recebida (reenvio do canal). */
  registrarMensagem(m: {
    usuarioId: string;
    canal: Canal;
    idExterno: string;
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
  criarConta(usuarioId: string, dados: NovaConta): Promise<Conta>;
  atualizarDiasCartao(contaId: string, diaFechamento: number, diaVencimento: number): Promise<void>;
  /** Faturas que você informou e que ainda não foram pagas, de um cartão. */
  faturasInformadas(usuarioId: string, contaId: string): Promise<Transacao[]>;
  /** Lançamentos ativos da conta que ainda não têm data de pagamento (cartão sem fechamento/vencimento). */
  semDataDePagamento(usuarioId: string, contaId: string): Promise<Transacao[]>;
  listarCategorias(usuarioId: string): Promise<Categoria[]>;
  inserirTransacoes(t: NovaTransacao[]): Promise<Transacao[]>;
  /** Transações ativas geradas pela mensagem mais recente que gerou alguma. */
  transacoesDaUltimaMensagem(usuarioId: string): Promise<Transacao[]>;
  cancelarTransacoes(ids: string[]): Promise<void>;
  confirmarTransacoes(ids: string[]): Promise<void>;
  atualizarTransacao(id: string, campos: CamposCorrecao): Promise<void>;
  resumoPorCategoria(usuarioId: string, inicio: DataISO, fim: DataISO, contaId?: string): Promise<LinhaResumo[]>;
  resumoPorConta(usuarioId: string, inicio: DataISO, fim: DataISO): Promise<LinhaResumoConta[]>;
  faturasAbertas(usuarioId: string, hoje: DataISO): Promise<LinhaFatura[]>;
}

// ---------- Saída do interpretador (modelo de IA) ----------

export type Intencao =
  | "registrar"
  | "resumo"
  | "desfazer"
  | "corrigir"
  | "ajuda"
  | "fatura"
  | "configurar_cartao"
  | "ultimo"
  | "contas"
  | "esclarecer"
  | "fora_do_escopo";

export type Periodo = "hoje" | "ontem" | "semana" | "mes_atual" | "mes_anterior";

export interface PedidoResumo {
  /** "intervalo" = datas livres em `inicio`/`fim` (ex.: "quanto gastei em setembro?"). */
  periodo: Periodo | "intervalo";
  inicio: DataISO | null;
  fim: DataISO | null;
  categoria: string | null;
  /** Só os lançamentos desta conta ("quanto gastei no nubank?"). */
  conta?: string | null;
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
  /** Pista de como pagou: "credito" (cartão, parcelado) ou "debito" (débito, Pix). Ajuda a escolher a conta. */
  meio?: Meio | null;
}

export type Meio = "credito" | "debito";

export interface PedidoFatura {
  conta: string | null;
  /** Null quando a mensagem só informa o vencimento ("fatura nubank vence dia 15"). */
  valor: string | null;
  vencimento: DataISO | null;
  /** "paguei a fatura...": já foi paga. */
  paga: boolean;
}

export interface PedidoCartao {
  conta: string | null;
  diaFechamento: number;
  diaVencimento: number;
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
    meio?: Meio | null;
  } | null;
  fatura?: PedidoFatura | null;
  cartao?: PedidoCartao | null;
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

// ---------- Canais de mensagem ----------

export type Canal = "whatsapp" | "telegram";

interface MensagemBase {
  /** Id único da mensagem no canal; garante que um reenvio não duplique lançamento. */
  idExterno: string;
  /** Quem enviou: wa_id no WhatsApp, id numérico do usuário no Telegram. */
  remetente: string;
  nomePerfil: string | null;
  /** "text" para texto; outros valores (audio, photo...) ainda não são entendidos. */
  tipo: string;
  texto: string | null;
}

export type MensagemRecebida =
  | (MensagemBase & { canal: "whatsapp"; phoneNumberId: string })
  | (MensagemBase & { canal: "telegram"; chatId: number; messageId: number });

/** Sabe responder a uma mensagem no mesmo canal em que ela chegou. */
export interface Mensageiro {
  responder(msg: MensagemRecebida, texto: string): Promise<void>;
}
