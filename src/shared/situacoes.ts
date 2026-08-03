/**
 * ENUM GERAL DE SITUAÇÕES DO SISTEMA.
 *
 * Fonte única para todo status usado em código — nunca escrever a string
 * literal ("PENDENTE", "CONCLUIDA", …) direto em controller/service/processor.
 *
 * Os grupos que têm enum no banco (SituacaoUsuario, SituacaoEmpresa, …)
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

/** empresas.situacao — enum SituacaoEmpresa no banco. */
export const SITUACAO_EMPRESA = {
  PENDENTE: 'PENDENTE',
  EM_ANALISE: 'EM_ANALISE',
  ATIVA: 'ATIVA',
  REPROVADA: 'REPROVADA',
  SUSPENSA: 'SUSPENSA',
  BLOQUEADA: 'BLOQUEADA',
  ENCERRADA: 'ENCERRADA',
} as const;
export type SituacaoEmpresaValor =
  (typeof SITUACAO_EMPRESA)[keyof typeof SITUACAO_EMPRESA];

/** documentos_*.situacao — enum SituacaoDocumento no banco. */
export const SITUACAO_DOCUMENTO = {
  PENDENTE: 'PENDENTE',
  VALIDO: 'VALIDO',
  INVALIDO: 'INVALIDO',
  EXPIRADO: 'EXPIRADO',
} as const;

/** analises_cadastro_*.situacao — enum SituacaoAnalise no banco. */
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
  DEVOLVIDA: 'DEVOLVIDA',
} as const;

/** provedores_pagamento.situacao / contas_provedor.situacao — enum SituacaoProvedor. */
export const SITUACAO_PROVEDOR = {
  ATIVO: 'ATIVO',
  INATIVO: 'INATIVO',
  SUSPENSO: 'SUSPENSO',
} as const;

/** chaves_pix_empresas.situacao — enum SituacaoChavePix no banco. */
export const SITUACAO_CHAVE_PIX = {
  PENDENTE: 'PENDENTE',
  APROVADA: 'APROVADA',
  REPROVADA: 'REPROVADA',
  INATIVA: 'INATIVA',
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

/** devolucoes_pix.situacao — VarChar(30); vocabulário oficial. */
export const SITUACAO_DEVOLUCAO = {
  PENDENTE: 'PENDENTE',
  PROCESSANDO: 'PROCESSANDO',
  CONCLUIDA: 'CONCLUIDA',
  FALHA: 'FALHA',
} as const;

/** bloqueios_saldo.situacao — VarChar(30); vocabulário oficial. */
export const SITUACAO_BLOQUEIO = {
  ATIVO: 'ATIVO',
  ENCERRADO: 'ENCERRADO',
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

/** tentativas_transacoes.situacao — VarChar; vocabulário oficial. */
export const SITUACAO_TENTATIVA = {
  SUCESSO: 'SUCESSO',
  FALHA: 'FALHA',
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

/** Eventos de webhook enviados ao lojista (tiposEvento das configs). */
export const EVENTOS_LOJISTA = {
  PIX_CASHIN_PAGO: 'pix.cashin.pago',
  PIX_CASHOUT_CONCLUIDO: 'pix.cashout.concluido',
  PIX_CASHOUT_FALHOU: 'pix.cashout.falhou',
  PIX_DEVOLUCAO_CONCLUIDA: 'pix.devolucao.concluida',
} as const;
