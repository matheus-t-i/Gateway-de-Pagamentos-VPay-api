import { ehTransacaoNaoEncontrada } from './valorion.client';

/**
 * A linha que separa "concluir pelo postback" de "pagar às cegas".
 *
 * A Valorion não tem consulta de status para saque — a doc dela aponta o
 * postback como o acompanhamento do cash-out, e o endpoint que usamos é o de
 * cash-in. Medido em produção: um saque responde `tipo: CASH OUT / PAGO`,
 * outro responde 404 mesmo com o id que o PAINEL deles exibe como Aprovado
 * (e o endToEnd também 404).
 *
 * Só o 404 definitivo autoriza o desfecho pelo postback. Dúvida — timeout,
 * 5xx, rede — continua sendo erro e retenta.
 */
describe('cash-out sem consulta possível', () => {
  it('404 "não encontrada" é resposta definitiva da liquidante', () => {
    expect(
      ehTransacaoNaoEncontrada(
        new Error(
          'Valorion HTTP 404 em https://app.valorion.com.br/api/s1/getTransaction/api/getTransactionStatus.php: ' +
            '{"errCode":404,"message":"Transação não encontrada."}',
        ),
      ),
    ).toBe(true);
  });

  it('DÚVIDA nunca vira "não existe" — é aqui que se pagaria em dobro', () => {
    for (const m of [
      'Valorion HTTP 500: erro interno',
      'Valorion HTTP 502: bad gateway',
      'Valorion HTTP 503: manutenção',
      'The operation was aborted due to timeout',
      'fetch failed',
      'ECONNRESET',
    ]) {
      expect(ehTransacaoNaoEncontrada(new Error(m))).toBe(false);
    }
  });

  it('4xx de credencial/permissão não é inexistência', () => {
    for (const m of [
      'Valorion HTTP 401: Unauthorized',
      'Valorion HTTP 403: acesso bloqueado',
      'Valorion HTTP 404: Not Found',
    ]) {
      expect(ehTransacaoNaoEncontrada(new Error(m))).toBe(false);
    }
  });
});
