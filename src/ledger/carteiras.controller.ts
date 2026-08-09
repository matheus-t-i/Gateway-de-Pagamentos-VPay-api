import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PERMISSOES, SITUACAO_LIBERACAO, SITUACAO_USUARIO } from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { BloqueiosSaldoService } from './bloqueios-saldo.service';
import { assertStepUpTotp } from '../common/step-up-totp';

const stepUpBody = z.object({
  codigoTotp: z.string().regex(/^\d{6}$/),
  valor: z.string().optional(),
  motivo: z.string().optional(),
});

type ReqAdmin = { user: { id: string }; ip?: string };

const { asc, desc } = Prisma.SortOrder;

const ORDENACOES: Record<string, Prisma.SaldoUsuarioOrderByWithRelationInput> = {
  disponivel: { saldoDisponivel: desc },
  /** Maior dívida primeiro — o disponível mais negativo. */
  devedor: { saldoDisponivel: asc },
  pendente: { saldoPendenteLiberacao: desc },
  bloqueado: { saldoBloqueadoMed: desc },
  bloqueadoManual: { saldoBloqueadoManual: desc },
  razaoSocial: { usuario: { nomeRazaoSocial: asc } },
  recentes: { usuario: { criadoEm: desc } },
};

const zero = new Prisma.Decimal(0);

/**
 * Carteiras dos clientes — leitura de `saldos_usuarios`, o dinheiro DO LOJISTA.
 *
 * Não confundir com `/admin/tesouraria/saldos`, que é o saldo da VPay nas
 * adquirentes. São caixas distintos: um cliente com R$ 10 mil disponível não
 * significa R$ 10 mil parados na adquirente, e vice-versa.
 *
 * A consulta parte de `saldos_usuarios` (e não de `usuarios`) porque a carteira
 * só existe a partir da ativação: partindo do usuário, o LEFT JOIN devolve NULL
 * para quem nunca foi ativado e o Postgres joga esses NULLs para o TOPO na
 * ordenação por valor — a tela abriria com carteira vazia em primeiro lugar.
 *
 * Somente leitura de propósito: saldo só se move pelo ledger (transação, MED,
 * saque), nunca por edição manual em tela.
 */
