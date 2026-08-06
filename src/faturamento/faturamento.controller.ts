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
    const whereAprovadas = {
      usuarioId,
      direcao: 'ENTRADA' as const,
      situacao: { in: [...SITUACOES_APROVADAS] },
    };

    // 12 meses cheios para trás + o mês corrente.
    const hoje = new Date();
    const inicioSerie = new Date(hoje.getFullYear(), hoje.getMonth() - 11, 1);

    const [agregado, primeira, linhas] = await Promise.all([
      this.prisma.transacao.aggregate({
        where: whereAprovadas,
        _sum: { valorBruto: true },
        _count: true,
      }),
      this.prisma.transacao.findFirst({
        where: whereAprovadas,
        orderBy: { criadoEm: 'asc' },
        select: { criadoEm: true },
      }),
      this.prisma.transacao.findMany({
        where: { ...whereAprovadas, criadoEm: { gte: inicioSerie } },
        select: { criadoEm: true, valorBruto: true },
        take: 50000,
      }),
    ]);

    const gmv = Number((agregado._sum.valorBruto ?? 0).toString());
    const qtdPagas = Number(agregado._count ?? 0);

    // Agrupa por mês em JS (mesma abordagem do dashboard).
    const baldes = new Map<string, { valor: number; qtd: number }>();
    for (let i = 0; i < 12; i++) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - 11 + i, 1);
      baldes.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, {
        valor: 0,
        qtd: 0,
      });
    }
    for (const l of linhas) {
      const chave = `${l.criadoEm.getFullYear()}-${String(
        l.criadoEm.getMonth() + 1,
      ).padStart(2, '0')}`;
      const b = baldes.get(chave);
      if (!b) continue;
      b.valor += Number(l.valorBruto);
      b.qtd += 1;
    }

    const mensal = Array.from(baldes.entries()).map(([mes, b]) => ({
      mes,
      valor: b.valor.toFixed(2),
      qtd: b.qtd,
    }));
    const mesAtual = mensal[mensal.length - 1];
    const mesAnterior = mensal[mensal.length - 2];
    const melhorMes = mensal.reduce(
      (melhor, m) => (Number(m.valor) > Number(melhor.valor) ? m : melhor),
      mensal[0],
    );

    const diasOperando = primeira
      ? Math.max(
          1,
          Math.round((hoje.getTime() - primeira.criadoEm.getTime()) / 86_400_000),
        )
      : 0;

    return {
      ...calcularProgressoFaturamento(gmv, qtdPagas),
      ticketMedio: (qtdPagas > 0 ? gmv / qtdPagas : 0).toFixed(2),
      primeiraVenda: primeira?.criadoEm ?? null,
      diasOperando,
      mediaDiaria: (diasOperando > 0 ? gmv / diasOperando : 0).toFixed(2),
      mensal,
      mesAtual,
      mesAnterior,
      melhorMes,
    };
  }
}
