import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import {
  money,
  SITUACAO_BLOQUEIO,
  SITUACAO_CASO_MED,
  SITUACAO_DEVOLUCAO,
  TIPOS_EMAIL,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { QueuesService } from '../queues/queues.service';
import { getRastreio } from '../common/request-context';

/** Alias local — vocabulário oficial vive em shared/situacoes.ts. */
const SITUACAO_MED = SITUACAO_CASO_MED;

/** Situações que ainda admitem decisão do analista. */
const DECIDIVEIS: string[] = [
  SITUACAO_MED.RECEBIDO,
  SITUACAO_MED.SALDO_BLOQUEADO,
  SITUACAO_MED.DEBITADO,
  SITUACAO_MED.EM_ANALISE,
];

@Injectable()
export class MedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly configPix: ConfigPixService,
    private readonly queues: QueuesService,
  ) {}

  /** Saldo disponível atual da empresa (para calcular cobertura do bloqueio). */
  private async saldoDisponivel(empresaId: bigint): Promise<Decimal> {
    const saldo = await this.prisma.saldoEmpresa.findUnique({
      where: { empresaId },
    });
    return money(saldo?.saldoDisponivel?.toString() ?? '0');
  }

  /**
   * Registra um caso MED e aplica o modo de tratamento configurado.
   * Idempotente pela chave do provedor.
   */
  async receber(params: {
    idTransacaoPublico: string;
    valorSolicitado: string;
    identificadorMedProvedor?: string;
    motivo?: string;
    webhookRecebidoId?: bigint;
    usuarioAtorId?: bigint;
    origem: 'ADMINISTRADOR' | 'WEBHOOK_PROVEDOR';
  }) {
    const tx = await this.prisma.transacao.findUnique({
      where: { idTransacaoPublico: params.idTransacaoPublico },
      include: { empresa: { include: { usuarioProprietario: true } } },
    });
    if (!tx) throw new BadRequestException('Transação não encontrada');
    if (tx.direcao !== 'ENTRADA') {
      throw new BadRequestException('MED só se aplica a transações de entrada.');
    }

    const valor = money(params.valorSolicitado);
    if (valor.lte(0)) throw new BadRequestException('Valor inválido.');
    if (valor.gt(money(tx.valorBruto.toString()))) {
      throw new BadRequestException(
        'Valor do MED maior que o valor da transação.',
      );
    }

    const chave =
      params.identificadorMedProvedor ??
      createHash('sha256')
        .update(`${tx.id}:${params.valorSolicitado}:${params.motivo ?? ''}`)
        .digest('hex');

    const existente = await this.prisma.casoMed.findUnique({
      where: { chaveIdempotencia: chave },
    });
    if (existente) {
      return { idPublico: existente.idPublico, situacao: existente.situacao, duplicado: true };
    }

    const cfg = await this.configPix.resolverEfetiva(tx.empresaId);
    const caso = await this.prisma.casoMed.create({
      data: {
        empresaId: tx.empresaId,
        transacaoId: tx.id,
        contaProvedorId: tx.contaProvedorId,
        webhookRecebidoId: params.webhookRecebidoId,
        identificadorMedProvedor: params.identificadorMedProvedor,
        chaveIdempotencia: chave,
        valorSolicitado: valor.toFixed(2),
        modoTratamentoAplicado: cfg.modoTratamentoMed,
        motivo: params.motivo,
        situacao: SITUACAO_MED.RECEBIDO,
        historicos: {
          create: {
            novaSituacao: SITUACAO_MED.RECEBIDO,
            acao: 'RECEBER_MED',
            origem: params.origem,
            usuarioAtorId: params.usuarioAtorId,
          },
        },
      },
    });

    if (!tx.primeiroMedRecebidoEm) {
      await this.prisma.transacao.update({
        where: { id: tx.id },
        data: { primeiroMedRecebidoEm: new Date() },
      });
    }

    let situacaoFinal: string = SITUACAO_MED.EM_ANALISE;

    if (cfg.modoTratamentoMed === 'BLOQUEAR_SALDO') {
      // Bloqueia só o que existe de saldo. O restante vira valorNaoCoberto —
      // travar tudo geraria saldo negativo e derrubaria a operação da empresa.
      const disponivel = await this.saldoDisponivel(tx.empresaId);
      const bloquear = Decimal.min(valor, Decimal.max(disponivel, new Decimal(0)));
      const naoCoberto = valor.minus(bloquear);

      if (bloquear.gt(0)) {
        await this.ledger.aplicarMovimentacoes({
          empresaId: tx.empresaId,
          entries: [
            {
              tipoSaldo: 'DISPONIVEL',
              tipoMovimento: 'DEBITO',
              natureza: 'BLOQUEIO_MED',
              valor: bloquear,
              chaveIdempotencia: `med:bloq:disp:${caso.id}`,
              casoMedId: caso.id,
              transacaoId: tx.id,
              descricao: 'Bloqueio por MED',
            },
            {
              tipoSaldo: 'BLOQUEADO_MED',
              tipoMovimento: 'CREDITO',
              natureza: 'BLOQUEIO_MED',
              valor: bloquear,
              chaveIdempotencia: `med:bloq:med:${caso.id}`,
              casoMedId: caso.id,
              transacaoId: tx.id,
              descricao: 'Bloqueio por MED',
            },
          ],
        });
      }

      await this.prisma.casoMed.update({
        where: { id: caso.id },
        data: {
          situacao: SITUACAO_MED.SALDO_BLOQUEADO,
          valorBloqueado: bloquear.toFixed(2),
          valorNaoCoberto: naoCoberto.toFixed(2),
        },
      });
      await this.prisma.bloqueioSaldo.create({
        data: {
          empresaId: tx.empresaId,
          casoMedId: caso.id,
          tipo: 'MED',
          valorSolicitado: valor.toFixed(2),
          valorBloqueado: bloquear.toFixed(2),
          valorNaoCoberto: naoCoberto.toFixed(2),
          situacao: SITUACAO_BLOQUEIO.ATIVO,
          criadoPorUsuarioId: params.usuarioAtorId,
        },
      });
      situacaoFinal = SITUACAO_MED.SALDO_BLOQUEADO;
    } else if (cfg.modoTratamentoMed === 'DEBITAR_IMEDIATAMENTE') {
      await this.ledger.aplicarMovimentacoes({
        empresaId: tx.empresaId,
        permiteSaldoNegativo: cfg.permiteSaldoNegativo,
        entries: [
          {
            tipoSaldo: 'DISPONIVEL',
            tipoMovimento: 'DEBITO',
            natureza: 'DEBITO_MED',
            valor,
            chaveIdempotencia: `med:deb:${caso.id}`,
            casoMedId: caso.id,
            transacaoId: tx.id,
            descricao: 'Débito imediato por MED',
          },
        ],
      });
      await this.prisma.casoMed.update({
        where: { id: caso.id },
        data: { situacao: SITUACAO_MED.DEBITADO, valorDebitado: valor.toFixed(2) },
      });
      situacaoFinal = SITUACAO_MED.DEBITADO;
    } else {
      await this.prisma.casoMed.update({
        where: { id: caso.id },
        data: { situacao: SITUACAO_MED.EM_ANALISE },
      });
    }

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.MED_RECEBIDO,
      para: tx.empresa.usuarioProprietario.email,
      nome: tx.empresa.usuarioProprietario.nomeRazaoSocial,
      dados: {
        valor: valor.toFixed(2),
        idTransacao: tx.idTransacaoPublico,
        modo: cfg.modoTratamentoMed,
      },
    });

    return {
      idPublico: caso.idPublico,
      situacao: situacaoFinal,
      modo: cfg.modoTratamentoMed,
      duplicado: false,
    };
  }

  /**
   * Decisão do analista — é AQUI que o dinheiro se resolve.
   *
   * ACEITO   → devolução ao pagador: o valor bloqueado sai de vez (e o que não
   *            estava bloqueado é debitado do disponível). Gera devolucao_pix.
   * RECUSADO → o bloqueio é desfeito e o valor volta ao disponível.
   *
   * Sem isto o saldo ficava preso em BLOQUEADO_MED indefinidamente.
   */
  async decidir(params: {
    idPublico: string;
    decisao: 'ACEITO' | 'RECUSADO';
    motivo?: string;
    usuarioAtorId: bigint;
  }) {
    const caso = await this.prisma.casoMed.findUnique({
      where: { idPublico: params.idPublico },
      include: {
        transacao: { select: { id: true, idTransacaoPublico: true } },
        empresa: { include: { usuarioProprietario: true } },
      },
    });
    if (!caso) throw new BadRequestException('Caso não encontrado');
    if (!DECIDIVEIS.includes(caso.situacao)) {
      throw new BadRequestException(
        `Caso já finalizado (situação: ${caso.situacao}).`,
      );
    }
    if (params.decisao === 'RECUSADO' && !params.motivo?.trim()) {
      throw new BadRequestException('Informe o motivo da recusa.');
    }

    const solicitado = money(caso.valorSolicitado.toString());
    const bloqueado = money(caso.valorBloqueado.toString());
    const jaDebitado = money(caso.valorDebitado.toString());
    const cfg = await this.configPix.resolverEfetiva(caso.empresaId);

    let devolucaoId: bigint | undefined;

    if (params.decisao === 'ACEITO') {
      const entries = [];
      // 1) o que estava bloqueado sai do saldo bloqueado
      if (bloqueado.gt(0)) {
        entries.push({
          tipoSaldo: 'BLOQUEADO_MED' as const,
          tipoMovimento: 'DEBITO' as const,
          natureza: 'DEBITO_MED' as const,
          valor: bloqueado,
          chaveIdempotencia: `med:aceite:bloq:${caso.id}`,
          casoMedId: caso.id,
          transacaoId: caso.transacaoId,
          descricao: 'MED aceito — devolução ao pagador',
        });
      }
      // 2) a parte não coberta pelo bloqueio sai do disponível
      const restante = solicitado.minus(bloqueado).minus(jaDebitado);
      if (restante.gt(0)) {
        entries.push({
          tipoSaldo: 'DISPONIVEL' as const,
          tipoMovimento: 'DEBITO' as const,
          natureza: 'DEBITO_MED' as const,
          valor: restante,
          chaveIdempotencia: `med:aceite:disp:${caso.id}`,
          casoMedId: caso.id,
          transacaoId: caso.transacaoId,
          descricao: 'MED aceito — parcela não bloqueada',
        });
      }
      if (entries.length > 0) {
        await this.ledger.aplicarMovimentacoes({
          empresaId: caso.empresaId,
          permiteSaldoNegativo: cfg.permiteSaldoNegativo,
          entries,
        });
      }

      const devolucao = await this.prisma.devolucaoPix.create({
        data: {
          transacaoId: caso.transacaoId,
          casoMedId: caso.id,
          solicitadoPorUsuarioId: params.usuarioAtorId,
          valor: solicitado.toFixed(2),
          motivo: params.motivo ?? caso.motivo,
          situacao: SITUACAO_DEVOLUCAO.PENDENTE,
        },
      });
      devolucaoId = devolucao.id;
      // Efetivação na liquidante roda no worker (fila 9), com retentativas.
      await this.queues.enqueueDevolucaoPix({
        devolucaoId: devolucao.id.toString(),
        identificadorRastreio: getRastreio(),
      });
    } else if (bloqueado.gt(0)) {
      // RECUSADO: devolve o bloqueio ao disponível.
      await this.ledger.aplicarMovimentacoes({
        empresaId: caso.empresaId,
        entries: [
          {
            tipoSaldo: 'BLOQUEADO_MED',
            tipoMovimento: 'DEBITO',
            natureza: 'DESBLOQUEIO_MED',
            valor: bloqueado,
            chaveIdempotencia: `med:recusa:bloq:${caso.id}`,
            casoMedId: caso.id,
            transacaoId: caso.transacaoId,
            descricao: 'MED recusado — desbloqueio',
          },
          {
            tipoSaldo: 'DISPONIVEL',
            tipoMovimento: 'CREDITO',
            natureza: 'DESBLOQUEIO_MED',
            valor: bloqueado,
            chaveIdempotencia: `med:recusa:disp:${caso.id}`,
            casoMedId: caso.id,
            transacaoId: caso.transacaoId,
            descricao: 'MED recusado — devolução ao disponível',
          },
        ],
      });
    }
    // Observação: se o modo era DEBITAR_IMEDIATAMENTE e o MED é recusado, o
    // valor já saiu; o estorno é decisão comercial e fica registrado no caso.

    await this.prisma.$transaction(async (tx) => {
      await tx.casoMed.update({
        where: { id: caso.id },
        data: {
          situacao: params.decisao,
          decididoEm: new Date(),
          decididoPorUsuarioId: params.usuarioAtorId,
          encerradoEm: new Date(),
          motivo: params.motivo ?? caso.motivo,
          ...(params.decisao === 'ACEITO'
            ? { valorDebitado: solicitado.toFixed(2) }
            : { valorBloqueado: '0' }),
        },
      });
      await tx.bloqueioSaldo.updateMany({
        where: { casoMedId: caso.id, situacao: SITUACAO_BLOQUEIO.ATIVO },
        data: { situacao: SITUACAO_BLOQUEIO.ENCERRADO, encerradoEm: new Date() },
      });
      await tx.historicoCasoMed.create({
        data: {
          casoMedId: caso.id,
          situacaoAnterior: caso.situacao,
          novaSituacao: params.decisao,
          acao: 'DECISAO_MANUAL',
          origem: 'ADMINISTRADOR',
          usuarioAtorId: params.usuarioAtorId,
          motivo: params.motivo,
        },
      });
    });

    await this.queues.enqueueEmail({
      tipo:
        params.decisao === 'ACEITO'
          ? TIPOS_EMAIL.MED_ACEITO
          : TIPOS_EMAIL.MED_RECUSADO,
      para: caso.empresa.usuarioProprietario.email,
      nome: caso.empresa.usuarioProprietario.nomeRazaoSocial,
      dados: {
        valor: solicitado.toFixed(2),
        idTransacao: caso.transacao.idTransacaoPublico,
        ...(params.motivo ? { motivo: params.motivo } : {}),
      },
    });

    return {
      ok: true,
      situacao: params.decisao,
      devolucaoCriada: devolucaoId ? true : false,
    };
  }
}
