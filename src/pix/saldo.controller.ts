import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiTokenGuard, assertEscopo } from '../api-credentials/api-token.guard';
import { RateLimitService } from '../api-credentials/rate-limit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ESCOPOS_API, money, MODO_TRATAMENTO_MED } from '../shared';

type ApiCredReq = {
  apiCredential: { id: string; usuarioId: string; escopos: string[] };
  ip?: string;
};

/**
 * Saldo da conta na API pública.
 *
 * Os nomes dos baldes são os MESMOS rótulos que o lojista lê no painel
 * ("A liberar", "Reservado", "Bloqueado MED") — quem integra compara os dois
 * lados o tempo todo, e vocabulário paralelo só geraria dúvida de suporte.
 *
 * Vai junto o bloco `regras`, que é o que dá CAUSA a cada balde parado: sem o
 * prazo de liberação e o percentual de reserva, `aLiberar` é um número sem
 * explicação e o lojista abre chamado perguntando quando cai. É a mesma
 * informação que o `GET /painel/dashboard` já entrega para essa mesma conta —
 * nada novo é revelado, só fica disponível para quem lê pela API.
 */
@Controller('v1/saldo')
export class SaldoApiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  @UseGuards(ApiTokenGuard)
  async consultar(@Req() req: ApiCredReq) {
    assertEscopo(req.apiCredential, ESCOPOS_API.SALDO_LER);
    await this.rateLimit.enforceCredential(req.apiCredential.id, req.ip ?? '');

    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: BigInt(req.apiCredential.usuarioId) },
      include: { saldo: true, configuracaoPix: true },
    });

    /**
     * Conta recém-ativada ainda não tem linha em `saldos_usuarios` (ela nasce
     * no primeiro crédito). Responder 404/erro aí seria mentira: a conta
     * existe e o saldo dela é zero — o integrador não pode ter que tratar
     * "sem carteira" como caso especial.
     */
    const s = usuario.saldo;
    const disponivel = money((s?.saldoDisponivel ?? 0).toString());
    const aLiberar = money((s?.saldoPendenteLiberacao ?? 0).toString());
    const reservado = money((s?.saldoReservado ?? 0).toString());
    const bloqueadoMed = money((s?.saldoBloqueadoMed ?? 0).toString());
    const bloqueadoManual = money((s?.saldoBloqueadoManual ?? 0).toString());

    const cfg = usuario.configuracaoPix;
    return {
      saldo: {
        disponivel: disponivel.toFixed(2),
        aLiberar: aLiberar.toFixed(2),
        reservado: reservado.toFixed(2),
        bloqueadoMed: bloqueadoMed.toFixed(2),
        bloqueadoManual: bloqueadoManual.toFixed(2),
        // Decimal (nunca float): somar dinheiro em ponto flutuante erra centavo.
        total: disponivel
          .plus(aLiberar)
          .plus(reservado)
          .plus(bloqueadoMed)
          .plus(bloqueadoManual)
          .toFixed(2),
      },
      regras: {
        diasLiberacaoSaldo: cfg?.diasLiberacaoSaldo ?? 0,
        percentualReserva: (cfg?.percentualReserva ?? 0).toString(),
        diasRetencaoReserva: cfg?.diasRetencaoReserva ?? 0,
        medBloqueiaSaldo:
          (cfg?.modoTratamentoMed ?? MODO_TRATAMENTO_MED.BLOQUEAR_SALDO) ===
          MODO_TRATAMENTO_MED.BLOQUEAR_SALDO,
        ticketMinimoPixSaida: (cfg?.ticketMinimoPixSaida ?? 0).toString(),
        ticketMaximoPixSaida: cfg?.ticketMaximoPixSaida?.toString() ?? null,
      },
      consultadoEm: new Date().toISOString(),
    };
  }
}
