import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { TIPOS_EMAIL } from '../shared';
import { Throttle } from '../common/ip-throttle.guard';

const esqueciSchema = z.object({ email: z.string().email() });
const redefinirSchema = z.object({
  token: z.string().min(20),
  novaSenha: z.string().min(8).max(128),
});

/** Validade do link de redefinição. */
const VALIDADE_MINUTOS = 30;

@Controller('auth/senha')
export class SenhaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Solicita redefinição. Responde SEMPRE 200, exista o e-mail ou não —
   * resposta diferente entregaria a lista de clientes a um atacante.
   */
  // Cada pedido dispara um e-mail: trava flood de e-mail e enumeração por volume.
  @Throttle({ limit: 5, windowSec: 60 })
  @Post('esqueci')
  async esqueci(@Body() body: unknown, @Req() req: { ip?: string }) {
    const parsed = esqueciSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const usuario = await this.prisma.usuario.findUnique({
      where: { email: parsed.data.email },
    });

    if (usuario && !usuario.contaBloqueada) {
      // Token forte; guardamos apenas o hash (vazamento do banco não permite reset).
      const token = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(token).digest('hex');

      await this.prisma.$transaction(async (tx) => {
        // Invalida pedidos anteriores ainda válidos.
        await tx.tokenRedefinicaoSenha.updateMany({
          where: { usuarioId: usuario.id, usadoEm: null },
          data: { usadoEm: new Date() },
        });
        await tx.tokenRedefinicaoSenha.create({
          data: {
            usuarioId: usuario.id,
            tokenHash,
            expiraEm: new Date(Date.now() + VALIDADE_MINUTOS * 60 * 1000),
          },
        });
      });

      await this.prisma.auditoriaAcesso.create({
        data: {
          usuarioId: usuario.id,
          emailInformado: parsed.data.email,
          enderecoIp: req.ip,
          sucesso: true,
          motivo: 'RESET_SENHA_SOLICITADO',
        },
      });

      const base = this.config.get<string>('WEB_URL') ?? 'http://localhost:3000';
      await this.queues.enqueueEmail({
        tipo: TIPOS_EMAIL.REDEFINIR_SENHA,
        para: usuario.email,
        nome: usuario.nomeRazaoSocial,
        dados: {
          url: `${base}/senha/redefinir?token=${token}`,
          validadeMinutos: String(VALIDADE_MINUTOS),
        },
      });
    }

    return {
      ok: true,
      mensagem:
        'Se este e-mail estiver cadastrado, enviamos as instruções de redefinição.',
    };
  }

  @Post('redefinir')
  async redefinir(@Body() body: unknown, @Req() req: { ip?: string }) {
    const parsed = redefinirSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const tokenHash = createHash('sha256')
      .update(parsed.data.token)
      .digest('hex');
    const registro = await this.prisma.tokenRedefinicaoSenha.findUnique({
      where: { tokenHash },
      include: { usuario: true },
    });

    if (!registro || registro.usadoEm || registro.expiraEm < new Date()) {
      throw new BadRequestException('Link inválido ou expirado. Solicite outro.');
    }

    const senhaHash = await argon2.hash(parsed.data.novaSenha);
    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: registro.usuarioId },
        data: {
          senhaHash,
          forcarTrocaSenha: false,
          // Redefinir a senha destrava a conta bloqueada por tentativas.
          contaBloqueada: false,
        },
      });
      // Uso único.
      await tx.tokenRedefinicaoSenha.update({
        where: { id: registro.id },
        data: { usadoEm: new Date() },
      });
    });

    await this.prisma.auditoriaAcesso.create({
      data: {
        usuarioId: registro.usuarioId,
        emailInformado: registro.usuario.email,
        enderecoIp: req.ip,
        sucesso: true,
        motivo: 'RESET_SENHA_CONCLUIDO',
      },
    });

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.SENHA_ALTERADA,
      para: registro.usuario.email,
      nome: registro.usuario.nomeRazaoSocial,
    });

    return { ok: true, mensagem: 'Senha alterada. Já pode acessar sua conta.' };
  }
}
