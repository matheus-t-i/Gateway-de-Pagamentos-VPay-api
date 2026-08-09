import { money } from '../shared';
import {
  assertValorCamada1Compativel,
  extrairValorDePayload,
} from './valor-remoto.util';

describe('valor-remoto.util', () => {
  it('extrai amount do payload', () => {
    expect(extrairValorDePayload({ amount: '10.50' })?.toFixed(2)).toBe('10.50');
    expect(extrairValorDePayload({ valor: 10.5 })?.toFixed(2)).toBe('10.50');
  });

  it('aceita valor dentro da tolerância', () => {
    expect(() =>
      assertValorCamada1Compativel(money('10.00'), money('10.01')),
    ).not.toThrow();
  });

  it('recusa divergência e ausência', () => {
    expect(() =>
      assertValorCamada1Compativel(money('10.00'), money('11.00')),
    ).toThrow(/divergente/);
    expect(() =>
      assertValorCamada1Compativel(money('10.00'), null),
    ).toThrow(/sem valor remoto/);
  });
});
