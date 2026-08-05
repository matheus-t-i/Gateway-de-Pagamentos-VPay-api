import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PERMISSOES, SITUACAO_USUARIO } from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';

const { asc, desc } = Prisma.SortOrder;

const ORDENACOES: Record<string, Prisma.SaldoUsuarioOrderByWithRelationInput> = {
  disponivel: { saldoDisponivel: desc },
  pendente: { saldoPendenteLiberacao: desc },
  bloqueado: { saldoBloqueadoMed: desc },
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
  constructor(private readonly prisma: PrismaService) {}

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
      usuario.OR = [
        { nomeRazaoSocial: { contains: busca, mode: 'insensitive' } },
        { nomeFantasia: { contains: busca, mode: 'insensitive' } },
        { email: { contains: busca, mode: 'insensitive' } },
        { cpfCnpj: { contains: busca.replace(/[^0-9A-Za-z]/g, '') } },
      ];
    }

    const where: Prisma.SaldoUsuarioWhereInput = { usuario };
    // O padrão da tela é mostrar toda carteira aberta, inclusive zerada — senão
    // o cliente recém-ativado simplesmente não aparece.
    if (q.comSaldo === 'true') {
      where.OR = [
        { saldoDisponivel: { gt: 0 } },
        { saldoPendenteLiberacao: { gt: 0 } },
        { saldoReservado: { gt: 0 } },
        { saldoBloqueadoMed: { gt: 0 } },
      ];
    }

    const ordenar = q.ordenar && q.ordenar in ORDENACOES ? q.ordenar : 'disponivel';

    const [total, carteiras, somas] = await Promise.all([
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
        },
      }),
    ]);

    const soma = somas._sum;
    const totalGeral = (soma.saldoDisponivel ?? zero)
      .plus(soma.saldoPendenteLiberacao ?? zero)
      .plus(soma.saldoReservado ?? zero)
      .plus(soma.saldoBloqueadoMed ?? zero);

    return {
      pagina,
      limite,
      total,
      totais: {
        disponivel: (soma.saldoDisponivel ?? zero).toString(),
        pendenteLiberacao: (soma.saldoPendenteLiberacao ?? zero).toString(),
        reservado: (soma.saldoReservado ?? zero).toString(),
        bloqueadoMed: (soma.saldoBloqueadoMed ?? zero).toString(),
        total: totalGeral.toString(),
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
        total: c.saldoDisponivel
          .plus(c.saldoPendenteLiberacao)
          .plus(c.saldoReservado)
          .plus(c.saldoBloqueadoMed)
          .toString(),
        atualizadoEm: c.atualizadoEm.toISOString(),
      })),
    };
  }
}
