import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { validarTotp } from '../auth/totp.controller';

/** Body mínimo com código TOTP de step-up (mutações sem outros campos). */
export const stepUpBodySchema = z.object({
  codigoTotp: z.string().regex(/^\d{6}$/),
});

/** Fragmento Zod — incluir nos schemas de mutação do painel/admin. */
export const codigoTotpField = z.string().regex(/^\d{6}$/);

/**
 * Step-up 2FA para mutações autenticadas (persistência, dinheiro, privilégio).
 * Exige conta do ator com TOTP ativo e código válido no body.
 *
 * Contas sem 2FA recebem 403 — ative em `/configuracoes` antes de mutar.
 * Exceções intencionais: setup/desligamento do próprio TOTP (`/auth/totp/*`).
 */
export async function assertStepUpTotp(
  prisma: PrismaService,
  atorId: bigint | string | undefined,
  codigoTotp: string | undefined,
): Promise<void> {
  if (!atorId) {
    throw new UnauthorizedException('Sessão inválida para operação privilegiada.');
  }
  const ator = await prisma.usuario.findUnique({
    where: { id: BigInt(atorId) },
    select: {
      totpHabilitado: true,
      segredoTotpCriptografado: true,
    },
  });
  if (!ator?.totpHabilitado || !ator.segredoTotpCriptografado) {
    throw new ForbiddenException(
      'Ative a verificação em duas etapas na sua conta para executar esta operação.',
    );
  }
  if (!codigoTotp || !/^\d{6}$/.test(codigoTotp)) {
    throw new BadRequestException('Informe codigoTotp (6 dígitos) para confirmar.');
  }
  if (!validarTotp(ator.segredoTotpCriptografado, codigoTotp)) {
    throw new UnauthorizedException('Código 2FA inválido.');
  }
}

/**
 * Lê `codigoTotp` do body (ou `{}`) e valida o step-up.
 * Útil em DELETE / POST sem schema próprio além do TOTP.
 */
export async function assertStepUpFromBody(
  prisma: PrismaService,
  atorId: bigint | string | undefined,
  body: unknown,
): Promise<void> {
  const parsed = stepUpBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new BadRequestException('Informe codigoTotp (6 dígitos) para confirmar.');
  }
  await assertStepUpTotp(prisma, atorId, parsed.data.codigoTotp);
}

/** @deprecated use stepUpBodySchema — mantido por compatibilidade de imports. */
export const codigoTotpStepUp = {
  codigoTotp: true as const,
};
