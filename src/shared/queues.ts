/** Nomes EXATOS das filas BullMQ genéricas — usar em registerQueue / InjectQueue / Processor / Bull Board */
export const QUEUE_NAMES = {
  PIX_WEBHOOK_RECEIVED: '1-pix-webhook-received',
  PIX_WEBHOOK_SEND: '2-pix-webhook-send',
  PIX_WEBHOOK_RECEIVED_CASHOUT: '3-pix-webhook-received-cashout',
  PIX_CASH_OUT: '4-pix-cash-out',
  OUTBOX_PUBLISHER: '5-outbox-publisher',
  LIBERACAO_SALDO: '6-liberacao-saldo',
  CONCILIACAO: '7-conciliacao',
  /** E-mails transacionais (retentável: SMTP cai e não pode derrubar a request). */
  EMAILS: '8-emails',
  /** Devoluções PIX (MED aceito): envio à liquidante com retentativas. */
  DEVOLUCAO_PIX: '9-devolucao-pix',
  /** Saque automático do saldo parado na adquirente (gatilhos de tesouraria). */
  SAQUE_AUTOMATICO: '10-saque-automatico',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES);

/** Payload mínimo dos jobs PIX */
export type PixJobPayload = {
  provider: string;
  contaProvedorId?: string;
  payload: unknown;
  webhookRecebidoId?: string;
  identificadorRastreio: string;
};

export type OutboxPublishJobPayload = {
  eventoOutboxId: string;
  identificadorRastreio: string;
};

export type LiberacaoSaldoJobPayload = {
  liberacaoId?: string;
  identificadorRastreio: string;
};

export type ConciliacaoJobPayload = {
  provider?: string;
  identificadorRastreio: string;
};

export type DevolucaoPixJobPayload = {
  devolucaoId: string;
  identificadorRastreio: string;
};

/**
 * Sem `execucaoId` o job é o tick periódico: atualiza saldos, reconcilia
 * execuções enviadas e avalia os gatilhos. Com `execucaoId` processa só aquele
 * disparo (botão "Executar agora" do admin).
 */
export type SaqueAutomaticoJobPayload = {
  execucaoId?: string;
  identificadorRastreio: string;
};

/** Tipos de e-mail transacional. O conteúdo é montado no worker. */
export const TIPOS_EMAIL = {
  CADASTRO_RECEBIDO: 'CADASTRO_RECEBIDO',
  DOCUMENTACAO_EM_ANALISE: 'DOCUMENTACAO_EM_ANALISE',
  CONTA_APROVADA: 'CONTA_APROVADA',
  CONTA_REPROVADA: 'CONTA_REPROVADA',
  DOCUMENTO_INVALIDADO: 'DOCUMENTO_INVALIDADO',
  REDEFINIR_SENHA: 'REDEFINIR_SENHA',
  SENHA_ALTERADA: 'SENHA_ALTERADA',
  TOTP_HABILITADO: 'TOTP_HABILITADO',
  TOTP_DESABILITADO: 'TOTP_DESABILITADO',
  CHAVE_PIX_APROVADA: 'CHAVE_PIX_APROVADA',
  CHAVE_PIX_REPROVADA: 'CHAVE_PIX_REPROVADA',
  MED_RECEBIDO: 'MED_RECEBIDO',
  MED_ACEITO: 'MED_ACEITO',
  MED_RECUSADO: 'MED_RECUSADO',
} as const;

export type TipoEmail = (typeof TIPOS_EMAIL)[keyof typeof TIPOS_EMAIL];

export type EmailJobPayload = {
  tipo: TipoEmail;
  para: string;
  nome?: string;
  /** Variáveis do template (link de reset, motivo da reprovação, etc.). */
  dados?: Record<string, string>;
  identificadorRastreio?: string;
};

export const DEFAULT_WEBHOOK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};
