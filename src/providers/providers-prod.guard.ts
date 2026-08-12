import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SITUACAO_PROVEDOR } from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { CODIGOS_VALORION } from './valorion/valorion.codigos';

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

    const valorions = await this.prisma.provedorPagamento.findMany({
      where: {
        codigo: { in: [...CODIGOS_VALORION] },
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
      include: { ipsWebhook: true },
    });
    const semIp = valorions.filter((p) => p.ipsWebhook.length === 0);
    if (semIp.length > 0) {
      throw new Error(
        `Produção: adquirente(s) Valorion ATIVA(s) sem IPs de webhook: ` +
          `${semIp.map((p) => p.codigo).join(', ')}. ` +
          'Cadastre a allowlist no admin antes de subir — Camada 2 obrigatória.',
      );
    }
  }
}
