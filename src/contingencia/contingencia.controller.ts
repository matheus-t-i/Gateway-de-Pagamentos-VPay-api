import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PERMISSOES,
  SITUACAO_PROVEDOR,
  TIPO_FALHA_ADQUIRENTE,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { assertStepUpTotp } from '../common/step-up-totp';
import { ContingenciaService } from './contingencia.service';

const TIPOS = Object.values(TIPO_FALHA_ADQUIRENTE) as string[];

type ContaComProvedor = {
  id: bigint;
  nome: string;
  situacao: string;
  pixEntradaHabilitado: boolean;
  provedor: { codigo: string; nome: string; situacao: string };
};

const mapConta = (c: ContaComProvedor) => ({
  id: c.id.toString(),
  nome: c.nome,
  situacao: c.situacao,
  pixEntradaHabilitado: c.pixEntradaHabilitado,
  adquirente: c.provedor.nome,
  codigoAdquirente: c.provedor.codigo,
  adquirenteAtiva: c.provedor.situacao === SITUACAO_PROVEDOR.ATIVO,
});

@Controller('admin/contingencia')
@UseGuards(JwtAuthGuard)
export class ContingenciaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contingencia: ContingenciaService,
  ) {}

  /** Cadeia configurada + contas elegíveis + timeout em vigor. */
  @Get()
  @RequerPermissao(PERMISSOES.ADMIN_CONTINGENCIA_VER)
  async configuracao() {
    const [cadeia, contas] = await Promise.all([
      this.prisma.contingenciaAdquirente.findMany({
        orderBy: { ordem: 'asc' },
        include: { contaProvedor: { include: { provedor: true } } },
      }),
      this.prisma.contaProvedor.findMany({
        where: { pixEntradaHabilitado: true },
        orderBy: [{ provedorPagamentoId: 'asc' }, { nome: 'asc' }],
        include: { provedor: true },
      }),
    ]);

    return {
      timeoutSegundos: this.contingencia.timeoutMs() / 1000,
      cadeia: cadeia.map((c) => ({
        ordem: c.ordem,
        ativo: c.ativo,
        observacao: c.observacao,
        conta: mapConta(c.contaProvedor),
      })),
      contasDisponiveis: contas.map(mapConta),
    };
  }

  /**
   * Substitui a cadeia inteira pela lista informada, na ordem recebida.
   *
   * Apaga e recria dentro de uma transação porque `ordem` é única: mover a
   * conta B da posição 2 para a 1 sem limpar antes colidiria com a conta que
   * ocupa a 1.
   */
  @Put()
  @RequerPermissao(PERMISSOES.ADMIN_CONTINGENCIA_EDITAR)
  async definirCadeia(
    @Body()
    body: {
      contas?: Array<{ contaProvedorId?: string; ativo?: boolean; observacao?: string }>;
      codigoTotp?: string;
    },
    @Req() req: { user: { id: string }; ip?: string },
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    const itens = body.contas ?? [];
    if (!Array.isArray(itens)) throw new BadRequestException('contas deve ser uma lista');
    if (itens.length > 10) {
      throw new BadRequestException('Máximo de 10 adquirentes na cadeia.');
    }

    const ids = itens.map((i) => {
      if (!i.contaProvedorId) throw new BadRequestException('contaProvedorId ausente');
      try {
        return BigInt(i.contaProvedorId);
      } catch {
        throw new BadRequestException(`contaProvedorId inválido: ${i.contaProvedorId}`);
      }
    });
    if (new Set(ids.map(String)).size !== ids.length) {
      throw new BadRequestException('A mesma adquirente aparece duas vezes na cadeia.');
    }

    const contas = await this.prisma.contaProvedor.findMany({
      where: { id: { in: ids } },
      include: { provedor: true },
    });
    if (contas.length !== ids.length) {
      throw new BadRequestException('Alguma conta de adquirente não existe.');
    }
    // Uma conta sem cash-in habilitado nunca conseguiria gerar a cobrança —
    // deixar entrar na cadeia só produziria uma tentativa perdida no meio da
    // corrida contra o relógio.
    const semEntrada = contas.filter((c) => !c.pixEntradaHabilitado);
    if (semEntrada.length) {
      throw new BadRequestException(
        `Sem PIX de entrada habilitado: ${semEntrada.map((c) => c.nome).join(', ')}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.contingenciaAdquirente.deleteMany({});
      for (const [i, id] of ids.entries()) {
        await tx.contingenciaAdquirente.create({
          data: {
            contaProvedorId: id,
            ordem: i + 1,
            ativo: itens[i].ativo ?? true,
            observacao: itens[i].observacao?.slice(0, 255),
          },
        });
      }
      await tx.registroAuditoria.create({
        data: {
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'CONTINGENCIA_CADEIA_DEFINIR',
          nomeTabela: 'contingencia_adquirente',
          enderecoIp: req.ip,
          dadosNovos: { ordem: ids.map(String) } as never,
        },
      });
    });

    return { ok: true, total: ids.length };
  }

  /** Painel de cima da tela: como está a saúde das adquirentes na janela. */
  @Get('resumo')
  @RequerPermissao(PERMISSOES.ADMIN_CONTINGENCIA_VER)
  async resumo(@Query('horas') horasQuery?: string) {
    const horas = Math.min(720, Math.max(1, Number(horasQuery) || 24));
    const desde = new Date(Date.now() - horas * 3600_000);
    const where: Prisma.FalhaAdquirenteWhereInput = { criadoEm: { gte: desde } };

    const [total, salvas, porTipo, porConta] = await Promise.all([
      this.prisma.falhaAdquirente.count({ where }),
      this.prisma.falhaAdquirente.count({
        where: { ...where, resolvidaPorContaProvedorId: { not: null } },
      }),
      this.prisma.falhaAdquirente.groupBy({
        by: ['tipo'],
        where,
        _count: { _all: true },
      }),
      this.prisma.falhaAdquirente.groupBy({
        by: ['contaProvedorId'],
        where,
        _count: { _all: true },
      }),
    ]);

    const contas = await this.prisma.contaProvedor.findMany({
      where: { id: { in: porConta.map((p) => p.contaProvedorId) } },
      include: { provedor: true },
    });
    const nomePorId = new Map(
      contas.map((c) => [c.id.toString(), `${c.provedor.nome} · ${c.nome}`]),
    );

    return {
      horas,
      desde: desde.toISOString(),
      totalFalhas: total,
      // Vendas que a contingência salvou / que se perderam de fato.
      vendasSalvas: salvas,
      vendasPerdidas: total - salvas,
      porTipo: porTipo.map((t) => ({ tipo: t.tipo, total: t._count._all })),
      porAdquirente: porConta
        .map((p) => ({
          contaProvedorId: p.contaProvedorId.toString(),
          nome: nomePorId.get(p.contaProvedorId.toString()) ?? '—',
          total: p._count._all,
        }))
        .sort((a, b) => b.total - a.total),
    };
  }

  /** Monitoramento: falhas paginadas, com filtro. */
  @Get('falhas')
  @RequerPermissao(PERMISSOES.ADMIN_CONTINGENCIA_VER)
  async falhas(@Query() q: Record<string, string>) {
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(1000, Math.max(5, Number(q.limit) || 10));

    const where: Prisma.FalhaAdquirenteWhereInput = {};
    if (q.tipo && TIPOS.includes(q.tipo)) where.tipo = q.tipo;
    if (q.contaProvedorId) {
      try {
        where.contaProvedorId = BigInt(q.contaProvedorId);
      } catch {
        throw new BadRequestException('contaProvedorId inválido');
      }
    }
    if (q.resultado === 'SALVA') where.resolvidaPorContaProvedorId = { not: null };
    if (q.resultado === 'PERDIDA') where.resolvidaPorContaProvedorId = null;
    if (q.desde) {
      const d = new Date(q.desde);
      if (!Number.isNaN(d.getTime())) where.criadoEm = { gte: d };
    }
    const busca = (q.busca ?? '').trim();
    if (busca) {
      where.OR = [
        { mensagem: { contains: busca, mode: 'insensitive' } },
        { codigoErro: { contains: busca, mode: 'insensitive' } },
        { transacao: { is: { referenciaExterna: { contains: busca } } } },
        { usuario: { is: { nomeRazaoSocial: { contains: busca, mode: 'insensitive' } } } },
      ];
    }

    const [total, itens] = await Promise.all([
      this.prisma.falhaAdquirente.count({ where }),
      this.prisma.falhaAdquirente.findMany({
        where,
        orderBy: { criadoEm: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          contaProvedor: { include: { provedor: true } },
          resolvidaPor: { include: { provedor: true } },
          usuario: { select: { idPublico: true, nomeRazaoSocial: true } },
          transacao: {
            select: { idTransacaoPublico: true, referenciaExterna: true, situacao: true },
          },
        },
      }),
    ]);

    return {
      pagina,
      limite,
      total,
      itens: itens.map((f) => ({
        idPublico: f.idPublico,
        tipo: f.tipo,
        ordemTentativa: f.ordemTentativa,
        mensagem: f.mensagem,
        statusHttp: f.statusHttp,
        codigoErro: f.codigoErro,
        latenciaMs: f.latenciaMs,
        criadoEm: f.criadoEm.toISOString(),
        adquirente: `${f.contaProvedor.provedor.nome} · ${f.contaProvedor.nome}`,
        contaProvedorId: f.contaProvedorId.toString(),
        // "Onde foi gerada a nova": null = a venda se perdeu.
        resolvidaPor: f.resolvidaPor
          ? `${f.resolvidaPor.provedor.nome} · ${f.resolvidaPor.nome}`
          : null,
        resolvidaEm: f.resolvidaEm?.toISOString() ?? null,
        cliente: f.usuario
          ? { idPublico: f.usuario.idPublico, nome: f.usuario.nomeRazaoSocial }
          : null,
        transacao: f.transacao
          ? {
              idTransacao: f.transacao.idTransacaoPublico,
              referenciaExterna: f.transacao.referenciaExterna,
              situacao: f.transacao.situacao,
            }
          : null,
      })),
    };
  }

  /** Detalhe com o response cru — o que se manda para a liquidante. */
  @Get('falhas/:idPublico')
  @RequerPermissao(PERMISSOES.ADMIN_CONTINGENCIA_VER)
  async falha(@Param('idPublico') idPublico: string) {
    const f = await this.prisma.falhaAdquirente.findUnique({
      where: { idPublico },
      include: {
        contaProvedor: { include: { provedor: true } },
        resolvidaPor: { include: { provedor: true } },
        usuario: { select: { idPublico: true, nomeRazaoSocial: true } },
        transacao: {
          select: {
            idTransacaoPublico: true,
            referenciaExterna: true,
            situacao: true,
            valorBruto: true,
          },
        },
      },
    });
    if (!f) throw new NotFoundException('Falha não encontrada');

    return {
      idPublico: f.idPublico,
      tipo: f.tipo,
      ordemTentativa: f.ordemTentativa,
      mensagem: f.mensagem,
      statusHttp: f.statusHttp,
      codigoErro: f.codigoErro,
      latenciaMs: f.latenciaMs,
      criadoEm: f.criadoEm.toISOString(),
      adquirente: `${f.contaProvedor.provedor.nome} · ${f.contaProvedor.nome}`,
      codigoAdquirente: f.contaProvedor.provedor.codigo,
      resolvidaPor: f.resolvidaPor
        ? `${f.resolvidaPor.provedor.nome} · ${f.resolvidaPor.nome}`
        : null,
      resolvidaEm: f.resolvidaEm?.toISOString() ?? null,
      cliente: f.usuario
        ? { idPublico: f.usuario.idPublico, nome: f.usuario.nomeRazaoSocial }
        : null,
      transacao: f.transacao
        ? {
            idTransacao: f.transacao.idTransacaoPublico,
            referenciaExterna: f.transacao.referenciaExterna,
            situacao: f.transacao.situacao,
            valor: f.transacao.valorBruto.toString(),
          }
        : null,
      dadosRequisicao: f.dadosRequisicao,
      dadosResposta: f.dadosResposta,
    };
  }
}
