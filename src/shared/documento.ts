/**
 * CPF e CNPJ — incluindo o CNPJ ALFANUMÉRICO (novo padrão da Receita Federal).
 *
 * CNPJ alfanumérico: 14 posições, sendo as 12 primeiras alfanuméricas (0-9, A-Z)
 * e as 2 últimas (dígitos verificadores) sempre numéricas.
 * CPF: 11 posições, sempre numéricas.
 *
 * Armazenamos SEMPRE normalizado (sem máscara, maiúsculo).
 *
 * Dois níveis de checagem, e o nome diz qual é:
 * - `isCpf` / `isCnpj`: só FORMATO (tamanho e classe de caractere). Servem para
 *   decidir "isto parece um CPF ou um CNPJ?" (máscara, exibição, tipo de chave).
 * - `cpfTemDigitosValidos` / `cnpjTemDigitosValidos` / `documentoValidoPara`:
 *   formato + DÍGITOS VERIFICADORES (módulo 11) + recusa de sequência repetida
 *   (`000.000.000-00`, `111…`). É o que o CADASTRO exige — documento inventado
 *   é a matéria-prima de conta laranja e de cadastro automatizado, e o custo
 *   de barrar aqui é zero para quem digita o próprio documento.
 *
 * ESPELHO: `Gateway-de-Pagamentos-VPay-web/src/lib/documento.ts` — mesma regra e
 * mesmas mensagens, para o painel recusar antes de chamar a API.
 */

export const TAMANHO_CPF = 11;
export const TAMANHO_CNPJ = 14;

/** Remove máscara e normaliza para maiúsculo. */
export function normalizarDocumento(valor: string | null | undefined): string {
  return (valor ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Só formato: 11 dígitos. Para o cadastro, use `cpfTemDigitosValidos`. */
export function isCpf(valor: string): boolean {
  return /^[0-9]{11}$/.test(valor);
}

/**
 * Só formato: aceita o CNPJ numérico clássico e o novo alfanumérico.
 * Para o cadastro, use `cnpjTemDigitosValidos`.
 */
export function isCnpj(valor: string): boolean {
  return /^[0-9A-Z]{12}[0-9]{2}$/.test(valor);
}

/** `true` quando todas as posições são o mesmo caractere (`00000000000`, `AAAAAAAAAAAA00`…). */
function sequenciaRepetida(valor: string): boolean {
  return valor.length > 0 && valor.split('').every((c) => c === valor[0]);
}

/**
 * CPF com dígitos verificadores corretos (módulo 11) e que não seja sequência
 * repetida — `111.111.111-11` passa no módulo 11 e é o exemplo clássico de
 * documento falso.
 */
export function cpfTemDigitosValidos(valor: string): boolean {
  if (!isCpf(valor) || sequenciaRepetida(valor)) return false;
  const dv = (base: string) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      // Pesos decrescentes: 10..2 para o 1º DV (9 dígitos), 11..2 para o 2º (10 dígitos).
      soma += Number(base[i]) * (base.length + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const dv1 = dv(valor.slice(0, 9));
  const dv2 = dv(valor.slice(0, 10));
  return valor.slice(9) === `${dv1}${dv2}`;
}

/**
 * Dígitos verificadores do CNPJ (alfanumérico ou numérico), regra da Receita:
 * cada caractere vale (ASCII − 48) — dígito vale o próprio valor, `A` vale 17 —
 * e os pesos, contados DA DIREITA para a esquerda, vão 2,3,…,9 e recomeçam em 2.
 * `00.000.000/0000-00` fecha o módulo 11 e por isso a sequência repetida é
 * recusada explicitamente.
 */
export function cnpjTemDigitosValidos(valor: string): boolean {
  if (!isCnpj(valor) || sequenciaRepetida(valor)) return false;
  const calcula = (base: string) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      // Posição contada da direita (0 = último caractere) → peso 2..9 cíclico.
      const peso = ((base.length - 1 - i) % 8) + 2;
      soma += (base.charCodeAt(i) - 48) * peso;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const dv1 = calcula(valor.slice(0, 12));
  const dv2 = calcula(valor.slice(0, 12) + String(dv1));
  return valor.slice(12) === `${dv1}${dv2}`;
}

/** CPF ou CNPJ com dígitos verificadores válidos (decidido pelo tamanho). */
export function documentoValido(valor: string): boolean {
  return cpfTemDigitosValidos(valor) || cnpjTemDigitosValidos(valor);
}

/**
 * Documento esperado conforme o tipo de pessoa, COM dígitos verificadores.
 * É a regra do cadastro e da ficha cadastral (cliente e admin).
 */
export function documentoValidoPara(
  tipoPessoa: 'PF' | 'PJ',
  valor: string,
): boolean {
  return tipoPessoa === 'PF'
    ? cpfTemDigitosValidos(valor)
    : cnpjTemDigitosValidos(valor);
}

/**
 * Mensagens únicas para API e painel. Distinguem "formato" de "dígito
 * verificador": quem digitou 11 dígitos e levou "CPF inválido" precisa saber
 * que o problema não é falta de dígito.
 */
export const MENSAGEM_DOCUMENTO = {
  CPF_FORMATO: 'CPF inválido: informe os 11 dígitos.',
  CPF_DV: 'CPF inválido: os dígitos verificadores não conferem. Confira o número digitado.',
  CNPJ_FORMATO:
    'CNPJ inválido: informe as 14 posições (o novo padrão aceita letras nas 12 primeiras).',
  CNPJ_DV: 'CNPJ inválido: os dígitos verificadores não conferem. Confira o número digitado.',
} as const;

/** Motivo da recusa (ou `null` se válido) — para o schema e para a tela dizerem a mesma coisa. */
export function motivoDocumentoInvalido(
  tipoPessoa: 'PF' | 'PJ',
  valor: string,
): string | null {
  const v = normalizarDocumento(valor);
  if (tipoPessoa === 'PF') {
    if (!isCpf(v)) return MENSAGEM_DOCUMENTO.CPF_FORMATO;
    return cpfTemDigitosValidos(v) ? null : MENSAGEM_DOCUMENTO.CPF_DV;
  }
  if (!isCnpj(v)) return MENSAGEM_DOCUMENTO.CNPJ_FORMATO;
  return cnpjTemDigitosValidos(v) ? null : MENSAGEM_DOCUMENTO.CNPJ_DV;
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
