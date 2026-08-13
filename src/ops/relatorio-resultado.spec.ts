import { RelatorioResultadoService } from './relatorio-resultado.service';
import { SITUACAO_TRANSACAO } from '../shared';

/**
 * Apuração de Resultado só pode contar tarifa de venda PAGA.
 *
 * O bug: cash-in `AGUARDANDO_PAGAMENTO` entrava como "venda retida" e o
 * valor bruto inteiro virava Receita Cobrada / Resultado Líquido — PIX
 * ainda não pago tratado como se a VPay tivesse embolsado o volume.
 */
describe('RelatorioResultadoService — receita só de venda paga', () => {
  const joseId = 1n;
  const adminId = 2n;
  const contaId = 10n;

  const jose = {
    id: joseId,
    idPublico: 'usr_jose',
    nomeRazaoSocial: 'jose rodrigo dos santos',
    email: 'jose@teste.local',
  };
  const admin = {
    id: adminId,
    idPublico: 'usr_admin',
    nomeRazaoSocial: 'Administrador VPay',
    email: 'admin@teste.local',
  };
  const conta = {
    id: contaId,
    provedor: { codigo: 'valoriza_02', nome: 'Valoriza 02' },
  };

  function tx(parcial: {
    usuarioId: bigint;
    direcao: 'ENTRADA' | 'SAIDA';
    situacao: string;
    valorBruto: string;
    valorTarifaPix: string;
    valorCustoPixProvedor: string;
    retidaMetodo?: boolean;
  }) {
    return {
      contaProvedorId: contaId,
      retidaMetodo: false,
      ...parcial,
    };
  }

  function servico(txs: ReturnType<typeof tx>[]) {
    const prisma = {
      transacao: { findMany: jest.fn().mockResolvedValue(txs) },
      usuario: { findMany: jest.fn().mockResolvedValue([jose, admin]) },
      contaProvedor: { findMany: jest.fn().mockResolvedValue([conta]) },
    };
    return {
      prisma,
      svc: new RelatorioResultadoService(prisma as never),
    };
  }

  const periodo = { dataInicial: '2026-08-13', dataFinal: '2026-08-13' };

  it('cash-in AGUARDANDO_PAGAMENTO não entra em receita nem em volume processado', async () => {
    const aguardando = tx({
      usuarioId: joseId,
      direcao: 'ENTRADA',
      situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
      valorBruto: '100.00',
      valorTarifaPix: '100.00',
      valorCustoPixProvedor: '0.00',
    });
    const { prisma, svc } = servico([aguardando]);
    const r = await svc.gerar(periodo);

    expect(r.kpis.volumeProcessado).toBe('0.00');
    expect(r.kpis.receitaCobrada).toBe('0.00');
    expect(r.kpis.resultadoLiquido).toBe('0.00');
    expect(r.kpis.operacoes).toBe(0);
    expect(r.kpis.vendasRetidas).toBe('0.00');
    expect(r.clientes).toHaveLength(0);

    const where = prisma.transacao.findMany.mock.calls[0][0].where as {
      OR: Array<Record<string, unknown>>;
    };
    const cashInAguardandoSolto = where.OR.find(
      (c) =>
        c.direcao === 'ENTRADA' &&
        c.situacao === SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO &&
        c.retidaMetodo !== true,
    );
    expect(cashInAguardandoSolto).toBeUndefined();
  });

  it('cash-in CONCLUIDA entra em volume, receita (tarifa) e resultado', async () => {
    const paga = tx({
      usuarioId: joseId,
      direcao: 'ENTRADA',
      situacao: SITUACAO_TRANSACAO.CONCLUIDA,
      valorBruto: '100.00',
      valorTarifaPix: '3.50',
      valorCustoPixProvedor: '0.80',
    });
    const { svc } = servico([paga]);
    const r = await svc.gerar(periodo);

    expect(r.kpis.volumeProcessado).toBe('100.00');
    expect(r.kpis.receitaCobrada).toBe('3.50');
    expect(r.kpis.custoAdquirentes).toBe('0.80');
    expect(r.kpis.resultadoLiquido).toBe('2.70');
    expect(r.kpis.operacoes).toBe(1);
    expect(r.clientes).toHaveLength(1);
    expect(r.clientes[0].nome).toBe(jose.nomeRazaoSocial);
    expect(r.clientes[0].volume).toBe('100.00');
    expect(r.clientes[0].receita).toBe('3.50');
    expect(r.clientes[0].custo).toBe('0.80');
    expect(r.clientes[0].resultado).toBe('2.70');
    expect(r.clientes[0].status).toBe('Lucro');
  });

  it('o caso do screenshot: aguardando R$ 100 + saque R$ 20 não infla receita', async () => {
    const aguardandoJose = tx({
      usuarioId: joseId,
      direcao: 'ENTRADA',
      situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
      valorBruto: '100.00',
      valorTarifaPix: '100.00',
      valorCustoPixProvedor: '0.00',
    });
    const saqueAdmin = tx({
      usuarioId: adminId,
      direcao: 'SAIDA',
      situacao: SITUACAO_TRANSACAO.CONCLUIDA,
      valorBruto: '20.00',
      valorTarifaPix: '0.00',
      valorCustoPixProvedor: '0.80',
    });
    const { svc } = servico([aguardandoJose, saqueAdmin]);
    const r = await svc.gerar(periodo);

    expect(r.kpis.volumeProcessado).toBe('20.00');
    expect(r.kpis.receitaCobrada).toBe('0.00');
    expect(r.kpis.custoAdquirentes).toBe('0.80');
    expect(r.kpis.resultadoLiquido).toBe('-0.80');
    expect(r.kpis.operacoes).toBe(1);
    expect(r.kpis.vendasRetidas).toBe('0.00');
    expect(r.clientes).toHaveLength(1);
    expect(r.clientes[0].nome).toBe(admin.nomeRazaoSocial);
    expect(r.clientes[0].receita).toBe('0.00');
    expect(r.clientes[0].custo).toBe('0.80');
    expect(r.clientes[0].resultado).toBe('-0.80');
  });

  it('cash-in MED entra na receita: venda já paga, tarifa já cobrada', async () => {
    const med = tx({
      usuarioId: joseId,
      direcao: 'ENTRADA',
      situacao: SITUACAO_TRANSACAO.MED,
      valorBruto: '50.00',
      valorTarifaPix: '2.00',
      valorCustoPixProvedor: '0.40',
    });
    const { svc } = servico([med]);
    const r = await svc.gerar(periodo);

    expect(r.kpis.volumeProcessado).toBe('50.00');
    expect(r.kpis.receitaCobrada).toBe('2.00');
    expect(r.kpis.resultadoLiquido).toBe('1.60');
  });

  it('retida pelo método não soma em receita nem volume; só no card de retidas', async () => {
    const retida = tx({
      usuarioId: joseId,
      direcao: 'ENTRADA',
      situacao: SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
      retidaMetodo: true,
      valorBruto: '80.00',
      valorTarifaPix: '2.40',
      valorCustoPixProvedor: '0.64',
    });
    const paga = tx({
      usuarioId: joseId,
      direcao: 'ENTRADA',
      situacao: SITUACAO_TRANSACAO.CONCLUIDA,
      valorBruto: '20.00',
      valorTarifaPix: '0.60',
      valorCustoPixProvedor: '0.16',
    });
    const { svc } = servico([retida, paga]);
    const r = await svc.gerar(periodo);

    expect(r.kpis.volumeProcessado).toBe('20.00');
    expect(r.kpis.receitaCobrada).toBe('0.60');
    expect(r.kpis.custoAdquirentes).toBe('0.16');
    expect(r.kpis.resultadoLiquido).toBe('0.44');
    expect(r.kpis.vendasRetidas).toBe('80.00');
    expect(r.kpis.vendasRetidasOps).toBe(1);
    expect(r.kpis.operacoes).toBe(1);
    expect(r.clientes[0].receita).toBe(r.kpis.receitaCobrada);
    expect(r.clientes[0].resultado).toBe(r.kpis.resultadoLiquido);
    expect(r.clientes[0].retido).toBe('80.00');
    expect(r.clientes[0].retidoOps).toBe(1);
  });

  it('cash-in FALHA e LIQUIDADA: só a liquidada (paga) conta', async () => {
    const falha = tx({
      usuarioId: joseId,
      direcao: 'ENTRADA',
      situacao: SITUACAO_TRANSACAO.FALHA,
      valorBruto: '30.00',
      valorTarifaPix: '1.00',
      valorCustoPixProvedor: '0.20',
    });
    const liquidada = tx({
      usuarioId: joseId,
      direcao: 'ENTRADA',
      situacao: SITUACAO_TRANSACAO.LIQUIDADA,
      valorBruto: '40.00',
      valorTarifaPix: '1.20',
      valorCustoPixProvedor: '0.30',
    });
    const { prisma, svc } = servico([falha, liquidada]);
    const r = await svc.gerar(periodo);

    expect(r.kpis.volumeProcessado).toBe('40.00');
    expect(r.kpis.receitaCobrada).toBe('1.20');

    const where = prisma.transacao.findMany.mock.calls[0][0].where as {
      OR: Array<{ situacao?: { in?: string[] } | string }>;
    };
    const pagas = where.OR.find(
      (c) =>
        typeof c.situacao === 'object' &&
        Array.isArray(c.situacao.in) &&
        c.situacao.in.includes(SITUACAO_TRANSACAO.CONCLUIDA),
    );
    expect(pagas?.situacao).toEqual({
      in: [
        SITUACAO_TRANSACAO.CONCLUIDA,
        SITUACAO_TRANSACAO.LIQUIDADA,
        SITUACAO_TRANSACAO.MED,
      ],
    });
    expect(JSON.stringify(where.OR)).not.toContain(SITUACAO_TRANSACAO.FALHA);
  });

  it('filtro de um dia é [00:00, 23:59:59.999] BRT — no Render UTC não corta 21h–23h59', async () => {
    const { prisma, svc } = servico([]);
    await svc.gerar(periodo);
    const where = prisma.transacao.findMany.mock.calls[0][0].where as {
      criadoEm: { gte: Date; lte: Date };
    };
    expect(where.criadoEm.gte.toISOString()).toBe('2026-08-13T03:00:00.000Z');
    expect(where.criadoEm.lte.toISOString()).toBe('2026-08-14T02:59:59.999Z');
  });
});
