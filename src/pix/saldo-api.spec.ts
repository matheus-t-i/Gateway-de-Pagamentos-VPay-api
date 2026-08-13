import { ForbiddenException } from '@nestjs/common';
import { ESCOPOS_API, MODO_TRATAMENTO_MED } from '../shared';
import { SaldoApiController } from './saldo.controller';

describe('GET /v1/saldo — consulta de saldo da API pública', () => {
  function montar(opts?: {
    escopos?: string[];
    saldo?: Record<string, unknown> | null;
    configuracaoPix?: Record<string, unknown> | null;
  }) {
    const prisma = {
      usuario: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 1n,
          saldo:
            opts && 'saldo' in opts
              ? opts.saldo
              : {
                  saldoDisponivel: '1250.00',
                  saldoPendenteLiberacao: '300.00',
                  saldoReservado: '150.00',
                  saldoBloqueadoMed: '0.00',
                  saldoBloqueadoManual: '0.00',
                },
          configuracaoPix:
            opts && 'configuracaoPix' in opts
              ? opts.configuracaoPix
              : {
                  diasLiberacaoSaldo: 2,
                  percentualReserva: '5.00',
                  diasRetencaoReserva: 30,
                  modoTratamentoMed: MODO_TRATAMENTO_MED.BLOQUEAR_SALDO,
                  ticketMinimoPixSaida: '1.00',
                  ticketMaximoPixSaida: null,
                },
        }),
      },
    };
    const rateLimit = { enforceCredential: jest.fn() };
    const controller = new SaldoApiController(prisma as never, rateLimit as never);
    const req = {
      apiCredential: {
        id: '7',
        usuarioId: '1',
        escopos: opts?.escopos ?? [ESCOPOS_API.SALDO_LER],
      },
      ip: '1.2.3.4',
    };
    return { controller, req, rateLimit };
  }

  it('sem o escopo saldo.ler responde 403 — e nem consulta o banco', async () => {
    const { controller, req, rateLimit } = montar({
      escopos: [ESCOPOS_API.PIX_COBRANCA_CRIAR],
    });
    await expect(controller.consultar(req as never)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Escopo é barreira: nada de gastar cota de rate limit numa chamada barrada.
    expect(rateLimit.enforceCredential).not.toHaveBeenCalled();
  });

  it('devolve os baldes do painel e o total somado em decimal', async () => {
    const { controller, req } = montar();
    const r = await controller.consultar(req as never);
    expect(r.saldo).toEqual({
      disponivel: '1250.00',
      aLiberar: '300.00',
      reservado: '150.00',
      bloqueadoMed: '0.00',
      bloqueadoManual: '0.00',
      total: '1700.00',
    });
  });

  it('soma centavos sem erro de float', async () => {
    const { controller, req } = montar({
      saldo: {
        saldoDisponivel: '0.10',
        saldoPendenteLiberacao: '0.20',
        saldoReservado: '0.10',
        saldoBloqueadoMed: '0.00',
        saldoBloqueadoManual: '0.00',
      },
    });
    const r = await controller.consultar(req as never);
    // 0.1 + 0.2 + 0.1 em float dá 0.4000000000000001.
    expect(r.saldo.total).toBe('0.40');
  });

  it('conta nova (sem linha de saldo) responde zero, não erro', async () => {
    const { controller, req } = montar({ saldo: null, configuracaoPix: null });
    const r = await controller.consultar(req as never);
    expect(r.saldo.disponivel).toBe('0.00');
    expect(r.saldo.total).toBe('0.00');
    expect(r.regras.diasLiberacaoSaldo).toBe(0);
    // Sem config, o padrão do sistema é o MED com análise.
    expect(r.regras.medBloqueiaSaldo).toBe(true);
  });

  it('regras acompanham o saldo — é o que explica o dinheiro parado', async () => {
    const { controller, req } = montar();
    const r = await controller.consultar(req as never);
    expect(r.regras).toEqual({
      diasLiberacaoSaldo: 2,
      percentualReserva: '5.00',
      diasRetencaoReserva: 30,
      medBloqueiaSaldo: true,
      ticketMinimoPixSaida: '1.00',
      ticketMaximoPixSaida: null,
    });
  });

  it('MED sem análise (débito imediato) não promete bloqueio de saldo', async () => {
    const { controller, req } = montar({
      configuracaoPix: {
        diasLiberacaoSaldo: 0,
        percentualReserva: '0',
        diasRetencaoReserva: 0,
        modoTratamentoMed: MODO_TRATAMENTO_MED.DEBITAR_IMEDIATAMENTE,
        ticketMinimoPixSaida: '0',
        ticketMaximoPixSaida: null,
      },
    });
    const r = await controller.consultar(req as never);
    expect(r.regras.medBloqueiaSaldo).toBe(false);
  });
});
