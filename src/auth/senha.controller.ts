import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { TAMANHO_MAXIMO_SENHA, TIPOS_EMAIL, violacoesSenha } from '../shared';
import { Throttle } from '../common/ip-throttle.guard';

const esqueciSchema = z.object({ email: z.string().email() });
const trocaObrigatoriaSchema = z
  .object({
    email: z.string().email(),
    senhaAtual: z.string().min(1, 'Informe a senha provisória.'),
    novaSenha: z.string().max(TAMANHO_MAXIMO_SENHA),
    confirmacaoNovaSenha: z.string(),
  })
  .refine((d) => d.novaSenha === d.confirmacaoNovaSenha, {
    path: ['confirmacaoNovaSenha'],
    message: 'As senhas informadas precisam ser iguais',
  });
const redefinirSchema = z.object({
  token: z.string().min(20),
  novaSenha: z
    .string()
    .min(8)
    .max(TAMANHO_MAXIMO_SENHA)
    .superRefine((senha, ctx) => {
      for (const msg of violacoesSenha(senha)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
      }
    }),
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

  @Throttle({ limit: 10, windowSec: 60 })
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

    const violacoes = violacoesSenha(parsed.data.novaSenha);
    if (violacoes.length) throw new BadRequestException(violacoes.join(' · '));

    const senhaHash = await argon2.hash(parsed.data.novaSenha);
    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: registro.usuarioId },
        data: {
          senhaHash,
          senhaAlteradaEm: new Date(),
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

  /**
   * Troca obrigatória: conta com `forcarTrocaSenha` (senha redefinida pelo
   * administrador) não recebe token no login, então a troca não pode depender
   * de JWT. Mesmo padrão do onboarding — reverifica e-mail + senha a cada
   * request, sem sessão.
   */
  @Throttle({ limit: 10, windowSec: 60 })
  @Post('trocar-obrigatoria')
  async trocarObrigatoria(@Body() body: unknown, @Req() req: { ip?: string }) {
    const parsed = trocaObrigatoriaSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { email, senhaAtual, novaSenha } = parsed.data;

    const usuario = await this.prisma.usuario.findUnique({ where: { email } });
    // Mensagem única para credencial errada e conta inexistente: resposta
    // diferente entregaria quais e-mails existem.
    const credencialInvalida = new BadRequestException('Credenciais inválidas.');
    if (!usuario) throw credencialInvalida;
    if (!(await argon2.verify(usuario.senhaHash, senhaAtual))) {
      await this.prisma.auditoriaAcesso.create({
        data: {
          usuarioId: usuario.id,
          emailInformado: email,
          enderecoIp: req.ip,
          sucesso: false,
          motivo: 'TROCA_OBRIGATORIA_SENHA_INVALIDA',
        },
      });
      throw credencialInvalida;
    }
    if (!usuario.forcarTrocaSenha) {
      throw new BadRequestException(
        'Esta conta não tem troca de senha pendente. Faça login normalmente.',
      );
    }

    const violacoes = violacoesSenha(novaSenha);
    if (violacoes.length) throw new BadRequestException(violacoes.join(' · '));
    if (await argon2.verify(usuario.senhaHash, novaSenha)) {
      throw new BadRequestException(
        'A nova senha precisa ser diferente da senha provisória.',
      );
    }

    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: {
        senhaHash: await argon2.hash(novaSenha),
        senhaAlteradaEm: new Date(),
        forcarTrocaSenha: false,
      },
    });

    await this.prisma.auditoriaAcesso.create({
      data: {
        usuarioId: usuario.id,
        emailInformado: email,
        enderecoIp: req.ip,
        sucesso: true,
        motivo: 'TROCA_OBRIGATORIA_CONCLUIDA',
      },
    });

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.SENHA_ALTERADA,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
    });

    return { ok: true, mensagem: 'Senha alterada. Faça login com a nova senha.' };
  }
}
