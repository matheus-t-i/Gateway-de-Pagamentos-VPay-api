/**
 * ENUM GERAL DE SITUAÇÕES DO SISTEMA.
 *
 * Fonte única para todo status usado em código — nunca escrever a string
 * literal ("PENDENTE", "CONCLUIDA", …) direto em controller/service/processor.
 *
 * Os grupos que têm enum no banco (SituacaoUsuario, SituacaoTransacao, …)
 * espelham exatamente os valores do schema.prisma; os demais são colunas
 * VarChar cujo vocabulário oficial é ESTE arquivo.
 */

/** usuarios.situacao — enum SituacaoUsuario no banco. */
export const SITUACAO_USUARIO = {
  PENDENTE: 'PENDENTE',
  EM_ANALISE: 'EM_ANALISE',
  ATIVO: 'ATIVO',
  REPROVADO: 'REPROVADO',
  SUSPENSO: 'SUSPENSO',
  BLOQUEADO: 'BLOQUEADO',
  ENCERRADO: 'ENCERRADO',
} as const;
export type SituacaoUsuarioValor =
  (typeof SITUACAO_USUARIO)[keyof typeof SITUACAO_USUARIO];

/** documentos_usuarios.situacao — enum SituacaoDocumento no banco. */
export const SITUACAO_DOCUMENTO = {
  PENDENTE: 'PENDENTE',
  VALIDO: 'VALIDO',
  INVALIDO: 'INVALIDO',
  EXPIRADO: 'EXPIRADO',
} as const;

/** analises_cadastro_usuarios.situacao — enum SituacaoAnalise no banco. */
export const SITUACAO_ANALISE = {
  PENDENTE: 'PENDENTE',
  EM_ANALISE: 'EM_ANALISE',
  APROVADA: 'APROVADA',
  REPROVADA: 'REPROVADA',
} as const;

/** transacoes.situacao — enum SituacaoTransacao no banco. */
export const SITUACAO_TRANSACAO = {
  PENDENTE: 'PENDENTE',
  PROCESSANDO: 'PROCESSANDO',
  AGUARDANDO_PAGAMENTO: 'AGUARDANDO_PAGAMENTO',
  LIQUIDADA: 'LIQUIDADA',
  CONCLUIDA: 'CONCLUIDA',
  FALHA: 'FALHA',
  CANCELADA: 'CANCELADA',
  /**
   * Venda devolvida ao pagador por contestação (Mecanismo Especial de
   * Devolução). O nome é o termo de mercado do chargeback PIX e é exatamente o
   * que sai no callback ao lojista — situação interna e status público são o
   * mesmo valor, sem tradução.
   */
  MED: 'MED',
} as const;

/** provedores_pagamento.situacao / contas_provedor.situacao — enum SituacaoProvedor. */
export const SITUACAO_PROVEDOR = {
  ATIVO: 'ATIVO',
  INATIVO: 'INATIVO',
  SUSPENSO: 'SUSPENSO',
} as const;

/** chaves_pix_usuarios.situacao — enum SituacaoChavePix no banco. */
export const SITUACAO_CHAVE_PIX = {
  PENDENTE: 'PENDENTE',
  APROVADA: 'APROVADA',
  /** O analista recusou a chave ainda na análise. */
  REPROVADA: 'REPROVADA',
  /** Estava APROVADA e o admin cortou o acesso (com justificativa). */
  REVOGADA: 'REVOGADA',
  /** O próprio cliente removeu a chave do painel dele. */
  INATIVA: 'INATIVA',
} as const;

/**
 * Situações a partir das quais o cliente pode RECADASTRAR a mesma chave: já
 * saíram de circulação, então uma nova solicitação é legítima e volta para a
 * fila do analista (reutilizando a linha, ver `ChavePixUsuario`).
 */
export const SITUACOES_CHAVE_PIX_RECADASTRAVEIS: string[] = [
  SITUACAO_CHAVE_PIX.REPROVADA,
  SITUACAO_CHAVE_PIX.REVOGADA,
  SITUACAO_CHAVE_PIX.INATIVA,
];

/** Quem originou a mudança de situação de uma chave (historicos_chave_pix). */
export const ORIGEM_HISTORICO_CHAVE_PIX = {
  CLIENTE: 'CLIENTE',
  ADMIN: 'ADMIN',
} as const;

