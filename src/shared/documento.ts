/**
 * CPF e CNPJ — incluindo o CNPJ ALFANUMÉRICO (novo padrão da Receita Federal).
 *
 * CNPJ alfanumérico: 14 posições, sendo as 12 primeiras alfanuméricas (0-9, A-Z)
 * e as 2 últimas (dígitos verificadores) sempre numéricas.
 * CPF: 11 posições, sempre numéricas.
 *
 * Armazenamos SEMPRE normalizado (sem máscara, maiúsculo).
 */

export const TAMANHO_CPF = 11;
export const TAMANHO_CNPJ = 14;

/** Remove máscara e normaliza para maiúsculo. */
export function normalizarDocumento(valor: string | null | undefined): string {
  return (valor ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function isCpf(valor: string): boolean {
  return /^[0-9]{11}$/.test(valor);
}

/** Aceita o CNPJ numérico clássico e o novo alfanumérico. */
export function isCnpj(valor: string): boolean {
  return /^[0-9A-Z]{12}[0-9]{2}$/.test(valor);
}

/** Documento esperado conforme o tipo de pessoa. */
export function documentoValidoPara(
  tipoPessoa: 'PF' | 'PJ',
  valor: string,
): boolean {
  return tipoPessoa === 'PF' ? isCpf(valor) : isCnpj(valor);
}

/**
 * Dígitos verificadores do CNPJ (alfanumérico ou numérico).
 * Regra da Receita: cada caractere vale (ASCII - 48); DVs por módulo 11.
 * Exposto para uso opcional — o cadastro valida formato; ativar a checagem de
 * DV é uma decisão de negócio (bloqueia documentos de teste).
 */
export function cnpjTemDigitosValidos(valor: string): boolean {
  if (!isCnpj(valor)) return false;
  const peso = (pos: number, tam: number) => ((tam - pos) % 8) + 2;
  const calcula = (base: string) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += (base.charCodeAt(i) - 48) * peso(i, base.length);
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const dv1 = calcula(valor.slice(0, 12));
  const dv2 = calcula(valor.slice(0, 12) + String(dv1));
  return valor.slice(12) === `${dv1}${dv2}`;
}

/** Formata para exibição: CPF 000.000.000-00 | CNPJ 00.000.000/0000-00. */
export function formatarDocumento(valor: string): string {
  const v = normalizarDocumento(valor);
  if (isCpf(v)) {
    return `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9)}`;
  }
  if (v.length === TAMANHO_CNPJ) {
    return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`;
  }
  return v;
}
