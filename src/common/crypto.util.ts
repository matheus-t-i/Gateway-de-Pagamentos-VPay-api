import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

function keyFromEnv(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY deve ter 64 hex chars (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/** Criptografa JSON de credenciais do provedor (AES-256-GCM). */
export function encryptCredentials(plain: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyFromEnv(), iv);
  const json = JSON.stringify(plain);
  const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** Criptografa/decifra um texto simples (ex.: segredo TOTP) com a mesma chave. */
export function encryptText(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyFromEnv(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptText(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, keyFromEnv(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * AES-256-GCM (iv 12 + tag 16 + ciphertext). Blob vazio/curto = `{}`:
 * as contas da Valorion/mock nascem sem credencial de propósito e o client
 * cai no fallback de env (`VALORION_API_KEY`). Sem isto, `''` ou `'{}'` em
 * claro viram "Invalid initialization vector" e a cobrança morre em 503
 * ANTES de qualquer chamada à liquidante.
 */
export function decryptCredentials(payload: string): Record<string, unknown> {
  if (!payload || payload.trim() === '') return {};
  const buf = Buffer.from(payload, 'base64');
  // Mínimo GCM: 12 (IV) + 16 (tag). Abaixo disso nunca foi AES nosso.
  if (buf.length < 28) return {};
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, keyFromEnv(), iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}
