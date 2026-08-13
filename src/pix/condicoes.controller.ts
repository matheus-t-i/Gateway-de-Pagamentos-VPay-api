import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ConfigPixService } from '../ledger/ledger.service';
import {
  faixaPermitidaTexto,
  OPERACAO_LIMITE,
} from '../shared';

/**
 * Condições comerciais da PRÓPRIA conta, para a tela `/configuracoes`.
 *
 * Taxa e limites eram invisíveis ao cliente: só o admin via, em
 * `/admin/usuarios/[id]`. O lojista descobria o teto de cobrança quando uma
 * venda era recusada — e o valor da taxa, conferindo o líquido no extrato.
 *
 * Sem `@RequerPermissao` de propósito: é dado da própria conta do JWT, mesma
 * classe de `/auth/me` (não existe id de conta na URL, então não há como ler a
 * de outro). Rota nova que NÃO seja da própria conta precisa de decorator.
 *
 * Lê pela `resolverEfetiva`, e não pela linha crua, porque é ela que aplica os
 * ajustes de leitura (ex.: `permiteSaldoNegativo` forçado no MED de débito
 * direto) — a tela tem que mostrar o que vale de verdade na hora da operação.
 */
@Controller('painel/conta')
@UseGuards(JwtAuthGuard)
export class PainelCondicoesController {
  constructor(private readonly configPix: ConfigPixService) {}

  @Get('condicoes')
  async condicoes(@Req() req: { user: { id: string } }) {
    const cfg = await this.configPix.resolverEfetiva(BigInt(req.user.id));

    const faixaCobranca = {
      minimo: cfg.ticketMinimoPixEntrada,
      maximo: cfg.ticketMaximoPixEntrada,
    };
    const faixaSaque = {
      minimo: cfg.ticketMinimoPixSaida,
      maximo: cfg.ticketMaximoPixSaida,
    };

    return {
      taxas: {
        pixEntradaPercentual: cfg.taxaPixEntradaPercentual.toString(),
        pixEntradaFixa: cfg.taxaPixEntradaFixa.toFixed(2),
        pixSaidaPercentual: cfg.taxaPixSaidaPercentual.toString(),
        pixSaidaFixa: cfg.taxaPixSaidaFixa.toFixed(2),
      },
      limites: {
        cobranca: {
          minimo: faixaCobranca.minimo.toFixed(2),
          maximo: faixaCobranca.maximo.toFixed(2),
          /**
           * A frase pronta acompanha os números porque é EXATAMENTE a que
           * aparece na recusa (`checarLimiteValor`). Se a tela montasse a sua
           * própria, um dia diria algo diferente do erro que o cliente toma.
           */
          descricao: faixaPermitidaTexto(faixaCobranca, OPERACAO_LIMITE.COBRANCA),
        },
        saque: {
          minimo: faixaSaque.minimo.toFixed(2),
          maximo: faixaSaque.maximo ? faixaSaque.maximo.toFixed(2) : null,
          descricao: faixaPermitidaTexto(faixaSaque, OPERACAO_LIMITE.SAQUE),
          limiteDiario: cfg.limiteDiarioPixSaida
            ? cfg.limiteDiarioPixSaida.toFixed(2)
            : null,
          maxPorHora: cfg.maxSaquesPorHora ?? null,
        },
      },
    };
  }
}
