import { BadRequestException, UnauthorizedException } from '@nestjs/common';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type SiteverifyResponse = {
  success: boolean;
  'error-codes'?: string[];
};

/**
 * Cloudflare Turnstile no login do painel.
 *
 * - Produção: secret obrigatório (fail-closed via env.validation + aqui).
 * - development/test: sem TURNSTILE_SECRET_KEY → fail-open (CI/seed).
 */
export async function assertTurnstileLogin(params: {
  token: string | undefined;
  ip?: string;
}): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  const producao = process.env.NODE_ENV === 'production';

  if (!secret) {
    if (producao) {
      throw new UnauthorizedException(
        'Verificação anti-bot indisponível. Tente novamente mais tarde.',
      );
    }
    return;
  }

  if (!params.token?.trim()) {
    throw new BadRequestException(
      'Confirme que você não é um robô (Cloudflare Turnstile).',
    );
  }

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', params.token.trim());
  if (params.ip) body.set('remoteip', params.ip);

  let data: SiteverifyResponse;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    data = (await res.json()) as SiteverifyResponse;
  } catch {
    throw new UnauthorizedException(
      'Não foi possível validar a verificação anti-bot. Tente novamente.',
    );
  }

  if (!data.success) {
    throw new BadRequestException(
      'Verificação anti-bot inválida ou expirada. Atualize o desafio e tente de novo.',
    );
  }
}
