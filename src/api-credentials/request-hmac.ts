import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { decryptText } from '../common/crypto.util';

/** Janela máxima de skew do timestamp do cliente (anti-replay grosseiro). */
export const HMAC_SKEW_MS = 5 * 60 * 1000;

export const HEADER_VPAY_TIMESTAMP = 'x-vpay-timestamp';
export const HEADER_VPAY_NONCE = 'x-vpay-nonce';
export const HEADER_VPAY_SIGNATURE = 'x-vpay-signature';

/**
 * Material assinado:
 *   METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(body)
 *
 * PATH sem query string. Body vazio → hash de string vazia.
 */
export function montarPayloadHmac(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyRaw: string | Buffer;
}): string {
  const bodyHash = createHash('sha256')
    .update(params.bodyRaw ?? '')
    .digest('hex');
  return [
    params.method.toUpperCase(),
    params.path,
    params.timestamp,
    params.nonce,
    bodyHash,
  ].join('\n');
}

export function assinarRequestHmac(segredo: string, payload: string): string {
  return createHmac('sha256', segredo).update(payload).digest('hex');
}

function assinaturasIguais(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Valida headers HMAC contra o(s) segredo(s) cifrado(s) da credencial.
 * Aceita o segredo atual e, na janela de rotação, o anterior.
 */
export function verificarAssinaturaHmacRequest(params: {
  method: string;
  path: string;
  timestampHeader?: string;
  nonceHeader?: string;
  signatureHeader?: string;
  bodyRaw: string | Buffer;
  segredoHmacCriptografado: string | null | undefined;
  segredoHmacAnteriorCriptografado?: string | null;
  agora?: number;
}): void {
  const ts = params.timestampHeader?.trim();
  const nonce = params.nonceHeader?.trim();
  const sig = params.signatureHeader?.trim()?.toLowerCase();
  if (!ts || !nonce || !sig) {
    throw new UnauthorizedException(
      'Assinatura HMAC obrigatória: envie x-vpay-timestamp, x-vpay-nonce e x-vpay-signature.',
    );
  }
  if (!/^\d{10,13}$/.test(ts)) {
    throw new UnauthorizedException('x-vpay-timestamp inválido');
  }
  if (nonce.length < 8 || nonce.length > 128) {
    throw new UnauthorizedException('x-vpay-nonce inválido');
  }

  const tsMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
  const agora = params.agora ?? Date.now();
  if (!Number.isFinite(tsMs) || Math.abs(agora - tsMs) > HMAC_SKEW_MS) {
    throw new UnauthorizedException(
      'x-vpay-timestamp fora da janela permitida (±5 min).',
    );
  }

  if (!params.segredoHmacCriptografado) {
    throw new UnauthorizedException(
      'Credencial sem segredo HMAC cadastrado — rotacione a chave no painel.',
    );
  }

  const payload = montarPayloadHmac({
    method: params.method,
    path: params.path,
    timestamp: ts,
    nonce,
    bodyRaw: params.bodyRaw,
  });

  const candidatos: string[] = [];
  try {
    candidatos.push(decryptText(params.segredoHmacCriptografado));
  } catch {
    throw new UnauthorizedException('Falha ao verificar assinatura HMAC');
  }
  if (params.segredoHmacAnteriorCriptografado) {
    try {
      candidatos.push(decryptText(params.segredoHmacAnteriorCriptografado));
    } catch {
      /* anterior ilegível — ignora */
    }
  }

  const ok = candidatos.some((segredo) =>
    assinaturasIguais(sig, assinarRequestHmac(segredo, payload)),
  );
  if (!ok) {
    throw new UnauthorizedException('Assinatura HMAC inválida');
  }
}
