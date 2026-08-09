import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { generateSecret, generateURI, verifySync } from 'otplib';
import * as QRCode from 'qrcode';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { decryptText, encryptText } from '../common/crypto.util';
import { MARCA } from '../email/email.templates';
import { TIPOS_EMAIL } from '../shared';
import { JwtAuthGuard } from './jwt-auth.guard';

const codigoSchema = z.object({ codigo: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos') });
const desabilitarSchema = z.object({
  codigo: z.string().regex(/^\d{6}$/).optional(),
  senha: z.string().min(8),
});

/** Verifica um código TOTP contra o segredo criptografado do usuário. */
export function validarTotp(segredoCriptografado: string, codigo: string): boolean {
  try {
    return verifySync({
      token: codigo,
      secret: decryptText(segredoCriptografado),
    }).valid;
  } catch {
    return false;
  }
}

/**
 * Setup/desligamento do próprio TOTP.
 * Sem `@RequerPermissao` (conta própria) e sem `assertStepUpTotp` — exigir
 * step-up aqui seria chicken-and-egg para quem ainda está ativando o 2FA.
 */
@Controller('auth/totp')
@UseGuards(JwtAuthGuard)
export class TotpController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  /**
   * Passo 1: gera um segredo e devolve o QR Code. O 2FA só passa a valer
   * depois de confirmar um código válido (evita travar a conta com um segredo
   * que o usuário não conseguiu cadastrar no aplicativo).
   */
  @Post('iniciar')
  async iniciar(@Req() req: { user: { id: string; email: string } }) {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: BigInt(req.user.id) },
    });
    if (usuario.totpHabilitado) {
      throw new BadRequestException('A verificação em duas etapas já está ativa.');
    }

    const segredo = generateSecret();
    const uri = generateURI({
      issuer: MARCA.nome,
      label: usuario.email,
      secret: segredo,
    });

    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: { segredoTotpCriptografado: encryptText(segredo) },
    });

    return {
      // Segredo em texto aparece UMA vez, para o usuário digitar manualmente
      // caso não consiga ler o QR. Depois disso só existe criptografado.
      segredo,
      uri,
      qrCodeDataUrl: await QRCode.toDataURL(uri),
    };
  }

  @Post('confirmar')
  async confirmar(
    @Req() req: { user: { id: string } },
    @Body() body: unknown,
  ) {
    const parsed = codigoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: BigInt(req.user.id) },
    });
    if (!usuario.segredoTotpCriptografado) {
      throw new BadRequestException('Inicie a configuração antes de confirmar.');
    }
    if (!validarTotp(usuario.segredoTotpCriptografado, parsed.data.codigo)) {
      throw new BadRequestException('Código inválido. Tente novamente.');
    }

    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: { totpHabilitado: true, totpAtivadoEm: new Date() },
    });
    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.TOTP_HABILITADO,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
    });

    return { ok: true, totpHabilitado: true };
  }

  /** Desativar exige a senha (e o código, se ainda tiver o aplicativo). */
  @Post('desabilitar')
  async desabilitar(@Req() req: { user: { id: string } }, @Body() body: unknown) {
    const parsed = desabilitarSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: BigInt(req.user.id) },
    });
    if (!usuario.totpHabilitado) {
      throw new BadRequestException('A verificação em duas etapas não está ativa.');
    }
    const senhaOk = await argon2.verify(usuario.senhaHash, parsed.data.senha);
    if (!senhaOk) throw new BadRequestException('Senha incorreta.');
    if (
      parsed.data.codigo &&
      usuario.segredoTotpCriptografado &&
      !validarTotp(usuario.segredoTotpCriptografado, parsed.data.codigo)
    ) {
      throw new BadRequestException('Código inválido.');
    }

    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: {
        totpHabilitado: false,
        segredoTotpCriptografado: null,
        totpAtivadoEm: null,
      },
    });
    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.TOTP_DESABILITADO,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
    });

    return { ok: true, totpHabilitado: false };
  }
}
