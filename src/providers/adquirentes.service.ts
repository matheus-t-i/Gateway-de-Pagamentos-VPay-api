import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DISPONIBILIDADE_ADQUIRENTE, SITUACAO_PROVEDOR } from '../shared';

/** Adquirente como o LOJISTA a enxerga — sem conta, credencial ou custo. */
export type AdquirenteVitrine = {
  codigo: string;
  nome: string;
  temMed: boolean;
  observacao: string | null;
  emUso: boolean;
};

export type Substituicao = { usuarioIdPublico: string; adquirenteCodigo: string };

/**
 * Vitrine de adquirentes de PIX in: o que cada cliente pode escolher, quem está
 * usando o quê e a troca forçada quando o administrador tira uma de circulação.
 *
 * Concentra o que antes estava duplicado em `admin-usuarios.controller` e
 * `ops.controller` (o "achar conta ativa da adquirente X").
 */
@Injectable()
export class AdquirentesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Conta que efetivamente roteia o PIX in dessa adquirente. A vitrine é por
   * ADQUIRENTE, mas quem carrega credencial e custo é a conta — se houver mais
   * de uma habilitada, vale a mais antiga (`id asc`), como já era antes.
   */
  async resolverContaPixEntrada(codigo: string) {
    const conta = await this.prisma.contaProvedor.findFirst({
      where: {
        provedor: { codigo, situacao: SITUACAO_PROVEDOR.ATIVO, permitePixEntrada: true },
        situacao: SITUACAO_PROVEDOR.ATIVO,
        pixEntradaHabilitado: true,
      },
      orderBy: { id: 'asc' },
    });
    if (!conta) {
      throw new BadRequestException(
        `Adquirente ${codigo} não tem conta ativa habilitada para PIX in.`,
      );
    }
    return conta;
  }

  async resolverContaPixSaida(codigo: string) {
    const conta = await this.prisma.contaProvedor.findFirst({
      where: {
        provedor: { codigo, situacao: SITUACAO_PROVEDOR.ATIVO, permitePixSaida: true },
        situacao: SITUACAO_PROVEDOR.ATIVO,
        pixSaidaHabilitado: true,
      },
      orderBy: { id: 'asc' },
    });
    if (!conta) {
      throw new BadRequestException(
        `Adquirente ${codigo} não tem conta ativa habilitada para PIX out.`,
      );
    }
    return conta;
  }

  /** Filtro do que é elegível para vitrine: ativa, com PIX in e com conta pronta. */
  private get filtroElegivel(): Prisma.ProvedorPagamentoWhereInput {
    return {
      situacao: SITUACAO_PROVEDOR.ATIVO,
      permitePixEntrada: true,
      contas: {
        some: { situacao: SITUACAO_PROVEDOR.ATIVO, pixEntradaHabilitado: true },
      },
    };
  }

  /**
   * Adquirentes que ESTE cliente pode escolher: as abertas a todos mais as
   * liberadas nominalmente para ele.
   */
  async listarLiberadasPara(usuarioId: bigint): Promise<AdquirenteVitrine[]> {
    const [provedores, cfg] = await Promise.all([
      this.prisma.provedorPagamento.findMany({
        where: {
          ...this.filtroElegivel,
          OR: [
            { disponibilidadePixEntrada: DISPONIBILIDADE_ADQUIRENTE.TODOS },
            { liberacoes: { some: { usuarioId } } },
          ],
        },
        orderBy: { nome: 'asc' },
      }),
      this.prisma.configuracaoPixUsuario.findUnique({
        where: { usuarioId },
        include: { contaEntrada: { select: { provedorPagamentoId: true } } },
      }),
    ]);
    const emUsoId = cfg?.contaEntrada?.provedorPagamentoId ?? null;
    return provedores.map((p) => ({
      codigo: p.codigo,
      nome: p.nomeFantasia?.trim() || p.nome,
      temMed: p.temMed,
      observacao: p.observacaoCliente,
      emUso: emUsoId !== null && p.id === emUsoId,
    }));
  }

  /** A adquirente ainda está liberada para este cliente? */
  async estaLiberada(usuarioId: bigint, provedorPagamentoId: bigint): Promise<boolean> {
    const p = await this.prisma.provedorPagamento.findFirst({
      where: {
        id: provedorPagamentoId,
        ...this.filtroElegivel,
        OR: [
          { disponibilidadePixEntrada: DISPONIBILIDADE_ADQUIRENTE.TODOS },
          { liberacoes: { some: { usuarioId } } },
        ],
      },
      select: { id: true },
    });
    return !!p;
  }

  /**
   * Clientes cujo PIX in está apontando para esta adquirente hoje. É a lista que
   * o administrador PRECISA remanejar antes de tirá-la de circulação.
   */
  async clientesAfetados(codigo: string) {
    const configs = await this.prisma.configuracaoPixUsuario.findMany({
      where: { contaEntrada: { provedor: { codigo } } },
      include: {
        usuario: {
          select: { idPublico: true, nomeRazaoSocial: true, email: true, cpfCnpj: true },
        },
      },
      orderBy: { usuario: { nomeRazaoSocial: 'asc' } },
    });
    return configs.map((c) => ({
      idPublico: c.usuario.idPublico,
      nome: c.usuario.nomeRazaoSocial,
      email: c.usuario.email,
      cpfCnpj: c.usuario.cpfCnpj,
    }));
  }

  /** Alternativas válidas de PIX in, excluindo a adquirente que está saindo. */
  async alternativasPara(codigoExcluido: string) {
    const provedores = await this.prisma.provedorPagamento.findMany({
      where: { ...this.filtroElegivel, codigo: { not: codigoExcluido } },
      orderBy: { nome: 'asc' },
    });
    return provedores.map((p) => ({
      codigo: p.codigo,
      nome: p.nomeFantasia?.trim() || p.nome,
      disponibilidade: p.disponibilidadePixEntrada,
    }));
  }

  /**
   * Aplica as substituições de PIX in exigidas antes de tirar uma adquirente de
   * circulação. Roda DENTRO da transação da mudança: ou tudo remaneja e a
   * adquirente sai, ou nada acontece.
   *
   * Libera a adquirente destino para o cliente quando ela é ESPECIFICOS — senão
   * o remanejamento criaria exatamente o estado que ele existe para evitar (uma
   * conta apontando para adquirente que ela não pode usar).
   */
  async aplicarSubstituicoes(
    tx: Prisma.TransactionClient,
    codigoSaindo: string,
    substituicoes: Substituicao[],
    atorId: bigint,
  ) {
    const afetados = await tx.configuracaoPixUsuario.findMany({
      where: { contaEntrada: { provedor: { codigo: codigoSaindo } } },
      include: { usuario: { select: { idPublico: true, nomeRazaoSocial: true } } },
    });
    if (afetados.length === 0) return { remanejados: 0 };

    const porIdPublico = new Map(substituicoes.map((s) => [s.usuarioIdPublico, s]));
    const semDestino = afetados.filter((a) => !porIdPublico.has(a.usuario.idPublico));
    if (semDestino.length > 0) {
      throw new BadRequestException(
        'Escolha a nova adquirente de PIX in para: ' +
          semDestino.map((a) => a.usuario.nomeRazaoSocial).join(', '),
      );
    }

    for (const config of afetados) {
      const destino = porIdPublico.get(config.usuario.idPublico)!;
      if (destino.adquirenteCodigo === codigoSaindo) {
        throw new BadRequestException(
          'A adquirente substituta não pode ser a que está saindo de circulação.',
        );
      }
      const provedor = await tx.provedorPagamento.findUnique({
        where: { codigo: destino.adquirenteCodigo },
      });
      if (!provedor) {
        throw new BadRequestException(
          `Adquirente ${destino.adquirenteCodigo} não encontrada.`,
        );
      }
      const conta = await tx.contaProvedor.findFirst({
        where: {
          provedorPagamentoId: provedor.id,
          situacao: SITUACAO_PROVEDOR.ATIVO,
          pixEntradaHabilitado: true,
        },
        orderBy: { id: 'asc' },
      });
      if (
        !conta ||
        provedor.situacao !== SITUACAO_PROVEDOR.ATIVO ||
        !provedor.permitePixEntrada
      ) {
        throw new BadRequestException(
          `Adquirente ${destino.adquirenteCodigo} não está apta a receber PIX in.`,
        );
      }

      if (provedor.disponibilidadePixEntrada === DISPONIBILIDADE_ADQUIRENTE.ESPECIFICOS) {
        await tx.liberacaoAdquirenteUsuario.upsert({
          where: {
            provedorPagamentoId_usuarioId: {
              provedorPagamentoId: provedor.id,
              usuarioId: config.usuarioId,
            },
          },
          create: {
            provedorPagamentoId: provedor.id,
            usuarioId: config.usuarioId,
            liberadoPorUsuarioId: atorId,
          },
          update: {},
        });
      }

      await tx.configuracaoPixUsuario.update({
        where: { usuarioId: config.usuarioId },
        data: {
          contaProvedorPixEntradaId: conta.id,
          adquirentePixEntradaTrocadaEm: new Date(),
          atualizadoPorUsuarioId: atorId,
        },
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAfetadoId: config.usuarioId,
          usuarioAtorId: atorId,
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'ADQUIRENTE_SUBSTITUIR_PIX_ENTRADA',
          nomeTabela: 'configuracoes_pix_usuarios',
          chaveRegistro: config.usuarioId.toString(),
          dadosAnteriores: { adquirente: codigoSaindo },
          dadosNovos: { adquirente: destino.adquirenteCodigo },
        },
      });
    }
    return { remanejados: afetados.length };
  }
}
