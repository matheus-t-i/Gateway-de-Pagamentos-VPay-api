import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import {
  EVENTOS_LOJISTA,
  money,
  MODO_TRATAMENTO_MED,
  SITUACAO_BLOQUEIO,
  SITUACAO_CASO_MED,
  SITUACAO_DEVOLUCAO,
  SITUACAO_TRANSACAO,
  TIPOS_EMAIL,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { BloqueiosSaldoService } from '../ledger/bloqueios-saldo.service';
import { QueuesService } from '../queues/queues.service';
import { getRastreio } from '../common/request-context';

/** Alias local — vocabulário oficial vive em shared/situacoes.ts. */
const SITUACAO_MED = SITUACAO_CASO_MED;

/**
 * Situações que ainda admitem decisão do analista.
 *
 * `DEBITADO` NÃO entra: quem debita é o modo `DEBITAR_IMEDIATAMENTE`, que existe
 * justamente para a conta sem análise — o caso já nasce encerrado e o dinheiro
 * já saiu. Deixá-lo decidível permitiria "aceitar" depois e debitar duas vezes.
 */
const DECIDIVEIS: string[] = [
  SITUACAO_MED.RECEBIDO,
  SITUACAO_MED.SALDO_BLOQUEADO,
  SITUACAO_MED.EM_ANALISE,
];

@Injectable()
export class MedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly configPix: ConfigPixService,
    private readonly bloqueios: BloqueiosSaldoService,
    private readonly queues: QueuesService,
  ) {}

  /** Saldo disponível atual do cliente (para calcular cobertura do bloqueio). */
  private async saldoDisponivel(usuarioId: bigint): Promise<Decimal> {
    const saldo = await this.prisma.saldoUsuario.findUnique({
      where: { usuarioId },
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
      include: { usuario: true },
    });
    if (!tx) throw new BadRequestException('Transação não encontrada');
    if (tx.direcao !== 'ENTRADA') {
      throw new BadRequestException('MED só se aplica a transações de entrada.');
    }

    const valor = money(params.valorSolicitado);
    if (valor.lte(0)) throw new BadRequestException('Valor inválido.');
    const valorBruto = money(tx.valorBruto.toString());
    if (valor.gt(valorBruto)) {
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

    /**
     * Teto ACUMULADO da venda: a soma dos MEDs vivos daquela transação não pode
     * passar do valor vendido.
     *
     * A validação de valor acima olha um caso por vez — dois avisos de MED com
     * identificadores DIFERENTES (o dedupe é por `chaveIdempotencia`) debitavam
     * o valor cheio DUAS vezes da mesma venda. Casos `RECUSADO` não contam: ali
     * o bloqueio foi desfeito e o dinheiro voltou ao lojista.
     *
     * Depois do dedupe de propósito: reentrega do MESMO aviso tem que continuar
     * devolvendo `duplicado: true`, e não 400 por "teto estourado" — o caso já
     * gravado entraria na própria soma.
     */
    const vivos = await this.prisma.casoMed.aggregate({
      where: { transacaoId: tx.id, situacao: { not: SITUACAO_MED.RECUSADO } },
      _sum: { valorSolicitado: true },
    });
    const jaContestado = money(vivos._sum.valorSolicitado?.toString() ?? '0');
    if (jaContestado.plus(valor).gt(valorBruto)) {
      throw new BadRequestException(
        `MED acima do saldo contestável da venda: já existem ${jaContestado.toFixed(2)} ` +
          `contestados de ${valorBruto.toFixed(2)}.`,
      );
    }

    const cfg = await this.configPix.resolverEfetiva(tx.usuarioId);
    const caso = await this.prisma.casoMed.create({
      data: {
        usuarioId: tx.usuarioId,
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

    if (cfg.modoTratamentoMed === MODO_TRATAMENTO_MED.BLOQUEAR_SALDO) {
      // Bloqueia só o que existe de saldo. O restante vira valorNaoCoberto —
      // travar tudo geraria saldo negativo e derrubaria a operação do cliente.
      const disponivel = await this.saldoDisponivel(tx.usuarioId);
      const bloquear = Decimal.min(valor, Decimal.max(disponivel, new Decimal(0)));
      const naoCoberto = valor.minus(bloquear);

      if (bloquear.gt(0)) {
        await this.ledger.aplicarMovimentacoes({
          usuarioId: tx.usuarioId,
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
          usuarioId: tx.usuarioId,
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
    } else if (cfg.modoTratamentoMed === MODO_TRATAMENTO_MED.DEBITAR_IMEDIATAMENTE) {
      // MED sem análise: o valor sai do disponível agora e o caso já nasce
      // ENCERRADO — a conta configurada assim não tem fila em `/admin/med`, e
      // por isso também não acumula saldo bloqueado por MED. A venda vira MED e
      // o lojista é avisado pelo callback, igual ao MED automático.
      const ledgerResult = await this.ledger.aplicarMovimentacoes({
        usuarioId: tx.usuarioId,
        // Sempre negativo-permitido: a adquirente já levou o dinheiro, então o
        // débito precisa sair mesmo com a conta zerada. Recusar aqui não
        // guardaria nada — só deixaria a perda inteira do nosso lado, com o job
        // falhando em retry infinito.
        permiteSaldoNegativo: true,
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
        outbox: {
          tipoAgregado: 'DEVOLUCAO_PIX',
          identificadorAgregado: tx.idTransacaoPublico,
          tipoEvento: EVENTOS_LOJISTA.PIX_DEVOLUCAO_CONCLUIDA,
          conteudo: {
            idTransacao: tx.idTransacaoPublico,
            valor: valor.toFixed(2),
            motivo: params.motivo ?? 'MED',
          },
        },
      });

      const agora = new Date();
      await this.prisma.$transaction(async (db) => {
        await db.casoMed.update({
          where: { id: caso.id },
          data: {
            situacao: SITUACAO_MED.DEBITADO,
            valorDebitado: valor.toFixed(2),
            decididoEm: agora,
            decididoPorUsuarioId: params.usuarioAtorId,
            encerradoEm: agora,
          },
        });
        await db.historicoCasoMed.create({
          data: {
            casoMedId: caso.id,
            situacaoAnterior: SITUACAO_MED.RECEBIDO,
            novaSituacao: SITUACAO_MED.DEBITADO,
            acao: 'DEBITO_IMEDIATO',
            origem: params.origem,
            usuarioAtorId: params.usuarioAtorId,
            motivo: 'Conta sem análise de MED — débito direto no saldo',
          },
        });
        if (tx.situacao !== SITUACAO_TRANSACAO.MED) {
          await db.transacao.update({
            where: { id: tx.id },
            data: { situacao: SITUACAO_TRANSACAO.MED },
          });
          await db.historicoSituacaoTransacao.create({
            data: {
              transacaoId: tx.id,
              situacaoAnterior: tx.situacao,
              novaSituacao: SITUACAO_TRANSACAO.MED,
              origem: params.origem,
              motivo: 'MED com débito imediato',
            },
          });
        }
      });

      if (ledgerResult.outboxId) {
        await this.queues.enqueueOutbox({
          eventoOutboxId: ledgerResult.outboxId.toString(),
          identificadorRastreio: getRastreio(),
        });
      }
      situacaoFinal = SITUACAO_MED.DEBITADO;
    } else {
      // Só existem BLOQUEAR_SALDO e DEBITAR_IMEDIATAMENTE — qualquer outro valor
      // é config corrompida (ex.: enum legado). Falha explícita em vez de criar
      // caso "só análise" sem tocar no saldo.
      throw new BadRequestException(
        `modoTratamentoMed inválido: ${cfg.modoTratamentoMed}`,
      );
    }

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.MED_RECEBIDO,
      para: tx.usuario.email,
      nome: tx.usuario.nomeRazaoSocial,
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
        usuario: true,
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
    const cfg = await this.configPix.resolverEfetiva(caso.usuarioId);

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
          usuarioId: caso.usuarioId,
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
        usuarioId: caso.usuarioId,
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
      // O valor voltou ao disponível: bloqueio administrativo ativo captura já.
      await this.bloqueios.capturarSemFalhar(caso.usuarioId, `medrecusa:${caso.id}`);
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
      para: caso.usuario.email,
      nome: caso.usuario.nomeRazaoSocial,
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
