import { UnrecoverableError } from 'bullmq';
import { SITUACAO_PROVEDOR, SITUACAO_TRANSACAO } from '../shared';
import { RecusaAdquirenteError } from '../providers/payment-provider.port';
import { PixWebhookReceivedProcessor } from './pix-webhook-received.processor';

jest.mock('../common/crypto.util', () => ({
  decryptCredentials: () => ({}),
}));

/**
 * Cash-in webhook não pode ficar 20s em delayed por 404 determinístico da
 * Camada 1, nem consultar a liquidante com o nosso id_transacao_privado.
 */
describe('PixWebhookReceivedProcessor — Camada 1 sem retry em recusa', () => {
  const idPrivado = '499627a6-81bf-4614-af6f-2c95a2d7ddcc';
  const idPublico = '17bddc05-014b-4dea-8ddf-0d859cd999fb';
  const idLiquidante = '5ef620fa304421ab5bdb6b48c6ded6';

  function tentativa(overrides?: { idTransacaoLiquidante?: string | null }) {
    return {
      id: 1n,
      idTransacaoLiquidante:
        overrides && 'idTransacaoLiquidante' in overrides
          ? overrides.idTransacaoLiquidante
          : idLiquidante,
      transacao: {
        id: 1n,
        usuarioId: 1n,
        idTransacaoPrivado: idPrivado,
        idTransacaoPublico: idPublico,
        situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
        retidaMetodo: false,
        valorBruto: { toString: () => '25.50' },
        contaProvedorId: 1n,
        pix: null,
        usuario: { configuracaoPix: null },
        contaProvedor: {
          credenciaisCriptografadas: 'blob',
          percentualRetencaoMetodo: null,
          provedor: { codigo: 'valorion' },
        },
      },
    };
  }

  function montar(opts: {
    getStatus?: () => Promise<unknown>;
    tentativa: ReturnType<typeof tentativa> | null;
  }) {
    const getStatus = opts.getStatus ?? jest.fn();
    const prisma = {
      provedorPagamento: {
        findUnique: jest.fn().mockResolvedValue({
          codigo: 'valorion',
          situacao: SITUACAO_PROVEDOR.ATIVO,
        }),
      },
      tentativaTransacao: {
        findFirst: jest.fn().mockResolvedValue(opts.tentativa),
        update: jest.fn(),
      },
    };
    const providers = {
      get: () => ({ getStatus }),
    };
    const processor = new PixWebhookReceivedProcessor(
      prisma as never,
      providers as never,
      { decidir: jest.fn() } as never,
      { creditar: jest.fn(), marcarRetida: jest.fn() } as never,
    );
    return { processor, getStatus, prisma };
  }

  function job(transactionId: string) {
    return {
      data: {
        provider: 'valorion',
        payload: {
          transactionId,
          status: 'PAID',
          externaRef: idPublico,
        },
        webhookRecebidoId: '9',
        identificadorRastreio: 'r',
      },
    };
  }

  it('idtransaction ≠ id da tentativa falha na hora (sem consultar a liquidante)', async () => {
    const { processor, getStatus } = montar({ tentativa: tentativa() });
    await expect(processor.process(job(idPrivado) as never)).rejects.toThrow(
      UnrecoverableError,
    );
    await expect(processor.process(job(idPrivado) as never)).rejects.toThrow(
      /id da adquirente/,
    );
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('404 da Valorion vira UnrecoverableError — não reagenda 16s', async () => {
    const { processor } = montar({
      tentativa: tentativa(),
      getStatus: () =>
        Promise.reject(
          new RecusaAdquirenteError(
            'Valorion HTTP 404: Transação não encontrada.',
            { statusHttp: 404 },
          ),
        ),
    });
    await expect(
      processor.process(job(idLiquidante) as never),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('status ainda não pago continua Error comum (retry/backoff vale)', async () => {
    const { processor } = montar({
      tentativa: tentativa(),
      getStatus: () => Promise.resolve({ status: 'PENDING', raw: {} }),
    });
    await expect(processor.process(job(idLiquidante) as never)).rejects.toThrow(
      /Camada1 não confirmou/,
    );
    await expect(
      processor.process(job(idLiquidante) as never),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});
