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
  /**
   * Reenvio MANUAL de callback ao lojista (botão do painel/admin). Fila
   * separada de propósito: a `2-pix-webhook-send` é o fluxo automático e não
   * pode ter a fila poluída — nem o alerta de backlog distorcido — por
   * reprocessamento sob demanda. Aqui também não existe claim de outbox: o
   * evento já foi publicado, o que se repete é só a ENTREGA.
   */
  WEBHOOK_REENVIO: '11-webhook-reenvio',
  /**
   * Envio de pedido aos APPS que o lojista conectou (`/desenvolvedores/integracoes`).
   * Fila própria porque é integração de TERCEIRO: a Utmify fora do ar não pode
   * atrasar o callback do lojista, que é o que libera o pedido dele.
   */
  INTEGRACAO_ENVIO: '12-integracao-envio',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES = Object.values(QUEUE_NAMES);

/**
 * Nome no Bull Board. O dashboard ordena por `localeCompare` no displayName
 * (texto: "1", "10", "11", "2"…). Prefixo com 2 dígitos faz 1→12 aparecer
 * na ordem que o número foi criado. O nome da fila no Redis NÃO muda.
 */
export function nomeExibicaoFila(name: string): string {
  const m = /^(\d+)-(.*)$/.exec(name);
  if (!m) return name;
  return `${m[1].padStart(2, '0')}-${m[2]}`;
}

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
 * Reenvio manual do callback de uma transação. `eventoOutboxId` é resolvido no
 * endpoint (último evento da transação) para o job não depender de a transação
 * ainda existir com o mesmo estado quando for processado.
 */
export type WebhookReenvioJobPayload = {
  eventoOutboxId: string;
  idTransacaoPublico: string;
  /** Quem apertou o botão — vai para o log do worker. */
  solicitadoPorUsuarioId?: string;
  identificadorRastreio: string;
};

/**
 * Um envio para um app conectado. O job carrega só o id da linha de
 * `envios_integracao` — o payload é montado no worker, a partir do estado ATUAL
 * da transação, para um reprocessamento não mandar dado velho ao app.
 */
export type IntegracaoEnvioJobPayload = {
  envioId: string;
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
  /** Chave que estava aprovada e o admin tirou de circulação. */
  CHAVE_PIX_REVOGADA: 'CHAVE_PIX_REVOGADA',
  MED_RECEBIDO: 'MED_RECEBIDO',
  MED_ACEITO: 'MED_ACEITO',
  MED_RECUSADO: 'MED_RECUSADO',
  CONTA_ENCERRADA: 'CONTA_ENCERRADA',
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

/**
 * Opções padrão das filas. `backoff.delay` NÃO é atraso na criação do job —
 * só entra depois de uma falha (2s, 4s, 8s, 16s). A 1ª execução é imediata.
 *
 * Cash-in (criação da cobrança e recebimento do webhook) não pode esperar:
 * `delay: 0` explícito nas filas de webhook in/out. Recusa 4xx da liquidante
 * vira `UnrecoverableError` no processor — retry exponencial num 404
 * determinístico só empurrava o job ~20s sem mudar o resultado.
 */
export const DEFAULT_WEBHOOK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
  delay: 0,
};