@Controller('admin/carteiras')
@UseGuards(JwtAuthGuard)
export class CarteirasController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bloqueios: BloqueiosSaldoService,
  ) {}

  @Get()
  @RequerPermissao(PERMISSOES.ADMIN_CARTEIRAS_VER)
  async listar(@Query() q: Record<string, string>) {
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(1000, Math.max(5, Number(q.limit) || 10));

    const usuario: Prisma.UsuarioWhereInput = {};
    const situacoesValidas = Object.values(SITUACAO_USUARIO) as string[];
    if (q.situacao && situacoesValidas.includes(q.situacao)) {
      usuario.situacao = q.situacao as never;
    }
    const busca = (q.busca ?? '').trim();
    if (busca) {
      const documentoBusca = busca.replace(/[^0-9A-Za-z]/g, '');
      usuario.OR = [
        { nomeRazaoSocial: { contains: busca, mode: 'insensitive' } },
        { nomeFantasia: { contains: busca, mode: 'insensitive' } },
        { email: { contains: busca, mode: 'insensitive' } },
        // `contains: ''` bate com qualquer registro no Prisma — só entra na
        // busca se sobrou algo depois de tirar a pontuação.
        ...(documentoBusca ? [{ cpfCnpj: { contains: documentoBusca } }] : []),
      ];
    }

    const where: Prisma.SaldoUsuarioWhereInput = { usuario };
    // O padrão da tela é mostrar toda carteira aberta, inclusive zerada — senão
    // o cliente recém-ativado simplesmente não aparece.
    if (q.comSaldo === 'true') {
      where.OR = [
        { saldoDisponivel: { gt: 0 } },
        // Conta DEVENDO também tem movimento: filtrar só por `> 0` escondia
        // exatamente quem o financeiro mais precisa achar.
        { saldoDisponivel: { lt: 0 } },
        { saldoPendenteLiberacao: { gt: 0 } },
        { saldoReservado: { gt: 0 } },
        { saldoBloqueadoMed: { gt: 0 } },
        { saldoBloqueadoManual: { gt: 0 } },
      ];
    }
    /** Só quem está no vermelho (dívida de MED debitado sem saldo). */
    if (q.devedores === 'true') where.saldoDisponivel = { lt: 0 };

    const ordenar = q.ordenar && q.ordenar in ORDENACOES ? q.ordenar : 'disponivel';

    const [total, carteiras, somas, devedores, liberacoesTravadas] = await Promise.all([
      this.prisma.saldoUsuario.count({ where }),
      this.prisma.saldoUsuario.findMany({
        where,
        // Desempate por razão social mantém a paginação estável quando várias
        // carteiras têm o mesmo valor (o caso comum: todas zeradas).
        orderBy: [ORDENACOES[ordenar], { usuario: { nomeRazaoSocial: asc } }],
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          usuario: {
            select: {
              idPublico: true,
              nomeRazaoSocial: true,
              nomeFantasia: true,
              cpfCnpj: true,
              tipoPessoa: true,
              situacao: true,
              email: true,
            },
          },
        },
      }),
      // Totais do filtro inteiro, não só da página — é o número que o
      // financeiro precisa (passivo total com os lojistas).
      this.prisma.saldoUsuario.aggregate({
        where,
        _sum: {
          saldoDisponivel: true,
          saldoPendenteLiberacao: true,
          saldoReservado: true,
          saldoBloqueadoMed: true,
          saldoBloqueadoManual: true,
        },
      }),
      /**
       * Contas no vermelho — o que o cliente deve à VPay.
       *
       * Fora do filtro de carteira de propósito: é alerta, tem que aparecer
       * mesmo com a tela filtrada em outra coisa. No somatório de "Disponível"
       * o negativo se dilui no positivo dos outros e ninguém vê a dívida.
       */
      this.prisma.saldoUsuario.aggregate({
        where: { usuario, saldoDisponivel: { lt: 0 } },
        _sum: { saldoDisponivel: true },
        _count: true,
      }),
      /**
       * Liberações D+/reserva que não completaram: dinheiro do lojista parado
       * em `PENDENTE_LIBERACAO`/`RESERVADO` sem ninguém saber. A fila 6
       * reprocessa sozinha até um teto — o que aparece aqui já passou disso ou
       * está no meio do caminho.
       */
      this.prisma.liberacaoSaldo.aggregate({
        where: { situacao: SITUACAO_LIBERACAO.FALHA },
        _sum: { valor: true },
        _count: true,
      }),
    ]);

    const soma = somas._sum;
    const totalGeral = (soma.saldoDisponivel ?? zero)
      .plus(soma.saldoPendenteLiberacao ?? zero)
      .plus(soma.saldoReservado ?? zero)
      .plus(soma.saldoBloqueadoMed ?? zero)
      .plus(soma.saldoBloqueadoManual ?? zero);

    return {
      pagina,
      limite,
      total,
      totais: {
        disponivel: (soma.saldoDisponivel ?? zero).toString(),
        pendenteLiberacao: (soma.saldoPendenteLiberacao ?? zero).toString(),
        reservado: (soma.saldoReservado ?? zero).toString(),
        bloqueadoMed: (soma.saldoBloqueadoMed ?? zero).toString(),
        bloqueadoManual: (soma.saldoBloqueadoManual ?? zero).toString(),
        total: totalGeral.toString(),
      },
      /** Alerta: contas devendo (valor positivo = tamanho da dívida). */
      devedores: {
        quantidade: devedores._count,
        total: (devedores._sum.saldoDisponivel ?? zero).abs().toString(),
      },
      /** Alerta: liberações que não completaram (dinheiro parado). */
      liberacoesTravadas: {
        quantidade: liberacoesTravadas._count,
        total: (liberacoesTravadas._sum.valor ?? zero).toString(),
      },
      itens: carteiras.map((c) => ({
        idPublico: c.usuario.idPublico,
        razaoSocial: c.usuario.nomeRazaoSocial,
        nomeFantasia: c.usuario.nomeFantasia,
        cpfCnpj: c.usuario.cpfCnpj,
        tipoPessoa: c.usuario.tipoPessoa,
        situacao: c.usuario.situacao,
        email: c.usuario.email,
        disponivel: c.saldoDisponivel.toString(),
        pendenteLiberacao: c.saldoPendenteLiberacao.toString(),
        reservado: c.saldoReservado.toString(),
        bloqueadoMed: c.saldoBloqueadoMed.toString(),
        bloqueadoManual: c.saldoBloqueadoManual.toString(),
        total: c.saldoDisponivel
          .plus(c.saldoPendenteLiberacao)
          .plus(c.saldoReservado)
          .plus(c.saldoBloqueadoMed)
          .plus(c.saldoBloqueadoManual)
          .toString(),
        atualizadoEm: c.atualizadoEm.toISOString(),
      })),
    };
  }

  // ------- Bloqueio administrativo de saldo (calote/inadimplência) -------

  /** Fila de bloqueios manuais (não inclui os de MED — esses vivem em /admin/med). */
  @Get('bloqueios')
  @RequerPermissao(PERMISSOES.ADMIN_CARTEIRAS_VER)
  async listarBloqueios(@Query() q: Record<string, string>) {
    return this.bloqueios.listar(q);
  }

  @Post(':idPublico/bloqueios')
  @RequerPermissao(PERMISSOES.ADMIN_CARTEIRAS_EXECUTAR)
  async bloquear(
    @Param('idPublico') idPublico: string,
    @Body() body: unknown,
    @Req() req: ReqAdmin,
  ) {
    const parsed = stepUpBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    return this.bloqueios.criar({
      usuarioIdPublico: idPublico,
      valor: String(parsed.data.valor ?? ''),
      motivo: String(parsed.data.motivo ?? ''),
      atorId: BigInt(req.user.id),
      enderecoIp: req.ip,
    });
  }

  @Post('bloqueios/:idPublico/liberar')
  @RequerPermissao(PERMISSOES.ADMIN_CARTEIRAS_EXECUTAR)
  async liberarBloqueio(
    @Param('idPublico') idPublico: string,
    @Body() body: unknown,
    @Req() req: ReqAdmin,
  ) {
    const parsed = stepUpBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    return this.bloqueios.liberar({
      idPublico,
      atorId: BigInt(req.user.id),
      motivo: parsed.data.motivo,
      enderecoIp: req.ip,
    });
  }

  @Post('bloqueios/:idPublico/debitar')
  @RequerPermissao(PERMISSOES.ADMIN_CARTEIRAS_EXECUTAR)
  async debitarBloqueio(
    @Param('idPublico') idPublico: string,
    @Body() body: unknown,
    @Req() req: ReqAdmin,
  ) {
    const parsed = stepUpBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    return this.bloqueios.debitar({
      idPublico,
      atorId: BigInt(req.user.id),
      motivo: String(parsed.data.motivo ?? ''),
      enderecoIp: req.ip,
    });
  }
}
