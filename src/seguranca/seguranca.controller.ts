import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSOES, recorteFiltroData } from '../shared';

/** Rotas sensíveis monitoradas, na ordem em que aparecem no filtro da tela. */
const ROTAS_SENSIVEIS = [
  { valor: '/v1/auth/token', rotulo: 'Emissão de token' },
  { valor: '/v1/pix/cobrancas', rotulo: 'Criar cobrança' },
  { valor: '/v1/pix/saques', rotulo: 'Criar saque' },
  { valor: '/v1/pix/transacoes', rotulo: 'Consultar transação' },
  { valor: '/v1/saldo', rotulo: 'Consultar saldo' },
] as const;

/**
 * Trilha de segurança da API pública.
 *
 * Leitura pura sobre `registros_acesso_api` — nada aqui altera estado. O
 * escopo é global por natureza (é vigilância da plataforma inteira), então
 * exige `admin.seguranca.ver`.
 */
@Controller('admin/seguranca')
@UseGuards(JwtAuthGuard)
export class SegurancaController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('rotas')
  @RequerPermissao(PERMISSOES.ADMIN_SEGURANCA_VER)
  rotas() {
    return { rotas: ROTAS_SENSIVEIS };
  }

  /**
   * Contadores do período — o que a tela mostra antes da lista, para a pessoa
   * saber se precisa olhar a lista.
   */
  @Get('resumo')
  @RequerPermissao(PERMISSOES.ADMIN_SEGURANCA_VER)
  async resumo(@Query() q: Record<string, string>) {
    const where = this.montarWhere(q);

    const [total, falhas, porStatus, ipsTop, naoAutorizados] = await Promise.all([
      this.prisma.registroAcessoApi.count({ where }),
      this.prisma.registroAcessoApi.count({ where: { ...where, sucesso: false } }),
      this.prisma.registroAcessoApi.groupBy({
        by: ['statusHttp'],
        where,
        _count: { _all: true },
        orderBy: { _count: { statusHttp: 'desc' } },
        take: 10,
      }),
      /**
       * IPs que mais FALHARAM (não os que mais chamaram): quem erra em rajada
       * é o sinal de varredura/força bruta; quem chama muito e acerta é só um
       * cliente movimentado.
       */
      this.prisma.registroAcessoApi.groupBy({
        by: ['enderecoIp'],
        where: { ...where, sucesso: false },
        _count: { _all: true },
        orderBy: { _count: { enderecoIp: 'desc' } },
        take: 5,
      }),
      this.prisma.registroAcessoApi.count({
        where: { ...where, statusHttp: { in: [401, 403] } },
      }),
    ]);

    return {
      total,
      falhas,
      naoAutorizados,
      taxaFalha: total > 0 ? Number((falhas / total).toFixed(4)) : 0,
      porStatus: porStatus.map((s) => ({
        status: s.statusHttp,
        quantidade: s._count._all,
      })),
      ipsComMaisFalhas: ipsTop
        .filter((i) => i.enderecoIp)
        .map((i) => ({ ip: i.enderecoIp, falhas: i._count._all })),
    };
  }

  @Get('acessos')
  @RequerPermissao(PERMISSOES.ADMIN_SEGURANCA_VER)
  async acessos(@Query() q: Record<string, string>) {
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(1000, Math.max(5, Number(q.limit) || 10));
    const where = this.montarWhere(q);

    const [total, itens] = await Promise.all([
      this.prisma.registroAcessoApi.count({ where }),
      this.prisma.registroAcessoApi.findMany({
        where,
        orderBy: { criadoEm: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          credencial: { select: { nome: true, chavePublica: true } },
          usuario: { select: { nomeRazaoSocial: true, email: true } },
        },
      }),
    ]);

    return {
      pagina,
      limite,
      total,
      itens: itens.map((r) => ({
        id: r.id.toString(),
        criadoEm: r.criadoEm,
        metodo: r.metodo,
        caminho: r.caminho,
        statusHttp: r.statusHttp,
        sucesso: r.sucesso,
        codigoErro: r.codigoErro,
        mensagemErro: r.mensagemErro,
        latenciaMs: r.latenciaMs,
        enderecoIp: r.enderecoIp,
        agenteUsuario: r.agenteUsuario,
        identificadorRastreio: r.identificadorRastreio,
        // A chave da credencial resolvida vale mais que a tentada; sem
        // credencial (401), sobra a que foi apresentada.
        chavePublica: r.credencial?.chavePublica ?? r.chavePublica,
        credencialNome: r.credencial?.nome ?? null,
        cliente: r.usuario?.nomeRazaoSocial ?? null,
        clienteEmail: r.usuario?.email ?? null,
      })),
    };
  }

  private montarWhere(q: Record<string, string>) {
    const where: Record<string, unknown> = {};

    const periodo = recorteFiltroData(q.dataInicial, q.dataFinal);
    if (periodo) where.criadoEm = periodo;

    // "Só falhas" é o modo de trabalho normal desta tela.
    if (q.resultado === 'falha') where.sucesso = false;
    if (q.resultado === 'sucesso') where.sucesso = true;

    const status = Number(q.status);
    if (Number.isFinite(status) && status > 0) where.statusHttp = status;

    // `startsWith` porque a consulta de transação carrega o id no caminho.
    if (q.rota) where.caminho = { startsWith: q.rota };

    if (q.ip) where.enderecoIp = { contains: q.ip.trim() };

    if (q.busca) {
      const b = q.busca.trim();
      where.OR = [
        { chavePublica: { contains: b, mode: 'insensitive' } },
        { mensagemErro: { contains: b, mode: 'insensitive' } },
        { codigoErro: { contains: b, mode: 'insensitive' } },
        { identificadorRastreio: { contains: b, mode: 'insensitive' } },
        { credencial: { is: { nome: { contains: b, mode: 'insensitive' } } } },
        {
          usuario: {
            is: {
              OR: [
                { nomeRazaoSocial: { contains: b, mode: 'insensitive' } },
                { email: { contains: b, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }

    return where;
  }
}
