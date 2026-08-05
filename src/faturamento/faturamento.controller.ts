import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  PERMISSOES,
  SITUACAO_TRANSACAO,
  calcularProgressoFaturamento,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';

/** Mesma regra do dashboard: cash-in que efetivamente entrou. */
const SITUACOES_APROVADAS = [
  SITUACAO_TRANSACAO.LIQUIDADA,
  SITUACAO_TRANSACAO.CONCLUIDA,
] as const;

/**
 * GMV acumulado (lifetime) + marcos de premiação da conta do lojista.
 */
@Controller('painel/faturamento')
@UseGuards(JwtAuthGuard)
export class PainelFaturamentoController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequerPermissao(PERMISSOES.FATURAMENTO_VER)
  async meu(@Req() req: { user: { id: string } }) {
    const usuarioId = BigInt(req.user.id);

    const agregado = await this.prisma.transacao.aggregate({
      where: {
        usuarioId,
        direcao: 'ENTRADA',
        situacao: { in: [...SITUACOES_APROVADAS] },
      },
      _sum: { valorBruto: true },
      _count: true,
    });

    const gmv = Number((agregado._sum.valorBruto ?? 0).toString());
    const qtdPagas = Number(agregado._count ?? 0);

    return calcularProgressoFaturamento(gmv, qtdPagas);
  }
}
