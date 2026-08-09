import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SITUACAO_PROVEDOR } from '../shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Travas de produção no boot do módulo de adquirentes:
 * - mock NUNCA fica ATIVO
 * - Valorion precisa ter allowlist de IP (Camada 2)
 */
@Injectable()
export class ProvidersProdGuard implements OnModuleInit {
  private readonly log = new Logger(ProvidersProdGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    if (process.env.NODE_ENV !== 'production') return;

    const mock = await this.prisma.provedorPagamento.updateMany({
      where: { codigo: 'mock', situacao: { not: SITUACAO_PROVEDOR.INATIVO } },
      data: { situacao: SITUACAO_PROVEDOR.INATIVO },
    });
    if (mock.count > 0) {
      this.log.warn(
        `Produção: forçou mock INATIVO (${mock.count} registro(s)) — crédito fictício bloqueado`,
      );
    }

    const valorion = await this.prisma.provedorPagamento.findUnique({
      where: { codigo: 'valorion' },
      include: { ipsWebhook: true },
    });
    if (valorion && valorion.ipsWebhook.length === 0) {
      throw new Error(
        'Produção: provedor valorion sem IPs de webhook cadastrados. ' +
          'Cadastre a allowlist no admin antes de subir — Camada 2 obrigatória.',
      );
    }
  }
}
