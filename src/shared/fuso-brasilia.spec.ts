import {
  chaveMesBrasilia,
  dataHoraBr,
  deBrasilia,
  diaCivilBrasilia,
  fimDoDiaBrasilia,
  fimDoDiaCivil,
  inicioDoDiaBrasilia,
  inicioDoDiaCivil,
  inicioDoMesBrasilia,
  partesBrasilia,
  recorteFiltroData,
} from './fuso-brasilia';

/**
 * 13/08/2026 16:08 BRT = 19:08 UTC — o bug do gráfico (eixo em hora UTC).
 */
const VENDA_1608_BRT = new Date('2026-08-13T19:08:00.000Z');

describe('fuso-brasilia', () => {
  it('16:08 BRT não vira 19h no rótulo (hora UTC)', () => {
    const p = partesBrasilia(VENDA_1608_BRT);
    expect(p.hour).toBe(16);
    expect(p.minute).toBe(8);
    expect(p.day).toBe(13);
    expect(p.month).toBe(8);
    expect(VENDA_1608_BRT.getUTCHours()).toBe(19);
  });

  it('deBrasilia(16:08) é o instante 19:08 UTC', () => {
    expect(deBrasilia(2026, 8, 13, 16, 8).toISOString()).toBe(
      '2026-08-13T19:08:00.000Z',
    );
  });

  it('meia-noite BRT = 03:00 UTC', () => {
    const inicio = inicioDoDiaBrasilia(VENDA_1608_BRT);
    expect(inicio.toISOString()).toBe('2026-08-13T03:00:00.000Z');
    expect(partesBrasilia(inicio)).toMatchObject({
      year: 2026,
      month: 8,
      day: 13,
      hour: 0,
      minute: 0,
    });
  });

  it('fim do dia BRT atravessa a meia-noite UTC (23:59 BRT = 02:59 UTC do dia seguinte)', () => {
    const fim = fimDoDiaBrasilia(VENDA_1608_BRT);
    expect(fim.toISOString()).toBe('2026-08-14T02:59:59.999Z');
    expect(diaCivilBrasilia(fim)).toBe('2026-08-13');
  });

  it('"hoje" no processo UTC ainda é o dia BRT', () => {
    // 14/08 01:30 UTC = 13/08 22:30 BRT — getUTCDate() diria dia 14.
    const madrugadaUtc = new Date('2026-08-14T01:30:00.000Z');
    expect(madrugadaUtc.getUTCDate()).toBe(14);
    expect(diaCivilBrasilia(madrugadaUtc)).toBe('2026-08-13');
    expect(inicioDoDiaBrasilia(madrugadaUtc).toISOString()).toBe(
      '2026-08-13T03:00:00.000Z',
    );
  });

  it('filtro dataInicial/dataFinal é meia-noite/fim do dia BRT, não UTC', () => {
    expect(inicioDoDiaCivil('2026-08-13')?.toISOString()).toBe(
      '2026-08-13T03:00:00.000Z',
    );
    expect(fimDoDiaCivil('2026-08-13')?.toISOString()).toBe(
      '2026-08-14T02:59:59.999Z',
    );
    const recorte = recorteFiltroData('2026-08-13', '2026-08-13');
    expect(recorte?.gte?.toISOString()).toBe('2026-08-13T03:00:00.000Z');
    expect(recorte?.lte?.toISOString()).toBe('2026-08-14T02:59:59.999Z');
  });

  it('venda às 21:30 BRT entra no dia 13 (T00:00:00 UTC a deixaria de fora)', () => {
    const vendaNoite = deBrasilia(2026, 8, 13, 21, 30);
    expect(vendaNoite.toISOString()).toBe('2026-08-14T00:30:00.000Z');
    const recorte = recorteFiltroData('2026-08-13', '2026-08-13')!;
    expect(vendaNoite.getTime()).toBeGreaterThanOrEqual(recorte.gte!.getTime());
    expect(vendaNoite.getTime()).toBeLessThanOrEqual(recorte.lte!.getTime());
    // O anti-padrão UTC corta às 23:59 UTC = 20:59 BRT.
    const fimUtcIngenuo = new Date('2026-08-13T23:59:59.999Z');
    expect(vendaNoite.getTime()).toBeGreaterThan(fimUtcIngenuo.getTime());
  });

  it('início do mês BRT não é 00:00 UTC do dia 1', () => {
    const inicio = inicioDoMesBrasilia(VENDA_1608_BRT);
    expect(inicio.toISOString()).toBe('2026-08-01T03:00:00.000Z');
    expect(chaveMesBrasilia(VENDA_1608_BRT)).toBe('2026-08');
  });

  it('venda 31/08 22:00 BRT continua no mês 08 (01/09 01:00 UTC cairia em setembro)', () => {
    const fimDeAgosto = deBrasilia(2026, 8, 31, 22, 0);
    expect(fimDeAgosto.toISOString()).toBe('2026-09-01T01:00:00.000Z');
    expect(chaveMesBrasilia(fimDeAgosto)).toBe('2026-08');
    expect(fimDeAgosto.getUTCMonth() + 1).toBe(9);
  });

  it('dataHoraBr do callback é relógio de Brasília, não UTC', () => {
    expect(dataHoraBr(VENDA_1608_BRT)).toBe('2026-08-13 16:08:00');
  });
});
