/**
 * Limites de upload de documentos KYC / backup (onboarding e admin).
 *
 * Tipos: somente PDF, PNG e JPEG. PDF ≤ 5 MB; imagens ≤ 10 MB (teto que já
 * existia no canal público — mantido para fotos de documento/selfie).
 */

export const MIMES_DOCUMENTO_PERMITIDOS = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;

export type MimeDocumentoPermitido =
  (typeof MIMES_DOCUMENTO_PERMITIDOS)[number];

/** PDF: teto obrigatório de 5 MB. */
export const TAMANHO_MAX_PDF_BYTES = 5 * 1024 * 1024;

/** PNG/JPEG: alinha ao limite histórico do onboarding (10 MB). */
export const TAMANHO_MAX_IMAGEM_BYTES = 10 * 1024 * 1024;

/**
 * Teto do Multer (memoryStorage) — o maior entre PDF e imagem. O limite por
 * tipo é revalidado depois, porque o Multer só aceita um `fileSize` global.
 */
export const TAMANHO_MAX_UPLOAD_BYTES = Math.max(
  TAMANHO_MAX_PDF_BYTES,
  TAMANHO_MAX_IMAGEM_BYTES,
);

export const ACCEPT_DOCUMENTO =
  'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png';

/** Texto curto para UI / mensagens. */
export const TEXTO_LIMITES_DOCUMENTO =
  'PDF (máx. 5 MB) ou PNG/JPEG (máx. 10 MB)';

export function eMimeDocumentoPermitido(
  mime: string | undefined | null,
): mime is MimeDocumentoPermitido {
  return (
    !!mime &&
    (MIMES_DOCUMENTO_PERMITIDOS as readonly string[]).includes(mime)
  );
}

export function tamanhoMaximoParaMime(mime: string): number {
  if (mime === 'application/pdf') return TAMANHO_MAX_PDF_BYTES;
  return TAMANHO_MAX_IMAGEM_BYTES;
}

/**
 * Valida MIME e tamanho. Lança Error com mensagem em português — o controller
 * traduz em BadRequestException.
 */
export function validarArquivoDocumento(arquivo: {
  mimetype?: string;
  size?: number;
  originalname?: string;
}): void {
  const mime = arquivo.mimetype ?? '';
  if (!eMimeDocumentoPermitido(mime)) {
    throw new Error(
      `Tipo de arquivo não permitido${mime ? ` (${mime})` : ''}. Envie apenas PDF, PNG ou JPEG.`,
    );
  }
  const tamanho = arquivo.size ?? 0;
  const teto = tamanhoMaximoParaMime(mime);
  if (tamanho <= 0) {
    throw new Error('Arquivo vazio ou inválido.');
  }
  if (tamanho > teto) {
    const mb = teto / (1024 * 1024);
    if (mime === 'application/pdf') {
      throw new Error(`O PDF deve ter no máximo ${mb} MB.`);
    }
    throw new Error(`A imagem deve ter no máximo ${mb} MB.`);
  }
}
