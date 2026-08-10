import { ConflictException } from '@nestjs/common';
import { PixService } from './pix.service';
import { SITUACAO_TRANSACAO } from '../shared';

/**
 * Idempotência por `referenciaExterna` — regras por sentido:
 *
 * COBRANÇA nunca responde 409 pela referência ("nunca perder venda"):
 * - mesma referência + mesmos dados + cobrança que ainda serve (paga, ou
 *   aguardando com QR na validade) → devolve a MESMA cobrança;
 * - qualquer outra coisa (dado diferente, FALHA, QR expirado, ainda sem
 *   código) → segue e gera uma cobrança NOVA sob a mesma referência.
 *
 * SAQUE mantém a trava: mesmos dados → replay; divergência → 409 (dinheiro
 * saindo; criar outra ordem é como se paga duas vezes).
 *
 * O ponto de segurança é o curto-circuito do replay: ele retorna ANTES de
 * resolver configuração, debitar ledger ou falar com adquirente.
 */
describe('PixService — idempotência por referenciaExterna', () => {
  const explode = (nome: string) => () => {
    throw new Error(`${nome} alcançado`);
  };
  // Sentinela: o fluxo passou do pre-check e seguiu para CRIAR (o teste usa
  // isso para provar que uma cobrança NOVA seria gerada).
  const SEGUIU_PARA_CRIACAO = 'configPix.resolverEfetiva alcançado';

  const pagador = {
    nome: 'Fulano de Tal',
    documento: '12345678909',
    email: 'fulano@email.com',
  };

  const cobrancaExistente = {
    id: 42n,
    idTransacaoPublico: 'uuid-publico-42',
    direcao: 'ENTRADA',
    situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
    valorBruto: '150.00',
    pix: {
      nomePagador: pagador.nome,
      documentoPagador: pagador.documento,
      emailPagador: pagador.email,
      pixCopiaCola: '000201-copia-e-cola',
      urlCheckout: 'https://checkout/42',
      txid: 'txid-42',
      expiraEm: new Date(Date.now() + 86_400_000),
    },
    itens: [
      { titulo: 'Curso', quantidade: 1, tangivel: false, valorUnitario: '150.00' },
    ],
  };

  const saqueExistente = {
    id: 77n,
    idTransacaoPublico: 'uuid-publico-77',
    direcao: 'SAIDA',
    situacao: SITUACAO_TRANSACAO.CONCLUIDA,
    valorBruto: '80.00',
    pix: {
      chavePix: '12345678909',
      tipoChavePix: 'CPF',
      nomeBeneficiario: 'Bruno de Tal',
      documentoBeneficiario: '12345678909',
    },
    itens: [],
  };

  function servico(txExistente: unknown) {
    const prisma = {
      transacao: { findFirst: jest.fn().mockResolvedValue(txExistente) },
    };
    const configPix = { resolverEfetiva: explode('configPix.resolverEfetiva') };
    const ledger = { aplicarMovimentacoes: explode('ledger.aplicarMovimentacoes') };
    return new PixService(
      prisma as never,
      configPix as never,
      ledger as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { assertSaquePermitido: async () => undefined, registrarRecusaSaque: async () => undefined } as never,
    );
  }

  const inputCobranca = {
    valor: '150.00',
    referenciaExterna: 'pedido-123',
    pagador,
    itens: [{ titulo: 'Curso', quantidade: 1, valorUnitario: 150.0, tangivel: false }],
  };

  it('mesma referência + mesmos dados devolve a MESMA cobrança', async () => {
    const pix = servico(cobrancaExistente);
    const r = await pix.criarCobranca({ usuarioId: 7n, input: inputCobranca });
    expect(r).toEqual({
      idInterno: '42',
      idTransacao: 'uuid-publico-42',
      situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
      valor: '150.00',
      pixCopiaCola: '000201-copia-e-cola',
      urlCheckout: 'https://checkout/42',
      txid: 'txid-42',
      expiraEm: cobrancaExistente.pix.expiraEm,
    });
  });

  it('replay de venda já paga devolve a situação ATUAL (mesmo com QR vencido)', async () => {
    const pix = servico({
      ...cobrancaExistente,
      situacao: SITUACAO_TRANSACAO.CONCLUIDA,
      pix: { ...cobrancaExistente.pix, expiraEm: new Date(Date.now() - 1000) },
    });
    const r = await pix.criarCobranca({ usuarioId: 7n, input: inputCobranca });
    expect(r.situacao).toBe(SITUACAO_TRANSACAO.CONCLUIDA);
    expect(r.idTransacao).toBe('uuid-publico-42');
  });

  it('replay de venda em MED devolve a situação MED, sem gerar cobrança nova', async () => {
    const pix = servico({ ...cobrancaExistente, situacao: SITUACAO_TRANSACAO.MED });
    const r = await pix.criarCobranca({ usuarioId: 7n, input: inputCobranca });
    expect(r.situacao).toBe(SITUACAO_TRANSACAO.MED);
  });

  it('valorUnitario com >2 casas: retry byte-idêntico ainda é replay (não gera cobrança nova)', async () => {
    // Gravado com toFixed(2): 19.999 vira "20.00". O retry manda 19.999 cru; a
    // comparação arredonda o enviado igual à persistência, senão toda tentativa
    // desse lojista viraria uma cobrança nova.
    const pix = servico({
      ...cobrancaExistente,
      valorBruto: '20.00',
      itens: [{ titulo: 'Curso', quantidade: 1, tangivel: false, valorUnitario: '20.00' }],
    });
    const r = await pix.criarCobranca({
      usuarioId: 7n,
      input: {
        ...inputCobranca,
        valor: '20.00',
        itens: [{ titulo: 'Curso', quantidade: 1, valorUnitario: 19.999, tangivel: false }],
      },
    });
    expect(r.idTransacao).toBe('uuid-publico-42');
  });

  it.each([
    ['valor', { ...inputCobranca, valor: '151.00' }],
    ['nome', { ...inputCobranca, pagador: { ...pagador, nome: 'Outro Nome' } }],
    ['documento', { ...inputCobranca, pagador: { ...pagador, documento: '98765432100' } }],
    ['email', { ...inputCobranca, pagador: { ...pagador, email: 'outro@email.com' } }],
    [
      'item',
      {
        ...inputCobranca,
        itens: [{ titulo: 'Outro curso', quantidade: 1, valorUnitario: 150.0, tangivel: false }],
      },
    ],
    [
      'quantidade de itens',
      {
        ...inputCobranca,
        itens: [
          ...inputCobranca.itens,
          { titulo: 'Extra', quantidade: 1, valorUnitario: 1.0, tangivel: false },
        ],
      },
    ],
  ])(
    'cobrança: mesma referência com %s diferente NÃO é 409 — gera cobrança nova',
    async (_campo, input) => {
      const pix = servico(cobrancaExistente);
      await expect(pix.criarCobranca({ usuarioId: 7n, input })).rejects.toThrow(
        SEGUIU_PARA_CRIACAO,
      );
    },
  );

  it('cobrança FALHA com mesmos dados gera cobrança NOVA (retry pós-503 não perde a venda)', async () => {
    const pix = servico({
      ...cobrancaExistente,
      situacao: SITUACAO_TRANSACAO.FALHA,
      pix: { ...cobrancaExistente.pix, pixCopiaCola: null },
    });
    await expect(
      pix.criarCobranca({ usuarioId: 7n, input: inputCobranca }),
    ).rejects.toThrow(SEGUIU_PARA_CRIACAO);
  });

  it('QR expirado com mesmos dados gera cobrança NOVA (não devolve QR morto)', async () => {
    const pix = servico({
      ...cobrancaExistente,
      pix: { ...cobrancaExistente.pix, expiraEm: new Date(Date.now() - 1000) },
    });
    await expect(
      pix.criarCobranca({ usuarioId: 7n, input: inputCobranca }),
    ).rejects.toThrow(SEGUIU_PARA_CRIACAO);
  });

  it('cobrança ainda sem código (1ª chamada em voo) gera cobrança NOVA', async () => {
    const pix = servico({
      ...cobrancaExistente,
      pix: { ...cobrancaExistente.pix, pixCopiaCola: null },
    });
    await expect(
      pix.criarCobranca({ usuarioId: 7n, input: inputCobranca }),
    ).rejects.toThrow(SEGUIU_PARA_CRIACAO);
  });

  const inputSaque = {
    valor: '80.00',
    chavePix: '12345678909',
    tipoChavePix: 'CPF',
    nomeBeneficiario: 'Bruno de Tal',
    documentoBeneficiario: '12345678909',
    referenciaExterna: 'saque-55',
  };

  it('saque: mesma referência + mesmos dados devolve o MESMO saque, sem novo débito', async () => {
    const pix = servico(saqueExistente);
    const r = await pix.criarSaque({ usuarioId: 7n, input: inputSaque as never });
    expect(r).toEqual({
      idInterno: '77',
      idTransacao: 'uuid-publico-77',
      // Situação atual — o replay pode chegar com o saque já liquidado.
      situacao: SITUACAO_TRANSACAO.CONCLUIDA,
      valor: '80.00',
    });
  });

  it.each([
    ['valor', { ...inputSaque, valor: '81.00' }],
    ['chavePix', { ...inputSaque, chavePix: '98765432100' }],
    ['tipoChavePix', { ...inputSaque, tipoChavePix: 'EMAIL' }],
    ['nomeBeneficiario', { ...inputSaque, nomeBeneficiario: 'Outro' }],
    ['documentoBeneficiario', { ...inputSaque, documentoBeneficiario: '98765432100' }],
  ])('saque: mesma referência com %s diferente CONTINUA 409', async (_campo, input) => {
    const pix = servico(saqueExistente);
    await expect(pix.criarSaque({ usuarioId: 7n, input: input as never })).rejects.toThrow(
      ConflictException,
    );
  });

  it('sem referenciaExterna não há replay: a criação segue adiante', async () => {
    const pix = servico(null);
    await expect(
      pix.criarCobranca({
        usuarioId: 7n,
        input: { ...inputCobranca, referenciaExterna: undefined },
      }),
    ).rejects.toThrow(SEGUIU_PARA_CRIACAO);
  });
});
