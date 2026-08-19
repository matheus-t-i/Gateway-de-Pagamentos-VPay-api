import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Decimal,
  money,
  SITUACAO_BLOQUEIO,
  TIPO_BLOQUEIO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';

/**
 * Bloqueio administrativo de saldo (calote/inadimplência do lojista).
 *
 * O admin bloqueia um VALOR, não um bucket: o que existir de disponível é
 * travado na hora e o restante (valorNaoCoberto) é capturado automaticamente
 * conforme o dinheiro chega ao disponível — liberação D+, liberação de reserva
 * e cash-in à vista. Assim "a liberar" e "reservado" ficam efetivamente
 * bloqueados sem mexer nos agendamentos de `liberacoes_saldo` (que continuam
 * rodando; o valor só não fica sacável).
 *
 * O desfecho é decisão do admin: LIBERAR devolve ao disponível; DEBITAR tira o
 * valor da carteira (compensação do prejuízo). Tudo pelo ledger, com chave de
 * idempotência — nunca por edição direta de saldo.
 */
@Injectable()
export class BloqueiosSaldoService {
  private readonly logger = new Logger(BloqueiosSaldoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  private mapear(b: {
    idPublico: string;
    valorSolicitado: unknown;
    valorBloqueado: unknown;
    valorNaoCoberto: unknown;
    motivo: string | null;
    situacao: string;
    bloqueadoEm: Date;
    encerradoEm: Date | null;
    usuario?: {
      idPublico: string;
      nomeRazaoSocial: string;
      cpfCnpj: string;
      email: string;
    };
  }) {
    return {
      idPublico: b.idPublico,
      valorSolicitado: String(b.valorSolicitado),
      valorBloqueado: String(b.valorBloqueado),
      valorNaoCoberto: String(b.valorNaoCoberto),
      motivo: b.motivo,
      situacao: b.situacao,
      bloqueadoEm: b.bloqueadoEm.toISOString(),
      encerradoEm: b.encerradoEm?.toISOString() ?? null,
      ...(b.usuario
        ? {
            cliente: {
              idPublico: b.usuario.idPublico,
              nome: b.usuario.nomeRazaoSocial,
              cpfCnpj: b.usuario.cpfCnpj,
              email: b.usuario.email,
            },
          }
        : {}),
    };
  }

  /** Cria o bloqueio e captura imediatamente o que houver de disponível. */
  async criar(params: {
    usuarioIdPublico: string;
    valor: string;
    motivo: string;
    atorId: bigint;
    enderecoIp?: string;
  }) {
    const valor = money(params.valor);
    if (!valor.isFinite() || valor.lte(0)) {
      throw new BadRequestException('Valor do bloqueio inválido.');
    }
    if (!params.motivo?.trim()) {
      throw new BadRequestException('Informe o motivo do bloqueio.');
    }
    const usuario = await this.prisma.usuario.findUnique({
      where: { idPublico: params.usuarioIdPublico },
      include: { saldo: true },
    });
    if (!usuario) throw new NotFoundException('Cliente não encontrado');
    if (!usuario.saldo) {
      throw new BadRequestException('Cliente ainda não tem carteira (conta nunca ativada).');
    }

    const bloqueio = await this.prisma.bloqueioSaldo.create({
      data: {
        usuarioId: usuario.id,
        tipo: TIPO_BLOQUEIO.MANUAL,
        valorSolicitado: valor.toFixed(2),
        valorNaoCoberto: valor.toFixed(2),
        motivo: params.motivo.trim(),
        situacao: SITUACAO_BLOQUEIO.ATIVO,
        criadoPorUsuarioId: params.atorId,
      },
    });

    await this.capturar(usuario.id, `criacao:${bloqueio.id}`);

    await this.prisma.registroAuditoria.create({
      data: {
        usuarioAtorId: params.atorId,
        usuarioAfetadoId: usuario.id,
        origem: 'PAINEL',
        operacao: 'ACAO_NEGOCIO',
        acao: 'SALDO_BLOQUEAR',
        nomeTabela: 'bloqueios_saldo',
        chaveRegistro: bloqueio.id.toString(),
        enderecoIp: params.enderecoIp,
        dadosNovos: {
          valorSolicitado: valor.toFixed(2),
          motivo: params.motivo.trim(),
        } as never,
      },
    });

    const atualizado = await this.prisma.bloqueioSaldo.findUniqueOrThrow({
      where: { id: bloqueio.id },
    });
    return this.mapear(atualizado);
  }

  /**
   * Captura disponível → bloqueado manual até cobrir os bloqueios ativos, em
   * ordem de criação (FIFO). Chamada na criação do bloqueio, após cada
   * liberação D+/reserva e após cash-in à vista. A `origem` identifica o evento
   * gatilho e entra na chave de idempotência — o mesmo evento nunca captura
   * duas vezes, mesmo com retry de job.
   */
  async capturar(usuarioId: bigint, origem: string) {
    const ativos = await this.prisma.bloqueioSaldo.findMany({
      where: {
        usuarioId,
        tipo: TIPO_BLOQUEIO.MANUAL,
        situacao: SITUACAO_BLOQUEIO.ATIVO,
        valorNaoCoberto: { gt: 0 },
      },
      orderBy: { criadoEm: 'asc' },
    });

    for (const b of ativos) {
      const saldo = await this.prisma.saldoUsuario.findUnique({
        where: { usuarioId },
      });
      const disponivel = money(saldo?.saldoDisponivel?.toString() ?? '0');
      const restante = money(b.valorNaoCoberto.toString());
      const mover = Decimal.min(disponivel, restante);
      // FIFO: sem disponível para o bloqueio mais antigo, os seguintes também esperam.
      if (mover.lte(0)) break;

      const chave = `bloqman:${b.id}:${origem}`;
      const jaAplicada = await this.prisma.movimentacaoSaldo.findUnique({
        where: { chaveIdempotencia: `${chave}:deb` },
      });
      if (jaAplicada) continue;

      // Débito no ledger + atualização do registro-fonte no MESMO commit. Com o
      // ledger em transação própria (sem `db`) e o update numa escrita separada,
      // uma falha entre os dois (deadlock/timeout/crash) deixava o saldo movido
      // para BLOQUEADO_MANUAL mas `valorBloqueado`/`valorNaoCoberto` intactos:
      // `liberar()` lia valor=0 e nunca soltava, o retry batia no dedupe `:deb`
      // e pulava o update, e um `origem` novo re-capturava (double capture).
      // Atômico, a falha do update reverte o débito junto — o dedupe `:deb`
      // some e a próxima execução refaz tudo corretamente.
      await this.prisma.$transaction(async (db) => {
        await this.ledger.aplicarMovimentacoes(
          {
            usuarioId,
            entries: [
              {
                tipoSaldo: 'DISPONIVEL',
                tipoMovimento: 'DEBITO',
                natureza: 'BLOQUEIO_MANUAL',
                valor: mover,
                chaveIdempotencia: `${chave}:deb`,
                descricao: 'Bloqueio administrativo de saldo',
              },
              {
                tipoSaldo: 'BLOQUEADO_MANUAL',
                tipoMovimento: 'CREDITO',
                natureza: 'BLOQUEIO_MANUAL',
                valor: mover,
                chaveIdempotencia: `${chave}:cred`,
                descricao: 'Bloqueio administrativo de saldo',
              },
            ],
          },
          db,
        );
        await db.bloqueioSaldo.update({
          where: { id: b.id },
          data: {
            valorBloqueado: { increment: mover.toFixed(2) as never },
            valorNaoCoberto: { decrement: mover.toFixed(2) as never },
          },
        });
      });
      this.logger.log(
        `bloqueio ${b.idPublico}: capturado ${mover.toFixed(2)} (${origem})`,
      );
    }
  }

  /**
   * Captura pós-evento de crédito, à prova de falha: erro aqui não pode
   * derrubar o job que creditou o saldo — a próxima entrada de dinheiro (ou o
   * próximo evento) captura o que ficou para trás.
   */
  async capturarSemFalhar(usuarioId: bigint, origem: string) {
    try {
      await this.capturar(usuarioId, origem);
    } catch (e) {
      this.logger.error(
        `captura de bloqueio falhou (usuario ${usuarioId}, ${origem}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Desfaz o bloqueio: o valor bloqueado volta ao disponível do cliente. */
  async liberar(params: {
    idPublico: string;
    atorId: bigint;
    motivo?: string;
    enderecoIp?: string;
  }) {
    const b = await this.buscarAtivo(params.idPublico);
    const valor = money(b.valorBloqueado.toString());

    if (valor.gt(0)) {
      await this.ledger.aplicarMovimentacoes({
        usuarioId: b.usuarioId,
        entries: [
          {
            tipoSaldo: 'BLOQUEADO_MANUAL',
            tipoMovimento: 'DEBITO',
            natureza: 'DESBLOQUEIO_MANUAL',
            valor,
            chaveIdempotencia: `bloqman:${b.id}:liberar:deb`,
            descricao: 'Liberação de bloqueio administrativo',
          },
          {
            tipoSaldo: 'DISPONIVEL',
            tipoMovimento: 'CREDITO',
            natureza: 'DESBLOQUEIO_MANUAL',
            valor,
            chaveIdempotencia: `bloqman:${b.id}:liberar:cred`,
            descricao: 'Liberação de bloqueio administrativo',
          },
        ],
      });
    }

    return this.encerrar(b, {
      situacao: SITUACAO_BLOQUEIO.LIBERADO,
      acao: 'SALDO_BLOQUEIO_LIBERAR',
      atorId: params.atorId,
      motivo: params.motivo,
      enderecoIp: params.enderecoIp,
      valorMovimentado: valor,
    });
  }

  /**
   * Debita o valor bloqueado — o dinheiro sai da carteira do cliente para
   * compensar o prejuízo (calote confirmado). Exige motivo.
   */
  async debitar(params: {
    idPublico: string;
    atorId: bigint;
    motivo: string;
    enderecoIp?: string;
  }) {
    if (!params.motivo?.trim()) {
      throw new BadRequestException('Informe o motivo do débito.');
    }
    const b = await this.buscarAtivo(params.idPublico);
    const valor = money(b.valorBloqueado.toString());
    if (valor.lte(0)) {
      throw new BadRequestException(
        'Nada capturado ainda neste bloqueio — não há o que debitar. Libere-o ou aguarde a captura.',
      );
    }

    await this.ledger.aplicarMovimentacoes({
      usuarioId: b.usuarioId,
      entries: [
        {
          tipoSaldo: 'BLOQUEADO_MANUAL',
          tipoMovimento: 'DEBITO',
          natureza: 'DEBITO_MANUAL',
          valor,
          chaveIdempotencia: `bloqman:${b.id}:debitar`,
          descricao: 'Débito de bloqueio administrativo',
        },
      ],
    });

    return this.encerrar(b, {
      situacao: SITUACAO_BLOQUEIO.DEBITADO,
      acao: 'SALDO_BLOQUEIO_DEBITAR',
      atorId: params.atorId,
      motivo: params.motivo,
      enderecoIp: params.enderecoIp,
      valorMovimentado: valor,
    });
  }

  async listar(q: {
    page?: string;
    limit?: string;
    situacao?: string;
    busca?: string;
  }) {
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(1000, Math.max(5, Number(q.limit) || 10));

    const where: Record<string, unknown> = { tipo: TIPO_BLOQUEIO.MANUAL };
    const situacoesValidas = Object.values(SITUACAO_BLOQUEIO) as string[];
    if (q.situacao && situacoesValidas.includes(q.situacao)) {
      where.situacao = q.situacao;
    }
    const busca = (q.busca ?? '').trim();
    if (busca) {
      const somenteDigitos = busca.replace(/\D/g, '');
      where.usuario = {
        OR: [
          { nomeRazaoSocial: { contains: busca, mode: 'insensitive' } },
          { email: { contains: busca, mode: 'insensitive' } },
          // `contains: ''` bate com qualquer registro no Prisma — só entra na
          // busca se sobrou pelo menos um dígito, senão a OR vira "todo mundo".
          ...(somenteDigitos ? [{ cpfCnpj: { contains: somenteDigitos } }] : []),
        ],
      };
    }

    const [total, itens] = await Promise.all([
      this.prisma.bloqueioSaldo.count({ where: where as never }),
      this.prisma.bloqueioSaldo.findMany({
        where: where as never,
        orderBy: { criadoEm: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          usuario: {
            select: {
              idPublico: true,
              nomeRazaoSocial: true,
              cpfCnpj: true,
              email: true,
            },
          },
        },
      }),
    ]);

    return {
      pagina,
      limite,
      total,
      itens: itens.map((b) => this.mapear(b)),
    };
  }

  private async buscarAtivo(idPublico: string) {
    const b = await this.prisma.bloqueioSaldo.findUnique({
      where: { idPublico },
    });
    if (!b || b.tipo !== TIPO_BLOQUEIO.MANUAL) {
      throw new NotFoundException('Bloqueio não encontrado');
    }
    if (b.situacao !== SITUACAO_BLOQUEIO.ATIVO) {
      throw new BadRequestException(
        `Bloqueio já encerrado (situação: ${b.situacao}).`,
      );
    }
    return b;
  }

  private async encerrar(
    b: { id: bigint; usuarioId: bigint },
    params: {
      situacao: string;
      acao: string;
      atorId: bigint;
      motivo?: string;
      enderecoIp?: string;
      valorMovimentado: Decimal;
    },
  ) {
    const atualizado = await this.prisma.$transaction(async (tx) => {
      const row = await tx.bloqueioSaldo.update({
        where: { id: b.id },
        data: {
          situacao: params.situacao,
          // O que não foi capturado deixa de ser perseguido — o desfecho encerra a cobrança.
          valorNaoCoberto: '0',
          encerradoEm: new Date(),
          encerradoPorUsuarioId: params.atorId,
        },
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAtorId: params.atorId,
          usuarioAfetadoId: b.usuarioId,
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: params.acao,
          nomeTabela: 'bloqueios_saldo',
          chaveRegistro: b.id.toString(),
          enderecoIp: params.enderecoIp,
          dadosNovos: {
            situacao: params.situacao,
            valor: params.valorMovimentado.toFixed(2),
            ...(params.motivo ? { motivo: params.motivo } : {}),
          } as never,
        },
      });
      return row;
    });
    return this.mapear(atualizado);
  }
}