/** casos_med.situacao — VarChar(40); vocabulário oficial. */
export const SITUACAO_CASO_MED = {
  RECEBIDO: 'RECEBIDO',
  SALDO_BLOQUEADO: 'SALDO_BLOQUEADO',
  DEBITADO: 'DEBITADO',
  EM_ANALISE: 'EM_ANALISE',
  ACEITO: 'ACEITO',
  RECUSADO: 'RECUSADO',
} as const;
export type SituacaoCasoMedValor =
  (typeof SITUACAO_CASO_MED)[keyof typeof SITUACAO_CASO_MED];

/**
 * devolucoes_pix.situacao — VarChar(30); vocabulário oficial.
 *
 * Mesma doutrina de desfechos do saque (`PixCashOutProcessor`):
 * - `PENDENTE`: ainda não saiu nada — retentável; a varredura da conciliação
 *   reenfileira PENDENTE preso (é o ÚNICO estado que ela reenfileira).
 * - `PROCESSANDO`: claim feito, POST pode estar em voo. Parado aqui = worker
 *   morto no meio; NÃO é retentável automático (o refund da Valorion não tem
 *   chave de idempotência — reenviar pode devolver DUAS vezes).
 * - `FALHA`: recusa explícita da liquidante ou teto de tentativas — decisão
 *   humana; visível em /admin/dinheiro-parado.
 * - `AMBIGUA`: timeout/5xx DEPOIS do POST — o refund pode ter saído. Congelada
 *   para conferência manual, como o saque ENVIANDO.
 */
export const SITUACAO_DEVOLUCAO = {
  PENDENTE: 'PENDENTE',
  PROCESSANDO: 'PROCESSANDO',
  CONCLUIDA: 'CONCLUIDA',
  FALHA: 'FALHA',
  AMBIGUA: 'AMBIGUA',
} as const;

/** bloqueios_saldo.situacao — VarChar(30); vocabulário oficial. */
export const SITUACAO_BLOQUEIO = {
  ATIVO: 'ATIVO',
  /** Encerramento genérico (fluxo MED: a decisão do caso é quem resolve o dinheiro). */
  ENCERRADO: 'ENCERRADO',
  /** Bloqueio manual desfeito — o valor voltou ao disponível do cliente. */
  LIBERADO: 'LIBERADO',
  /** Bloqueio manual debitado — o valor saiu da carteira do cliente. */
  DEBITADO: 'DEBITADO',
} as const;

/** bloqueios_saldo.tipo — VarChar(30); vocabulário oficial. */
export const TIPO_BLOQUEIO = {
  MED: 'MED',
  /** Bloqueio administrativo decidido pelo admin (calote/inadimplência). */
  MANUAL: 'MANUAL',
} as const;

/** webhooks_recebidos_provedor.situacao — VarChar(30); vocabulário oficial. */
export const SITUACAO_WEBHOOK_RECEBIDO = {
  RECEBIDO: 'RECEBIDO',
  PROCESSADO: 'PROCESSADO',
  ERRO: 'ERRO',
} as const;

/** entregas_webhook.situacao — VarChar; vocabulário oficial. */
export const SITUACAO_ENTREGA_WEBHOOK = {
  SUCESSO: 'SUCESSO',
  FALHA: 'FALHA',
} as const;

/**
 * envios_integracao.situacao — VarChar(20); vocabulário oficial.
 *
 * Tem `PENDENTE` (que a entrega de webhook não tem) porque a linha nasce ANTES
 * do POST: é ela que faz o dedupe pela unique `(integracao, transacao, status)`.
 */
export const SITUACAO_ENVIO_INTEGRACAO = {
  PENDENTE: 'PENDENTE',
  SUCESSO: 'SUCESSO',
  FALHA: 'FALHA',
} as const;
export type SituacaoEnvioIntegracaoValor =
  (typeof SITUACAO_ENVIO_INTEGRACAO)[keyof typeof SITUACAO_ENVIO_INTEGRACAO];

/**
 * tentativas_transacoes.situacao — VarChar; vocabulário oficial.
 *
 * `ENVIANDO` é a trava anti-pagamento-duplo do saque: a linha nasce ANTES do
 * POST à liquidante. Se a resposta nunca chega (timeout, 5xx, worker morto), a
 * tentativa fica nesse estado e o reprocessamento encontra "já tem ordem em
 * voo" — sem ela, o retry mandaria um segundo PIX com a liquidante já tendo
 * aceitado o primeiro. Só sai daqui para SUCESSO ou FALHA, com resposta na mão.
 */
export const SITUACAO_TENTATIVA = {
  ENVIANDO: 'ENVIANDO',
  SUCESSO: 'SUCESSO',
  FALHA: 'FALHA',
} as const;

