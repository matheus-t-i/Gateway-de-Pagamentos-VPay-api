import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { ValorionPaymentProvider } from './valorion.client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * O `externaRef` da cobrança é a chave que a Valorion usa no refund
 * (`createRefund` manda `{ id, external_reference }`, SEM idempotência).
 *
 * Dois invariantes, os dois de dinheiro:
 *
 * 1. Ele NUNCA pode ser a `referenciaExterna` do lojista. Como cobrança nunca
 *    responde 409, a mesma referência acumula N cobranças vivas — mandá-la para
 *    a liquidante criava duas cobranças com o MESMO `external_reference`, e a
 *    devolução passava a mirar uma chave ambígua.
 * 2. Ele NUNCA pode ser o `idTransacaoPrivado`. O id privado é interno (o
 *    callback e a API pública só expõem o público) e esta era a única linha em
 *    que ele cruzava a fronteira da VPay.
 *
 * O valor correto é o `idTransacaoPublico`: único por transação e já presente em
 * `customer.id`/`metadata`, então o eco do postback casa sem heurística.
 */
describe('Valorion createCharge — externaRef', () => {
  const config = {
    get: (nome: string) =>
      (
        ({
          VALORION_API_KEY: 'chave-de-teste',
          API_PUBLIC_URL: 'https://api.teste.local',
          VALORION_WEBHOOK_TOKEN: 'token-de-teste',
        }) as Record<string, string>
      )[nome],
  } as unknown as ConfigService;

  const provider = new ValorionPaymentProvider(
    {} as unknown as PrismaService,
    config,
  );

  /** Captura o corpo enviado à Valorion sem sair para a rede. */
  async function corpoEnviado(input: {
    idTransacaoPrivado: string;
    idTransacaoPublico: string;
    /**
     * Só o teste passa isto. O campo saiu do `CreateChargeInput` de propósito —
     * o cast simula um chamador que volte a injetá-lo, que é exatamente a
     * regressão que estes testes existem para pegar.
     */
    referenciaExterna?: string;
  }) {
    let capturado: Record<string, unknown> = {};
    const fetchOriginal = global.fetch;
    global.fetch = (async (_url: string, init: { body: string }) => {
      capturado = JSON.parse(init.body) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'success',
            idTransaction: 'liq-999',
            paymentCode: '00020126...',
          }),
      };
    }) as unknown as typeof fetch;

    try {
      await provider.createCharge({
        valor: new Decimal('10.00'),
        idTransacaoPrivado: input.idTransacaoPrivado,
        idTransacaoPublico: input.idTransacaoPublico,
        ...(input.referenciaExterna
          ? { referenciaExterna: input.referenciaExterna }
          : {}),
        pagador: {
          nome: 'Fulano de Tal',
          documento: '52998224725',
          email: 'fulano@teste.local',
          telefone: '11999998888',
        },
        credenciais: {},
      } as never);
    } finally {
      global.fetch = fetchOriginal;
    }

    return capturado;
  }

  it('manda o id PÚBLICO — nunca o privado', async () => {
    const corpo = await corpoEnviado({
      idTransacaoPrivado: 'PRIVADO-nao-pode-vazar',
      idTransacaoPublico: 'PUBLICO-abc-123',
    });

    const customer = corpo.customer as Record<string, unknown>;
    expect(customer.externaRef).toBe('PUBLICO-abc-123');
    expect(customer.externaRef).not.toBe('PRIVADO-nao-pode-vazar');

    // O id privado não pode aparecer em NENHUM canto do corpo.
    expect(JSON.stringify(corpo)).not.toContain('PRIVADO-nao-pode-vazar');
  });

  it('duas cobranças da MESMA referência do lojista saem com chaves DIFERENTES', async () => {
    // Cenário do "nunca perder venda": o lojista repete a MESMA referência
    // (carrinho mudou / QR expirou) e nascem duas cobranças. Na liquidante elas
    // TÊM que ser distinguíveis, senão o refund não sabe qual estornar.
    const primeira = await corpoEnviado({
      idTransacaoPrivado: 'privado-1',
      idTransacaoPublico: 'publico-1',
      referenciaExterna: 'PEDIDO-123',
    });
    const segunda = await corpoEnviado({
      idTransacaoPrivado: 'privado-2',
      idTransacaoPublico: 'publico-2',
      referenciaExterna: 'PEDIDO-123',
    });

    const refA = (primeira.customer as Record<string, unknown>).externaRef;
    const refB = (segunda.customer as Record<string, unknown>).externaRef;
    expect(refA).not.toBe(refB);
    // E nenhuma das duas pode SER a referência do lojista.
    expect(refA).not.toBe('PEDIDO-123');
    expect(refB).not.toBe('PEDIDO-123');
  });

  it('a chave do refund bate com o que o postback vai ecoar', async () => {
    // `customer.id` e `metadata` já carregam o id público; o `externaRef` tem
    // que ser o MESMO valor, senão o eco do postback casa por um caminho e a
    // devolução mira outro.
    const corpo = await corpoEnviado({
      idTransacaoPrivado: 'privado-9',
      idTransacaoPublico: 'publico-9',
    });

    const customer = corpo.customer as Record<string, unknown>;
    expect(customer.externaRef).toBe(customer.id);
    expect(customer.externaRef).toBe(corpo.metadata);
  });
});
