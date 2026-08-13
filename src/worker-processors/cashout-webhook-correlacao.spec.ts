import { SITUACAO_PROVEDOR, SITUACAO_TENTATIVA, SITUACAO_TRANSACAO } from '../shared';
import { PixWebhookCashoutProcessor } from './pix-webhook-cashout.processor';

jest.mock('../common/crypto.util', () => ({
  decryptCredentials: () => ({}),
}));

/**
 * Caso REAL de produção (13/08/2026, saque de R$ 10 pago pela Valorion):
 *
 * A Valorion tem DOIS ids no cash-out. O `create` devolve o id da ORDEM
 * (`idTransaction`, igual ao `externalreference` dela) e só o webhook traz o
 * id da LIQUIDAÇÃO (`idtransaction`) — o único que a consulta de status
 * aceita; o da ordem responde 404. Como gravamos o que o create deu, o
 * matcher procurava o id da liquidação e não achava nada: o PIX saiu, o
 * lojista recebeu, e a transação morria em PROCESSANDO com o saldo debitado.
 */
describe('PixWebhookCashoutProcessor — id de ordem × id de liquidação', () => {
  const idDaOrdem = '74f6813b-e2c5-418f-8c7f-d0a1644f1566';
  const idDaLiquidacao = '9a4a3392-819b-4fda-b959-12528476dcc7';

  function montar(opts?: { situacao?: string }) {
    const tentativa = {
      id: 10n,
      idTransacaoLiquidante: idDaOrdem,
      situacao: SITUACAO_TENTATIVA.SUCESSO,
      concluidoEm: new Date(),
      transacao: {
        id: 9n,
        usuarioId: 1n,
        idTransacaoPrivado: 'eebd1469-da24-4160-bde5-8946f66cb881',
        idTransacaoPublico: '3dec71a6-0000-4000-8000-000000000000',
        situacao: opts?.situacao ?? SITUACAO_TRANSACAO.PROCESSANDO,
        valorBruto: { toString: () => '10.00' },
        valorTarifaPix: { toString: () => '0.00' },
        contaProvedorId: 2n,
        contaProvedor: {
          credenciaisCriptografadas: 'blob',
          provedor: { codigo: 'valorion_02' },
        },
      },
    };

    /** Fake do `findFirst`: responde pelo `where`, como o banco responderia. */
    const findFirst = jest.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where as {
        idTransacaoLiquidante?: string;
        transacao?: { idTransacaoPrivado?: string };
      };
      if (w.idTransacaoLiquidante) {
        return w.idTransacaoLiquidante === idDaOrdem ? tentativa : null;
      }
      if (w.transacao?.idTransacaoPrivado) {
        return w.transacao.idTransacaoPrivado === tentativa.transacao.idTransacaoPrivado
          ? tentativa
          : null;
      }
      return null;
    });

    const getStatus = jest.fn().mockResolvedValue({ status: 'COMPLETED', raw: {} });
    const prisma = {
      provedorPagamento: {
        findUnique: jest.fn().mockResolvedValue({
          codigo: 'valorion_02',
          situacao: SITUACAO_PROVEDOR.ATIVO,
        }),
      },
      tentativaTransacao: { findFirst, update: jest.fn() },
      transacao: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      historicoSituacaoTransacao: { create: jest.fn() },
      eventoOutbox: { create: jest.fn() },
      webhookRecebidoProvedor: { update: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const processor = new PixWebhookCashoutProcessor(
      prisma as never,
      { get: () => ({ getStatus }) } as never,
      { aplicarMovimentacoes: jest.fn() } as never,
    );
    return { processor, prisma, getStatus, tentativa };
  }

  /** Payload real do postback, já normalizado pelo controller da Valorion. */
  function job() {
    return {
      data: {
        provider: 'valorion_02',
        payload: {
          id: '41284',
          status: 'COMPLETED',
          idtransaction: idDaLiquidacao,
          transactionId: idDaLiquidacao,
          externalreference: idDaOrdem,
          externaRef: idDaOrdem,
          endToEnd: 'E38297374202608132009TGYHXPXVOW9',
          amount: 10,
        },
        webhookRecebidoId: '4',
        identificadorRastreio: 'r',
      },
    } as never;
  }

  it('acha a transação pelo externalreference quando o id do webhook é outro', async () => {
    const { processor, prisma } = montar();

    // Antes da correção este process() lançava 'Tx cash-out não encontrada'.
    await expect(processor.process(job())).resolves.toEqual({ ok: true });

    expect(prisma.transacao.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ situacao: SITUACAO_TRANSACAO.CONCLUIDA }),
      }),
    );
  });

  it('Camada 1 consulta com o id de LIQUIDAÇÃO (o da ordem dá 404 na Valorion)', async () => {
    const { processor, getStatus } = montar();
    await processor.process(job());
    expect(getStatus).toHaveBeenCalledWith(
      expect.objectContaining({ idTransacaoLiquidante: idDaLiquidacao }),
    );
  });

  it('grava o id de liquidação na tentativa — é o que a reconciliação consulta', async () => {
    const { processor, prisma } = montar();
    await processor.process(job());
    expect(prisma.tentativaTransacao.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10n },
        data: expect.objectContaining({ idTransacaoLiquidante: idDaLiquidacao }),
      }),
    );
  });

  it('id já igual ao do webhook não dispara reescrita', async () => {
    const { processor, prisma, tentativa } = montar();
    tentativa.idTransacaoLiquidante = idDaLiquidacao;
    await processor.process(job());
    expect(prisma.tentativaTransacao.update).not.toHaveBeenCalled();
  });

  it('transação já CONCLUIDA não é reprocessada', async () => {
    const { processor, prisma } = montar({ situacao: SITUACAO_TRANSACAO.CONCLUIDA });
    const r = (await processor.process(job())) as { ignorado?: boolean };
    expect(r.ignorado).toBe(true);
    expect(prisma.transacao.updateMany).not.toHaveBeenCalled();
  });
});
