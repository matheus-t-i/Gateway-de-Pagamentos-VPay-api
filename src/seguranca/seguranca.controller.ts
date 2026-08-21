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
 * Assinatura de varredura: 404 do ROTEADOR (rota que não existe), distinto do
 * 404 de negócio. Rota desconhecida responde com a mensagem fixa do Nest
 * ("Cannot GET /api/…") — nenhuma mensagem nossa começa assim (erro de negócio
 * é redigido em português). Classificado na LEITURA de propósito: vale
 * igualmente para as linhas gravadas antes desta mudança, sem migration.
 */
const ROTA_INEXISTENTE = {
  statusHttp: 404,
  mensagemErro: { startsWith: 'Cannot ' },
} as const;

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

    const [total, falhas, varredura, porStatus, ipsTop, naoAutorizados] = await Promise.all([
      this.prisma.registroAcessoApi.count({ where }),
      this.prisma.registroAcessoApi.count({ where: { ...where, sucesso: false } }),
      // AND, e não spread: um filtro de status vindo da querystring não pode
      // ser sobrescrito pelo 404 da assinatura.
      this.prisma.registroAcessoApi.count({ where: { AND: [where, ROTA_INEXISTENTE] } }),
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

    /**
     * Varredura fora da conta de recusa: 404 de rota que nem existe não diz
     * nada sobre a saúde das integrações — é scanner batendo na porta. Sem a
     * separação, 4 minutos de varredura jogaram a taxa a 38% e o número parou
     * de servir para o que existe: denunciar integração doente.
     */
    const recusadas = falhas - varredura;
    const chamadasReais = total - varredura;

    return {
      total,
      falhas: recusadas,
      rotasInexistentes: varredura,
      naoAutorizados,
      taxaFalha: chamadasReais > 0 ? Number((recusadas / chamadasReais).toFixed(4)) : 0,
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

    /**
     * Dono da chave APRESENTADA, para as linhas sem identidade provada.
     *
     * Cobre o que o gancho de auditoria não alcança: rota inexistente (a
     * varredura nem chega à autenticação) e segredo errado. Era o buraco que
     * deixava a pergunta central de um incidente sem resposta — "de quem é a
     * chave que o scanner está usando?" — - com a tela mostrando só o prefixo.
     *
     * ⚠️ Vai num campo SEPARADO e a tela rotula como não confirmado: a chave
     * pública não é segredo (aparece no painel do lojista), então qualquer um
     * pode apresentar a chave de outro. Afirmar que o dono FEZ a chamada seria
     * atribuir a um cliente uma requisição que pode não ser dele.
     */
    const chavesSemDono = Array.from(
      new Set(
        itens
          .filter((r) => !r.usuario && r.chavePublica)
          .map((r) => r.chavePublica as string),
      ),
    );
    const donosApresentados = new Map<string, string>();
    if (chavesSemDono.length) {
      const creds = await this.prisma.credencialApi.findMany({
        where: { chavePublica: { in: chavesSemDono } },
        select: {
          chavePublica: true,
          usuario: { select: { nomeRazaoSocial: true } },
        },
      });
      for (const c of creds) {
        if (c.usuario?.nomeRazaoSocial) {
          donosApresentados.set(c.chavePublica, c.usuario.nomeRazaoSocial);
        }
      }
    }

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
        // Só quando NÃO houve identificação provada — nunca os dois juntos.
        donoChaveApresentada: r.usuario
          ? null
          : (r.chavePublica && donosApresentados.get(r.chavePublica)) || null,
      })),
    };
  }

  private montarWhere(q: Record<string, string>) {
    const where: Record<string, unknown> = {};

    const periodo = recorteFiltroData(q.dataInicial, q.dataFinal);
    if (periodo) where.criadoEm = periodo;

    // Status ANTES do resultado: `varredura` fixa statusHttp:404 e precisa ser
    // a última palavra sobre o status, senão `?resultado=varredura&status=401`
    // montava um where impossível (404 da assinatura sobrescrito por 401) e a
    // tela vinha vazia sem explicar por quê.
    const status = Number(q.status);
    if (Number.isFinite(status) && status > 0) where.statusHttp = status;

    // "Só recusadas" é o modo de trabalho normal desta tela — e mostra recusa
    // de INTEGRAÇÃO: varredura (rota inexistente) tem filtro próprio, como nos
    // cartões, senão o ruído do scanner soterra o erro de cliente real.
    if (q.resultado === 'falha') {
      where.sucesso = false;
      where.NOT = ROTA_INEXISTENTE;
    }
    if (q.resultado === 'sucesso') where.sucesso = true;
    // `varredura` é 404 por definição — vence um `status` conflitante da query.
    if (q.resultado === 'varredura') Object.assign(where, ROTA_INEXISTENTE);

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
