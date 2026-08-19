import { SegurancaController } from './seguranca.controller';

/**
 * A conta dos cartões de /admin/seguranca. Dataset espelha a varredura real de
 * 17/08/2026: 78 chamadas, 30 falhas — das quais 24 eram 404 de rota
 * inexistente (scanner) — e 2 não autorizadas. Sem separar a varredura, a
 * "taxa de recusa" ia a 38% sem nenhuma integração doente.
 */
describe('resumo de /admin/seguranca — varredura fora da taxa de recusa', () => {
  function montar() {
    const count = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (Array.isArray(where.AND)) return 24; // assinatura de rota inexistente
      const status = where.statusHttp as { in?: number[] } | number | undefined;
      if (status && typeof status === 'object' && status.in) return 2; // 401/403
      if (where.sucesso === false) return 30; // todas as falhas
      return 78; // total
    });
    const groupBy = jest.fn().mockResolvedValue([]);
    const prisma = { registroAcessoApi: { count, groupBy } };
    return { ctrl: new SegurancaController(prisma as never), count };
  }

  it('separa varredura das recusas e tira a taxa só das rotas existentes', async () => {
    const { ctrl } = montar();
    const r = await ctrl.resumo({});

    expect(r.total).toBe(78);
    expect(r.rotasInexistentes).toBe(24);
    expect(r.falhas).toBe(6); // 30 − 24: recusa de integração de verdade
    expect(r.naoAutorizados).toBe(2);
    // 6 ÷ (78 − 24) = 11,1%, e não os 38,5% que a varredura fabricava.
    expect(r.taxaFalha).toBeCloseTo(0.1111, 4);
  });

  it('filtro "varredura" vira o predicado 404 + mensagem do roteador', async () => {
    const { ctrl, count } = montar();
    await ctrl.resumo({ resultado: 'varredura' });

    expect(count.mock.calls[0][0].where).toMatchObject({
      statusHttp: 404,
      mensagemErro: { startsWith: 'Cannot ' },
    });
  });

  it('filtro "falha" exclui a varredura, como os cartões', async () => {
    const { ctrl, count } = montar();
    await ctrl.resumo({ resultado: 'falha' });

    expect(count.mock.calls[0][0].where).toMatchObject({
      sucesso: false,
      NOT: { statusHttp: 404, mensagemErro: { startsWith: 'Cannot ' } },
    });
  });

  it('varredura vence status conflitante — o where fica coerente (404), não vazio', async () => {
    const { ctrl, count } = montar();
    await ctrl.resumo({ resultado: 'varredura', status: '401' });

    // Sem a reordenação, statusHttp virava 401 e o predicado 404+"Cannot "
    // nunca casava linha nenhuma: tela vazia sem explicação.
    expect(count.mock.calls[0][0].where.statusHttp).toBe(404);
  });

  it('sem varredura nenhuma, a taxa é a de antes (nada some, nada divide por zero)', async () => {
    const count = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (Array.isArray(where.AND)) return 0; // nenhuma rota inexistente
      const status = where.statusHttp as { in?: number[] } | undefined;
      if (status && typeof status === 'object' && status.in) return 1;
      if (where.sucesso === false) return 30;
      return 78;
    });
    const prisma = { registroAcessoApi: { count, groupBy: jest.fn().mockResolvedValue([]) } };
    const r = await new SegurancaController(prisma as never).resumo({});

    expect(r.rotasInexistentes).toBe(0);
    expect(r.falhas).toBe(30);
    expect(r.taxaFalha).toBeCloseTo(0.3846, 4); // 30/78 — idêntico ao comportamento antigo
  });

  it('período 100% varredura não gera NaN na taxa', async () => {
    const count = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (Array.isArray(where.AND)) return 40; // tudo é rota inexistente
      const status = where.statusHttp as { in?: number[] } | undefined;
      if (status && typeof status === 'object' && status.in) return 0;
      if (where.sucesso === false) return 40;
      return 40; // total == varredura
    });
    const prisma = { registroAcessoApi: { count, groupBy: jest.fn().mockResolvedValue([]) } };
    const r = await new SegurancaController(prisma as never).resumo({});

    expect(r.taxaFalha).toBe(0);
    expect(Number.isNaN(r.taxaFalha)).toBe(false);
  });
});
