import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  Decimal,
  inicioDoDiaBrasilia as meiaNoiteBrasilia,
  money,
  SITUACAO_TRANSACAO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixEfetiva } from '../ledger/ledger.service';

/** Janela em que falhas de saque contam para auto-desligar. */
const JANELA_ABUSO_MS = 15 * 60 * 1000;
/** Quantidade de recusas na janela que desliga o saque automaticamente. */
const MAX_RECUSAS_ABUSO = 10;
/** Após troca de senha, saque fica bloqueado por este prazo (antifraude). */
const BLOQUEIO_POS_TROCA_SENHA_MS = 24 * 60 * 60 * 1000;

/**
 * Limites diários/velocity + antifraude de saque.
 *
 * Separado do `PixService` para o worker revalidar as mesmas regras sem
 * circular dependency, e para o admin poder limpar bloqueio por abuso.
 */
@Injectable()
export class SaqueProtecaoService {
  private readonly log = new Logger(SaqueProtecaoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Início do dia civil em America/Sao_Paulo (gateway BR).
   * Usado no limite diário — UTC meia-noite cortaria o expediente do lojista.
   * Fonte única: `src/shared/fuso-brasilia.ts`.
   */
  inicioDoDiaBrasilia(agora = new Date()): Date {
    return meiaNoiteBrasilia(agora);
  }

  /**
   * Revalida limites, bloqueio por abuso e carência pós-troca de senha.
   * Chamado na criação E no processor — o job pode rodar horas depois.
   */
  async assertSaquePermitido(params: {
    usuarioId: bigint;
    valor: Decimal;
    cfg: ConfigPixEfetiva;
    /**
     * Id da transação JÁ CRIADA deste saque (revalidação no worker). Sem isto,
     * o saque em processamento entra no próprio `aggregate`/`count` e conta
     * DUAS vezes: qualquer saque acima de metade do limite diário (ou o
     * N-ésimo com `maxSaquesPorHora = N`) era recusado no worker com o saldo
     * já debitado. É só filtro de leitura — nenhuma linha é alterada.
     */
    ignorarTransacaoId?: bigint;
  }) {
    const cfgLinha = await this.prisma.configuracaoPixUsuario.findUnique({
      where: { usuarioId: params.usuarioId },
      select: {
        saqueBloqueadoPorAbuso: true,
        saqueBloqueadoPorAbusoMotivo: true,
        limiteDiarioPixSaida: true,
        maxSaquesPorHora: true,
      },
    });

    if (cfgLinha?.saqueBloqueadoPorAbuso) {
      throw new BadRequestException(
        cfgLinha.saqueBloqueadoPorAbusoMotivo?.trim() ||
          'Saque desabilitado automaticamente por atividade suspeita. Contate o suporte.',
      );
    }

    const usuario = await this.prisma.usuario.findUnique({
      where: { id: params.usuarioId },
      select: { senhaAlteradaEm: true },
    });
    if (
      usuario?.senhaAlteradaEm &&
      Date.now() - usuario.senhaAlteradaEm.getTime() < BLOQUEIO_POS_TROCA_SENHA_MS
    ) {
      throw new BadRequestException(
        'Saque temporariamente bloqueado após troca de senha (proteção antifraude de 24h).',
      );
    }

    const limiteDiario =
      params.cfg.limiteDiarioPixSaida ??
      (cfgLinha?.limiteDiarioPixSaida
        ? money(cfgLinha.limiteDiarioPixSaida.toString())
        : null);
    const maxPorHora =
      params.cfg.maxSaquesPorHora ?? cfgLinha?.maxSaquesPorHora ?? null;

    if (limiteDiario && limiteDiario.gt(0)) {
      const inicio = this.inicioDoDiaBrasilia();
      const agg = await this.prisma.transacao.aggregate({
        where: {
          usuarioId: params.usuarioId,
          direcao: 'SAIDA',
          criadoEm: { gte: inicio },
          // FALHA também conta: senão o lojista cria/falha em loop para
          // furar o teto. Estorno devolve saldo, não a cota do dia.
          situacao: { not: SITUACAO_TRANSACAO.CANCELADA },
          ...(params.ignorarTransacaoId
            ? { id: { not: params.ignorarTransacaoId } }
            : {}),
        },
        _sum: { valorBruto: true },
      });
      const jaUsado = money(agg._sum.valorBruto?.toString() ?? '0');
      if (jaUsado.plus(params.valor).gt(limiteDiario)) {
        throw new BadRequestException(
          `Limite diário de saque excedido (R$ ${limiteDiario.toFixed(2)}). ` +
            `Já utilizado hoje: R$ ${jaUsado.toFixed(2)}.`,
        );
      }
    }

    if (maxPorHora && maxPorHora > 0) {
      const desde = new Date(Date.now() - 60 * 60 * 1000);
      const qtd = await this.prisma.transacao.count({
        where: {
          usuarioId: params.usuarioId,
          direcao: 'SAIDA',
          criadoEm: { gte: desde },
          situacao: { not: SITUACAO_TRANSACAO.CANCELADA },
          ...(params.ignorarTransacaoId
            ? { id: { not: params.ignorarTransacaoId } }
            : {}),
        },
      });
      if (qtd >= maxPorHora) {
        throw new BadRequestException(
          `Limite de velocity: no máximo ${maxPorHora} saque(s) por hora.`,
        );
      }
    }
  }

  /**
   * Registra recusa de saque e, se a conta disparar o limiar, desliga o canal.
   * Nunca lança — falha de auditoria não pode impedir a resposta 400 original.
   */
  async registrarRecusaSaque(params: {
    usuarioId: bigint;
    motivo: string;
    enderecoIp?: string;
    credencialApiId?: bigint;
  }) {
    try {
      await this.prisma.eventoSeguranca.create({
        data: {
          usuarioId: params.usuarioId,
          credencialApiId: params.credencialApiId,
          tipoEvento: 'SAQUE_RECUSADO',
          severidade: 'MEDIA',
          enderecoIp: params.enderecoIp,
          caminho: 'pix.saque',
          acaoAplicada: 'RECUSADO',
          dados: { motivo: params.motivo.slice(0, 500) } as never,
        },
      });

      const desde = new Date(Date.now() - JANELA_ABUSO_MS);
      const qtd = await this.prisma.eventoSeguranca.count({
        where: {
          usuarioId: params.usuarioId,
          tipoEvento: 'SAQUE_RECUSADO',
          ocorridoEm: { gte: desde },
        },
      });

      if (qtd >= MAX_RECUSAS_ABUSO) {
        const motivo =
          `Saque desabilitado automaticamente após ${qtd} tentativas recusadas ` +
          `em ${JANELA_ABUSO_MS / 60000} minutos.`;
        await this.prisma.configuracaoPixUsuario.updateMany({
          where: {
            usuarioId: params.usuarioId,
            saqueBloqueadoPorAbuso: false,
          },
          data: {
            saqueBloqueadoPorAbuso: true,
            saqueBloqueadoPorAbusoEm: new Date(),
            saqueBloqueadoPorAbusoMotivo: motivo,
          },
        });
        await this.prisma.eventoSeguranca.create({
          data: {
            usuarioId: params.usuarioId,
            tipoEvento: 'SAQUE_BLOQUEADO_ABUSO',
            severidade: 'ALTA',
            enderecoIp: params.enderecoIp,
            caminho: 'pix.saque',
            quantidadeDetectada: qtd,
            janelaSegundos: JANELA_ABUSO_MS / 1000,
            acaoAplicada: 'DESLIGAR_SAQUE',
            dados: { motivo } as never,
          },
        });
        this.log.warn(
          `saque bloqueado por abuso usuario=${params.usuarioId} recusas=${qtd}`,
        );
      }
    } catch (e) {
      this.log.error(`registrarRecusaSaque: ${(e as Error).message}`);
    }
  }

  /** Admin libera o saque depois de analisar o bloqueio automático. */
  async limparBloqueioAbuso(usuarioId: bigint) {
    await this.prisma.configuracaoPixUsuario.updateMany({
      where: { usuarioId },
      data: {
        saqueBloqueadoPorAbuso: false,
        saqueBloqueadoPorAbusoEm: null,
        saqueBloqueadoPorAbusoMotivo: null,
      },
    });
  }
}

/** Campos opcionais de limite — null = sem teto. */
export type LimitesSaqueInput = {
  limiteDiarioPixSaida?: Prisma.Decimal | number | string | null;
  maxSaquesPorHora?: number | null;
};
