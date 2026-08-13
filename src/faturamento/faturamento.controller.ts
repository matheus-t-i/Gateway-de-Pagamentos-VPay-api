import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  calcularProgressoFaturamento,
  chaveMesBrasilia,
  inicioDoMesBrasiliaOffset,
  partesBrasilia,
  PERMISSOES,
  SITUACAO_TRANSACAO,
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

    // 12 meses cheios para trás + o mês corrente (mês civil em Brasília).
    const hoje = new Date();
    const inicioSerie = inicioDoMesBrasiliaOffset(11, hoje);

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

    // Agrupa por mês civil em Brasília — getFullYear/getMonth no processo UTC
    // (Render) joga venda 31/08 22h BRT para setembro.
    const baldes = new Map<string, { valor: number; qtd: number }>();
    for (let i = 0; i < 12; i++) {
      const d = inicioDoMesBrasiliaOffset(11 - i, hoje);
      const p = partesBrasilia(d);
      baldes.set(`${p.year}-${String(p.month).padStart(2, '0')}`, {
        valor: 0,
        qtd: 0,
      });
    }
    for (const l of linhas) {
      const chave = chaveMesBrasilia(l.criadoEm);
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
