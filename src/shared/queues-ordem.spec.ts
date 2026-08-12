import { ALL_QUEUE_NAMES, nomeExibicaoFila } from './queues';

describe('nomeExibicaoFila — ordem no Bull Board', () => {
  it('preenche o prefixo para A-Z casar com 1→12', () => {
    expect(nomeExibicaoFila('1-pix-webhook-received')).toBe(
      '01-pix-webhook-received',
    );
    expect(nomeExibicaoFila('4-pix-cash-out')).toBe('04-pix-cash-out');
    expect(nomeExibicaoFila('10-saque-automatico')).toBe(
      '10-saque-automatico',
    );
  });

  it('as 12 filas ordenadas por displayName ficam 1…12', () => {
    const ordenadas = [...ALL_QUEUE_NAMES]
      .map(nomeExibicaoFila)
      .sort((a, z) => a.localeCompare(z));
    expect(ordenadas.map((n) => Number(n.split('-')[0]))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
});