/**
 * falhas_adquirente.tipo — VarChar(30). O que fez a adquirente ser considerada
 * indisponível e acionar a contingência.
 */
export const TIPO_FALHA_ADQUIRENTE = {
  /** Estourou `CONTINGENCIA_TIMEOUT_SEGUNDOS` sem responder. */
  TIMEOUT: 'TIMEOUT',
  /** Respondeu erro HTTP ou o client do provedor lançou exceção. */
  ERRO_PROVEDOR: 'ERRO_PROVEDOR',
  /** Respondeu 200 mas sem código PIX — inútil para o pagador. */
  SEM_CODIGO_PIX: 'SEM_CODIGO_PIX',
} as const;

/** execucoes_gatilho_saque.situacao — VarChar(30); vocabulário oficial. */
export const SITUACAO_EXECUCAO_SAQUE = {
  PENDENTE: 'PENDENTE',
  ENVIADA: 'ENVIADA',
  CONCLUIDA: 'CONCLUIDA',
  FALHA: 'FALHA',
} as const;
export type SituacaoExecucaoSaqueValor =
  (typeof SITUACAO_EXECUCAO_SAQUE)[keyof typeof SITUACAO_EXECUCAO_SAQUE];

/** execucoes_gatilho_saque.origem — VarChar(20); vocabulário oficial. */
export const ORIGEM_EXECUCAO_SAQUE = {
  AUTOMATICO: 'AUTOMATICO',
  MANUAL: 'MANUAL',
} as const;

/** liberacoes_saldo.situacao — enum SituacaoLiberacao no banco. */
export const SITUACAO_LIBERACAO = {
  AGENDADA: 'AGENDADA',
  PROCESSANDO: 'PROCESSANDO',
  LIBERADA: 'LIBERADA',
  CANCELADA: 'CANCELADA',
  BLOQUEADA_MED: 'BLOQUEADA_MED',
  FALHA: 'FALHA',
} as const;

/**
 * provedores_pagamento.disponibilidade_pix_entrada — enum
 * DisponibilidadeAdquirente no banco. Define quem vê a adquirente na vitrine do
 * painel do cliente.
 */
export const DISPONIBILIDADE_ADQUIRENTE = {
  TODOS: 'TODOS',
  ESPECIFICOS: 'ESPECIFICOS',
} as const;
export type DisponibilidadeAdquirenteValor =
  (typeof DISPONIBILIDADE_ADQUIRENTE)[keyof typeof DISPONIBILIDADE_ADQUIRENTE];

/**
 * configuracoes_pix_usuarios.modo_tratamento_med — enum ModoTratamentoMed.
 *
 * MED sempre desconta saldo: `BLOQUEAR_SALDO` move disponível→bloqueado e manda
 * o caso para a fila de `/admin/med`; `DEBITAR_IMEDIATAMENTE` tira o valor na
 * hora e ENCERRA o caso — não há análise, e por isso não existe saldo bloqueado
 * por MED nessa conta. Não existe modo que só sinalize sem tocar no dinheiro.
 */
export const MODO_TRATAMENTO_MED = {
  BLOQUEAR_SALDO: 'BLOQUEAR_SALDO',
  DEBITAR_IMEDIATAMENTE: 'DEBITAR_IMEDIATAMENTE',
} as const;
export type ModoTratamentoMedValor =
  (typeof MODO_TRATAMENTO_MED)[keyof typeof MODO_TRATAMENTO_MED];

/** Modos que deixam o caso MED aguardando decisão do analista. */
export const MODOS_MED_COM_ANALISE: string[] = [
  MODO_TRATAMENTO_MED.BLOQUEAR_SALDO,
];

/** configuracoes_pix_usuarios.base_calculo_reserva — enum BaseCalculoReserva. */
export const BASE_CALCULO_RESERVA = {
  VALOR_BRUTO: 'VALOR_BRUTO',
  VALOR_LIQUIDO_EMPRESA: 'VALOR_LIQUIDO_EMPRESA',
} as const;
export type BaseCalculoReservaValor =
  (typeof BASE_CALCULO_RESERVA)[keyof typeof BASE_CALCULO_RESERVA];

/** Eventos de webhook enviados ao lojista (tiposEvento das configs). */
export const EVENTOS_LOJISTA = {
  PIX_CASHIN_PAGO: 'pix.cashin.pago',
  PIX_CASHOUT_CONCLUIDO: 'pix.cashout.concluido',
  PIX_CASHOUT_FALHOU: 'pix.cashout.falhou',
  PIX_DEVOLUCAO_CONCLUIDA: 'pix.devolucao.concluida',
} as const;
