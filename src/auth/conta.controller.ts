import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import {
  SITUACAO_TRANSACAO,
  SITUACAO_USUARIO,
  TAMANHO_MAXIMO_SENHA,
  TIPOS_EMAIL,
  violacoesSenha,
} from '../shared';
import { Throttle } from '../common/ip-throttle.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { validarTotp } from './totp.controller';

const alterarSenhaSchema = z
  .object({
    senhaAtual: z.string().min(1, 'Informe a senha atual.'),
    novaSenha: z.string().max(TAMANHO_MAXIMO_SENHA),
    confirmacaoNovaSenha: z.string(),
  })
  .refine((d) => d.novaSenha === d.confirmacaoNovaSenha, {
    path: ['confirmacaoNovaSenha'],
    message: 'As senhas informadas precisam ser iguais',
  });

const encerrarSchema = z.object({
  senha: z.string().min(1, 'Confirme sua senha para encerrar a conta.'),
  /** Exigido quando a conta tem 2FA ativo. */
  codigoTotp: z.string().regex(/^\d{6}$/).optional(),
  motivo: z.string().max(500).optional(),
});

/** Situações de transação que ainda podem virar dinheiro (não terminais). */
const SITUACOES_EM_ABERTO: string[] = [
  SITUACAO_TRANSACAO.PENDENTE,
  SITUACAO_TRANSACAO.PROCESSANDO,
  SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
  SITUACAO_TRANSACAO.LIQUIDADA,
];

/** Casos MED ainda sem decisão — dinheiro que pode ser exigido de volta. */
const SITUACOES_MED_ABERTAS: string[] = [
  'RECEBIDO',
  'SALDO_BLOQUEADO',
  'EM_ANALISE',
];

type Requisito = { id: string; texto: string; atendido: boolean; detalhe?: string };

/** O detalhe do requisito vai direto para a tela — precisa sair em pt-BR. */
const brl = (v: number) =>
  'R$ ' +
  v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Conta do próprio titular: troca de senha e encerramento.
 *
 * Sem `@RequerPermissao` de propósito — igual a `/auth/me` e `/auth/totp`, o
 * alvo é sempre o dono do JWT, então não existe perfil que "possa" mexer na
 * conta de outro por aqui.
 */
