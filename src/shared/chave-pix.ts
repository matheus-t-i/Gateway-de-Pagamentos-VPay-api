import { isCnpj, isCpf, normalizarDocumento } from './documento';

export const TIPOS_CHAVE_PIX = [
  'CPF',
  'CNPJ',
  'EMAIL',
  'TELEFONE',
  'ALEATORIA',
] as const;

export type TipoChavePix = (typeof TIPOS_CHAVE_PIX)[number];

const UUID_PIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EMAIL_PIX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * DDD + número (10 ou 11 dígitos). Se vier com `+55` / `55` de país, tira —
 * o cadastro NÃO persiste o código do Brasil. DDD 55 (SC) de 10/11 dígitos
 * fica intacto: só corta prefixo quando há 12+ dígitos começando em 55.
 */
export function digitosTelefoneChavePix(valor: string): string {
  let d = (valor ?? '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) {
    d = d.slice(2);
  }
  return d.slice(0, 11);
}

function uuidPix(valor: string): string {
  const hex = (valor ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, 32);
  if (hex.length !== 32) return hex;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Valor GRAVADO da chave: sem máscara, telefone sem +55, e-mail em
 * minúsculas, UUID canônico. É o que o schema persiste e o processor revalida.
 */
export function normalizarChavePixCadastro(
  tipo: string,
  chave: string,
): string {
  const bruto = (chave ?? '').trim();
  switch (tipo) {
    case 'CPF':
      return bruto.replace(/\D/g, '').slice(0, 11);
    case 'CNPJ':
      return normalizarDocumento(bruto).slice(0, 14);
    case 'EMAIL':
      return bruto.toLowerCase();
    case 'TELEFONE':
      return digitosTelefoneChavePix(bruto);
    case 'ALEATORIA':
      return uuidPix(bruto);
    default:
      return bruto;
  }
}

export function chavePixValida(tipo: string, chave: string): boolean {
  switch (tipo) {
    case 'CPF':
      return isCpf(chave);
    case 'CNPJ':
      return isCnpj(chave);
    case 'EMAIL':
      return EMAIL_PIX.test(chave) && chave.length <= 255;
    case 'TELEFONE':
      return chave.length === 10 || chave.length === 11;
    case 'ALEATORIA':
      return UUID_PIX.test(chave);
    default:
      return false;
  }
}

export function mensagemChavePixInvalida(tipo: string): string {
  switch (tipo) {
    case 'CPF':
      return 'Chave CPF deve ter 11 dígitos.';
    case 'CNPJ':
      return 'Chave CNPJ deve ter 14 posições (alfanumérico da Receita é aceito).';
    case 'EMAIL':
      return 'Chave e-mail inválida.';
    case 'TELEFONE':
      return 'Chave telefone deve ser DDD + número (10 ou 11 dígitos), sem +55.';
    case 'ALEATORIA':
      return 'Chave aleatória deve ser um UUID.';
    default:
      return 'Tipo de chave PIX inválido.';
  }
}

/**
 * Chave no formato da liquidante. TELEFONE sai E.164 (`+55` + DDD + número).
 * Idempotente: `+5511999998888` e `11999998888` viram o mesmo destino.
 * Os demais tipos seguem o valor gravado.
 */
export function chavePixParaLiquidante(tipo: string, chave: string): string {
  if (tipo !== 'TELEFONE') return (chave ?? '').trim();
  const dddNumero = digitosTelefoneChavePix(chave);
  return dddNumero.length >= 10 ? `+55${dddNumero}` : (chave ?? '').trim();
}
