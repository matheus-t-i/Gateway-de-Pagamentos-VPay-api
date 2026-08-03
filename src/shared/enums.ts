export const ProviderCode = {
  MOCK: 'mock',
} as const;

export type ProviderCodeValue = (typeof ProviderCode)[keyof typeof ProviderCode];

export const PAPEIS = {
  CLIENTE: 'CLIENTE',
  FUNCIONARIO: 'FUNCIONARIO',
  ADMINISTRADOR: 'ADMINISTRADOR',
  FINANCEIRO: 'FINANCEIRO',
  ANALISTA_MED: 'ANALISTA_MED',
} as const;

export const TEMAS = {
  PADRAO: 'PADRAO',
  CLARO: 'CLARO',
  ESCURO: 'ESCURO',
} as const;

/**
 * Tipos de documento aceitos no onboarding (coluna VarChar(60), sem enum no banco).
 * Centralizado aqui para ser fácil de estender sem migração.
 */
export const TIPOS_DOCUMENTO = {
  RG_CNH_FRENTE: 'RG_CNH_FRENTE',
  RG_CNH_VERSO: 'RG_CNH_VERSO',
  SELFIE_COM_DOCUMENTO: 'SELFIE_COM_DOCUMENTO',
  CONTRATO_SOCIAL: 'CONTRATO_SOCIAL',
  CARTAO_CNPJ: 'CARTAO_CNPJ',
  COMPROVANTE_ENDERECO_EMPRESA: 'COMPROVANTE_ENDERECO_EMPRESA',
  /** Enviado pela VPay (admin) depois que o cliente assina — nunca exigido do cliente. */
  CONTRATO_PRESTACAO_SERVICO: 'CONTRATO_PRESTACAO_SERVICO',
} as const;

export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[keyof typeof TIPOS_DOCUMENTO];

/**
 * Documentos obrigatórios da PESSOA FÍSICA responsável pela conta.
 * PF: o próprio titular. PJ: o responsável informado no cadastro.
 * Exigidos nos dois casos.
 */
export const DOCUMENTOS_OBRIGATORIOS_USUARIO: TipoDocumento[] = [
  TIPOS_DOCUMENTO.RG_CNH_FRENTE,
  TIPOS_DOCUMENTO.RG_CNH_VERSO,
  TIPOS_DOCUMENTO.SELFIE_COM_DOCUMENTO,
];

/** Documentos da empresa — exigidos SOMENTE de PJ. */
export const DOCUMENTOS_OBRIGATORIOS_EMPRESA_PJ: TipoDocumento[] = [
  TIPOS_DOCUMENTO.CONTRATO_SOCIAL,
  TIPOS_DOCUMENTO.CARTAO_CNPJ,
  TIPOS_DOCUMENTO.COMPROVANTE_ENDERECO_EMPRESA,
];

/**
 * Para PF a "empresa" é a própria pessoa (mesmos dados), então não há
 * documentação de empresa a exigir — só a documentação pessoal.
 */
export function documentosObrigatoriosEmpresa(
  tipoPessoa: 'PF' | 'PJ',
): TipoDocumento[] {
  return tipoPessoa === 'PJ' ? DOCUMENTOS_OBRIGATORIOS_EMPRESA_PJ : [];
}

/** Situações de conta que emitem JWT no login (única aprovada). */
export const SITUACAO_USUARIO_ATIVO = 'ATIVO';
export const SITUACAO_EMPRESA_ATIVA = 'ATIVA';

/**
 * Documentos legais aceitos eletronicamente no cadastro (assinatura digital
 * com IP/user-agent). Versão única do conjunto — atualizar aqui quando os
 * textos mudarem.
 */
export const DOCUMENTOS_LEGAIS = {
  TERMOS_USO_PRIVACIDADE: 'TERMOS_USO_PRIVACIDADE',
  CONTRATO_INTERMEDIACAO: 'CONTRATO_INTERMEDIACAO',
} as const;

export const VERSAO_DOCUMENTOS_LEGAIS = '2.0.0';