@Controller('painel/conta')
@UseGuards(JwtAuthGuard)
export class ContaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  /**
   * Troca de senha pelo painel. Exige a senha atual: sessão aberta em máquina
   * de terceiro não pode virar troca de senha (que travaria o dono fora).
   */
  // Verificação de senha é caro (argon2) e alvo de força bruta.
  @Throttle({ limit: 10, windowSec: 60 })
  @Post('senha')
  async alterarSenha(
    @Req() req: { user: { id: string }; ip?: string },
    @Body() body: unknown,
  ) {
    const parsed = alterarSenhaSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { senhaAtual, novaSenha } = parsed.data;

    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: BigInt(req.user.id) },
    });

    const confere = await argon2.verify(usuario.senhaHash, senhaAtual);
    if (!confere) {
      await this.prisma.auditoriaAcesso.create({
        data: {
          usuarioId: usuario.id,
          emailInformado: usuario.email,
          enderecoIp: req.ip,
          sucesso: false,
          motivo: 'TROCA_SENHA_SENHA_ATUAL_INVALIDA',
        },
      });
      throw new BadRequestException('Senha atual incorreta.');
    }

    const violacoes = violacoesSenha(novaSenha);
    if (violacoes.length) throw new BadRequestException(violacoes.join(' · '));

    // Repetir a senha atual não é troca de senha — e quem chega aqui costuma
    // estar reagindo a suspeita de vazamento.
    if (await argon2.verify(usuario.senhaHash, novaSenha)) {
      throw new BadRequestException('A nova senha precisa ser diferente da atual.');
    }

    const agora = new Date();
    await this.prisma.usuario.update({
      where: { id: usuario.id },
      data: {
        senhaHash: await argon2.hash(novaSenha),
        senhaAlteradaEm: agora,
        forcarTrocaSenha: false,
      },
    });

    await this.prisma.auditoriaAcesso.create({
      data: {
        usuarioId: usuario.id,
        emailInformado: usuario.email,
        enderecoIp: req.ip,
        sucesso: true,
        motivo: 'TROCA_SENHA_PAINEL',
      },
    });

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.SENHA_ALTERADA,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
    });

    return { ok: true, senhaAlteradaEm: agora };
  }

  /**
   * Requisitos do encerramento, um a um — a tela mostra a lista com o que já
   * está resolvido e o que falta, em vez de um "não pode" sem explicação.
   */
  @Get('encerramento')
  async elegibilidadeEncerramento(
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    return this.montarRequisitos(BigInt(req.user.id), req.user.papeis);
  }

  private async montarRequisitos(usuarioId: bigint, papeis: string[] = []) {
    const [saldo, saquesAbertos, cobrancasAbertas, medsAbertos, devolucoes] =
      await Promise.all([
        this.prisma.saldoUsuario.findUnique({ where: { usuarioId } }),
        this.prisma.transacao.count({
          where: {
            usuarioId,
            direcao: 'SAIDA',
            situacao: { in: SITUACOES_EM_ABERTO as never },
          },
        }),
        this.prisma.transacao.count({
          where: {
            usuarioId,
            direcao: 'ENTRADA',
            situacao: { in: SITUACOES_EM_ABERTO as never },
          },
        }),
        this.prisma.casoMed.count({
          where: { usuarioId, situacao: { in: SITUACOES_MED_ABERTAS } },
        }),
        this.prisma.devolucaoPix.count({
          where: {
            transacao: { usuarioId },
            situacao: { in: ['PENDENTE', 'PROCESSANDO'] },
          },
        }),
      ]);

    const soma = [
      saldo?.saldoDisponivel,
      saldo?.saldoPendenteLiberacao,
      saldo?.saldoReservado,
      saldo?.saldoBloqueadoMed,
      saldo?.saldoBloqueadoManual,
    ].reduce((total, v) => total + Number(v ?? 0), 0);

    const requisitos: Requisito[] = [
      {
        id: 'saldo',
        texto: 'Não possuir saldo em nenhuma das carteiras',
        atendido: soma === 0,
        detalhe:
          soma === 0
            ? undefined
            : `Saldo total de ${brl(soma)} (disponível, a liberar, reservado e bloqueado). Saque ou zere antes de encerrar.`,
      },
      {
        id: 'saques',
        texto: 'Não possuir saques em andamento',
        atendido: saquesAbertos === 0,
        detalhe: saquesAbertos ? `${saquesAbertos} saque(s) em processamento.` : undefined,
      },
      {
        id: 'cobrancas',
        texto: 'Não possuir cobranças pendentes',
        atendido: cobrancasAbertas === 0,
        detalhe: cobrancasAbertas
          ? `${cobrancasAbertas} cobrança(s) aguardando pagamento ou liquidação.`
          : undefined,
      },
      {
        id: 'med',
        texto: 'Não possuir contestações (MED) em aberto',
        atendido: medsAbertos === 0,
        detalhe: medsAbertos ? `${medsAbertos} caso(s) de MED aguardando decisão.` : undefined,
      },
      {
        id: 'devolucoes',
        texto: 'Não possuir devoluções PIX em processamento',
        atendido: devolucoes === 0,
        detalhe: devolucoes ? `${devolucoes} devolução(ões) em andamento.` : undefined,
      },
    ];

    // Anti-lockout: administrador não se auto-encerra. A conta encerrada perde
    // o acesso na hora, e encerrar o último ADMINISTRADOR deixaria o sistema
    // sem ninguém para reabrir nada — mesmo motivo de "ninguém remove o próprio
    // ADMINISTRADOR" nos perfis.
    if (papeis.includes('ADMINISTRADOR')) {
      requisitos.push({
        id: 'administrador',
        texto: 'Contas de administrador não são encerradas pelo painel',
        atendido: false,
        detalhe:
          'Peça a outro administrador para inativar este acesso — encerrar aqui poderia deixar o sistema sem administrador.',
      });
    }

    return { podeEncerrar: requisitos.every((r) => r.atendido), requisitos };
  }

  /**
   * Encerra a conta a pedido do titular.
   *
   * **Não apaga nada.** A conta vai para `ENCERRADO`: o `JwtAuthGuard` e o
   * `ApiKeyGuard` já recusam quem não está `ATIVO`, então painel e API param na
   * hora; as credenciais são revogadas e os webhooks desativados para o
   * desligamento ficar explícito no banco (e visível se a conta for reaberta).
   * O histórico financeiro continua inteiro — é obrigação fiscal e é o que
   * sustenta uma contestação futura.
   */
  @Throttle({ limit: 5, windowSec: 60 })
  @Post('encerrar')
  async encerrar(
    @Req() req: { user: { id: string; papeis: string[] }; ip?: string },
    @Body() body: unknown,
  ) {
    const parsed = encerrarSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const usuarioId = BigInt(req.user.id);
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuarioId },
    });

    if (!(await argon2.verify(usuario.senhaHash, parsed.data.senha))) {
      throw new BadRequestException('Senha incorreta.');
    }

    // Com 2FA ativo, senha sozinha não encerra conta — mesmo critério do login.
    if (usuario.totpHabilitado) {
      if (!parsed.data.codigoTotp) {
        throw new BadRequestException(
          'Informe o código da verificação em duas etapas para encerrar a conta.',
        );
      }
      if (
        !usuario.segredoTotpCriptografado ||
        !validarTotp(usuario.segredoTotpCriptografado, parsed.data.codigoTotp)
      ) {
        throw new BadRequestException('Código de verificação inválido.');
      }
    }

    // Reconferido aqui dentro: entre abrir a tela e confirmar pode ter entrado
    // uma cobrança nova ou um MED.
    const elegibilidade = await this.montarRequisitos(usuarioId, req.user.papeis);
    if (!elegibilidade.podeEncerrar) {
      const pendencias = elegibilidade.requisitos
        .filter((r) => !r.atendido)
        .map((r) => r.detalhe ?? r.texto);
      throw new BadRequestException(
        `Ainda existem pendências na conta: ${pendencias.join(' · ')}`,
      );
    }

    const agora = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuarioId },
        data: {
          situacao: SITUACAO_USUARIO.ENCERRADO as never,
          encerradaEm: agora,
          motivoEncerramento: parsed.data.motivo,
        },
      });

      await tx.historicoSituacaoUsuario.create({
        data: {
          usuarioId,
          situacaoAnterior: usuario.situacao,
          novaSituacao: SITUACAO_USUARIO.ENCERRADO,
          motivo: parsed.data.motivo ?? 'Encerramento solicitado pelo titular',
          usuarioAtorId: usuarioId,
        },
      });

      // Credenciais de API: revogadas, não apagadas — o histórico de acesso
      // continua apontando para elas.
      await tx.credencialApi.updateMany({
        where: { usuarioId, ativo: true },
        data: { ativo: false, revogadoEm: agora },
      });

      await tx.configuracaoWebhookUsuario.updateMany({
        where: { usuarioId, ativo: true },
        data: { ativo: false },
      });

      await tx.registroAuditoria.create({
        data: {
          usuarioAtorId: usuarioId,
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'CONTA_ENCERRADA_PELO_TITULAR',
          nomeTabela: 'usuarios',
          chaveRegistro: usuario.idPublico,
          usuarioAfetadoId: usuarioId,
          enderecoIp: req.ip,
          dadosAnteriores: { situacao: usuario.situacao } as never,
          dadosNovos: {
            situacao: SITUACAO_USUARIO.ENCERRADO,
            motivo: parsed.data.motivo ?? null,
          } as never,
        },
      });
    });

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.CONTA_ENCERRADA,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
    });

    return {
      ok: true,
      encerradaEm: agora,
      mensagem:
        'Conta encerrada. O acesso ao painel, as credenciais de API e os webhooks foram desligados.',
    };
  }
}
