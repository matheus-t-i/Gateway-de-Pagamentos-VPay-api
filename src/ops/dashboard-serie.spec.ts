import { SITUACAO_TRANSACAO } from '../shared';
import {
  deBrasilia,
  montarSerieDashboard,
  resolverIntervaloSerie,
} from './dashboard-serie';

/**
 * O gráfico "Vendas no período" só listava horas COM venda. Uma cobrança
 * às 19h virava um eixo X com um único marcador — 18h/20h sumiam.
 */
describe('montarSerieDashboard', () => {
  /** 13/08/2026 17:07 BRT = 20:07 UTC — a janela do screenshot. */
  const ate = new Date('2026-08-13T20:07:00.000Z');
  const desde = new Date(ate.getTime() - 24 * 60 * 60 * 1000);

  const venda19h = {
    criadoEm: deBrasilia(2026, 8, 12, 19, 30),
    valorBruto: '20.00',
    situacao: SITUACAO_TRANSACAO.CONCLUIDA,
  };

  it('intervalo inválido cai no padrão 1h', () => {
    expect(resolverIntervaloSerie(undefined)).toBe('1h');
    expect(resolverIntervaloSerie('hora')).toBe('1h');
    expect(resolverIntervaloSerie('15m')).toBe('15m');
  });

  it('1h: 24 baldes mesmo com uma única venda', () => {
    const serie = montarSerieDashboard({
      desde,
      ate,
      porHora: true,
      intervalo: '1h',
      linhas: [venda19h],
    });

    expect(serie).toHaveLength(24);
    expect(serie.map((p) => p.label)).toContain('19h');
    expect(serie.map((p) => p.label)).toContain('18h');
    expect(serie.map((p) => p.label)).toContain('20h');

    const comVenda = serie.filter((p) => p.aprovadas !== '0.00');
    expect(comVenda).toHaveLength(1);
    expect(comVenda[0].label).toBe('19h');
    expect(comVenda[0].aprovadas).toBe('20.00');
    expect(comVenda[0].pendentes).toBe('0.00');
    expect(serie.filter((p) => p.aprovadas === '0.00')).toHaveLength(23);
  });

  it('30 min: 48 baldes com zeros', () => {
    const serie = montarSerieDashboard({
      desde,
      ate,
      porHora: true,
      intervalo: '30m',
      linhas: [venda19h],
    });
    expect(serie).toHaveLength(48);
    expect(serie.filter((p) => p.aprovadas === '0.00')).toHaveLength(47);
    const hit = serie.find((p) => p.aprovadas === '20.00');
    expect(hit?.label).toBe('19:30');
  });

  it('15 min: 96 baldes com zeros', () => {
    const serie = montarSerieDashboard({
      desde,
      ate,
      porHora: true,
      intervalo: '15m',
      linhas: [venda19h],
    });
    expect(serie).toHaveLength(96);
    expect(serie.filter((p) => p.aprovadas === '0.00')).toHaveLength(95);
    const hit = serie.find((p) => p.aprovadas === '20.00');
    expect(hit?.label).toBe('19:30');
  });

  it('pendente é só AGUARDANDO_PAGAMENTO; FALHA não entra no gráfico', () => {
    const serie = montarSerieDashboard({
      desde,
      ate,
      porHora: true,
      intervalo: '1h',
      linhas: [
        {
          criadoEm: deBrasilia(2026, 8, 13, 10, 15),
          valorBruto: '50.00',
          situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
        },
        {
          criadoEm: deBrasilia(2026, 8, 13, 10, 40),
          valorBruto: '9.00',
          situacao: SITUACAO_TRANSACAO.FALHA,
        },
      ],
    });
    const dez = serie.find((p) => p.label === '10h');
    expect(dez?.pendentes).toBe('50.00');
    expect(dez?.aprovadas).toBe('0.00');
    expect(dez?.geradas).toBe('59.00');
  });

  it('7 dias: um ponto por dia, zeros nos dias sem venda', () => {
    const ate7 = deBrasilia(2026, 8, 13, 17, 7);
    const desde7 = new Date(ate7.getTime() - 7 * 86_400_000);
    const serie = montarSerieDashboard({
      desde: desde7,
      ate: ate7,
      porHora: false,
      intervalo: '1h',
      linhas: [
        {
          criadoEm: deBrasilia(2026, 8, 12, 11, 0),
          valorBruto: '10.00',
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
        },
      ],
    });
    expect(serie).toHaveLength(8);
    expect(serie.filter((p) => p.aprovadas === '0.00')).toHaveLength(7);
    expect(serie.find((p) => p.label === '12/08')?.aprovadas).toBe('10.00');
  });

  it('venda 16:08 BRT rotula 16h, não 19h UTC', () => {
    const ate = new Date('2026-08-13T20:00:00.000Z');
    const desde = new Date(ate.getTime() - 24 * 60 * 60 * 1000);
    const serie = montarSerieDashboard({
      desde,
      ate,
      porHora: true,
      intervalo: '1h',
      linhas: [
        {
          criadoEm: deBrasilia(2026, 8, 13, 16, 8),
          valorBruto: '10.00',
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
        },
      ],
    });
    const hit = serie.find((p) => p.aprovadas === '10.00');
    expect(hit?.label).toBe('16h');
  });

  it('soma em decimal, sem float', () => {
    const serie = montarSerieDashboard({
      desde,
      ate,
      porHora: true,
      intervalo: '1h',
      linhas: [
        {
          criadoEm: deBrasilia(2026, 8, 12, 19, 10),
          valorBruto: '0.10',
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
        },
        {
          criadoEm: deBrasilia(2026, 8, 12, 19, 20),
          valorBruto: '0.20',
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
        },
      ],
    });
    expect(serie.find((p) => p.label === '19h')?.aprovadas).toBe('0.30');
  });
});
