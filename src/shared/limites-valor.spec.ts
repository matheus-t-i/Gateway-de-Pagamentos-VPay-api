import {
  checarLimiteValor,
  faixaPermitidaTexto,
  formatarBRL,
  money,
  OPERACAO_LIMITE,
} from './index';

describe('formatarBRL', () => {
  it('formata em pt-BR sem depender do ICU do runtime', () => {
    expect(formatarBRL('1234.5')).toBe('R$ 1.234,50');
    expect(formatarBRL('0.5')).toBe('R$ 0,50');
    expect(formatarBRL('1000000')).toBe('R$ 1.000.000,00');
    expect(formatarBRL('999.999')).toBe('R$ 1.000,00');
    expect(formatarBRL(money('-25.4'))).toBe('-R$ 25,40');
  });
});

describe('checarLimiteValor — a recusa diz o problema E o permitido', () => {
  const faixaCobranca = { minimo: money('1.00'), maximo: money('5000.00') };

  it('valor dentro da faixa passa', () => {
    expect(
      checarLimiteValor(money('150'), faixaCobranca, OPERACAO_LIMITE.COBRANCA),
    ).toBeNull();
    // Os extremos são inclusivos.
    expect(
      checarLimiteValor(money('1.00'), faixaCobranca, OPERACAO_LIMITE.COBRANCA),
    ).toBeNull();
    expect(
      checarLimiteValor(money('5000.00'), faixaCobranca, OPERACAO_LIMITE.COBRANCA),
    ).toBeNull();
  });

  it('abaixo do mínimo: diz o valor, o lado do erro e a faixa', () => {
    const r = checarLimiteValor(
      money('0.50'),
      faixaCobranca,
      OPERACAO_LIMITE.COBRANCA,
    );
    expect(r?.message).toBe(
      'O valor R$ 0,50 é menor que o mínimo permitido para cobrança PIX. ' +
        'Aceitamos de R$ 1,00 a R$ 5.000,00 por cobrança.',
    );
  });

  it('acima do máximo: mesma estrutura, outro lado', () => {
    const r = checarLimiteValor(
      money('9000'),
      faixaCobranca,
      OPERACAO_LIMITE.COBRANCA,
    );
    expect(r?.message).toContain('R$ 9.000,00 é maior que o máximo');
    expect(r?.message).toContain('Aceitamos de R$ 1,00 a R$ 5.000,00 por cobrança.');
  });

  it('saque sem teto anuncia só o piso — nunca "até null"', () => {
    const faixa = { minimo: money('10.00'), maximo: null };
    expect(faixaPermitidaTexto(faixa, OPERACAO_LIMITE.SAQUE)).toBe(
      'a partir de R$ 10,00 por saque',
    );
    expect(
      checarLimiteValor(money('999999'), faixa, OPERACAO_LIMITE.SAQUE),
    ).toBeNull();
    expect(
      checarLimiteValor(money('5'), faixa, OPERACAO_LIMITE.SAQUE)?.message,
    ).toBe(
      'O valor R$ 5,00 é menor que o mínimo permitido para saque PIX. ' +
        'Aceitamos a partir de R$ 10,00 por saque.',
    );
  });

  it('devolve os números soltos para quem integra tratar sem regex', () => {
    const r = checarLimiteValor(
      money('0.50'),
      faixaCobranca,
      OPERACAO_LIMITE.COBRANCA,
    );
    expect(r).toMatchObject({
      erro: 'VALOR_FORA_DO_LIMITE',
      operacao: 'cobranca',
      valorInformado: '0.50',
      valorMinimo: '1.00',
      valorMaximo: '5000.00',
    });
  });

  it('sem teto, valorMaximo é null (e não a string "null")', () => {
    const r = checarLimiteValor(
      money('5'),
      { minimo: money('10'), maximo: null },
      OPERACAO_LIMITE.SAQUE,
    );
    expect(r?.valorMaximo).toBeNull();
  });
});
