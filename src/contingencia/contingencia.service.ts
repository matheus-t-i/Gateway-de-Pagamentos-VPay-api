import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TIPO_FALHA_ADQUIRENTE } from '../shared';

export type TipoFalhaAdquirente =
  (typeof TIPO_FALHA_ADQUIRENTE)[keyof typeof TIPO_FALHA_ADQUIRENTE];

/**
 * Falha classificada de uma adquirente. Carrega o response cru para virar
 * linha em `falhas_adquirente` — é o que se leva para a mesa de suporte da
 * liquidante quando ela nega que houve erro.
 */
export class FalhaAdquirenteError extends Error {
  constructor(
    readonly tipo: TipoFalhaAdquirente,
    message: string,
    readonly detalhe: {
      statusHttp?: number;
      codigoErro?: string;
      dadosResposta?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'FalhaAdquirenteError';
  }
}

const TIMEOUT_PADRAO_SEGUNDOS = 10;

/** Extrai statusHttp/código/response de erros de client HTTP sem acoplar a um. */
function dissecarErro(erro: unknown): {
  mensagem: string;
  statusHttp?: number;
  codigoErro?: string;
  dadosResposta?: unknown;
} {
  if (erro instanceof FalhaAdquirenteError) {
    return {
      mensagem: erro.message,
      statusHttp: erro.detalhe.statusHttp,
      codigoErro: erro.detalhe.codigoErro,
      dadosResposta: erro.detalhe.dadosResposta,
    };
  }
  const e = erro as {
    message?: string;
    status?: number;
    statusCode?: number;
    code?: string;
    response?: { status?: number; data?: unknown };
  };
  return {
    mensagem: e?.message ?? String(erro),
    statusHttp: e?.response?.status ?? e?.status ?? e?.statusCode,
    codigoErro: e?.code,
    dadosResposta: e?.response?.data ?? (e?.message ? { message: e.message } : undefined),
  };
}

/**
 * Contingência de adquirentes: quando a adquirente principal do lojista falha
 * ao criar a cobrança, a venda não pode ser perdida — o pedido é repetido nas
 * adquirentes da cadeia (`contingencia_adquirente`), em ordem.
 *
 * Aqui ficam só o relógio (timeout), a cadeia e o registro das falhas. Quem
 * orquestra as tentativas é o `PixService`, que é dono da transação e dos
 * snapshots de custo.
 */
@Injectable()
export class ContingenciaService {
  private readonly log = new Logger(ContingenciaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Teto de espera por adquirente, em ms. */
  timeoutMs(): number {
    const bruto = Number(this.config.get<string>('CONTINGENCIA_TIMEOUT_SEGUNDOS'));
    const segundos =
      Number.isFinite(bruto) && bruto > 0 ? bruto : TIMEOUT_PADRAO_SEGUNDOS;
    return Math.round(segundos * 1000);
  }

  /**
   * Corre a chamada contra o relógio e ABORTA o fetch em voo.
   *
   * `Promise.race` sozinho deixava o HTTP da adquirente A completar depois do
   * timeout — cobrança criada sem id local, enquanto a cadeia gerava QR em B.
   * Com AbortSignal o pedido é cancelado; TIMEOUT ainda NÃO segue a cadeia
   * (ver `PixService`), porque a liquidante pode ter aceitado antes do abort.
   */
  async executarComTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ms = this.timeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fn(controller.signal);
    } catch (erro) {
      if (
        controller.signal.aborted ||
        (erro instanceof Error &&
          (erro.name === 'AbortError' || /aborted|abort/i.test(erro.message)))
      ) {
        throw new FalhaAdquirenteError(
          TIPO_FALHA_ADQUIRENTE.TIMEOUT,
          `Adquirente não respondeu em ${ms / 1000}s (pedido abortado)`,
        );
      }
      throw erro;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cadeia de contingência ativa, na ordem de tentativa. Só entram contas
   * ativas e habilitadas para cash-in — uma conta desligada na tela de
   * adquirentes não pode voltar pela porta dos fundos da contingência.
   */
  async cadeia() {
    const linhas = await this.prisma.contingenciaAdquirente.findMany({
      where: {
        ativo: true,
        contaProvedor: {
          situacao: 'ATIVO',
          pixEntradaHabilitado: true,
          provedor: { situacao: 'ATIVO', permitePixEntrada: true },
        },
      },
      orderBy: { ordem: 'asc' },
      include: { contaProvedor: { include: { provedor: true, custoPix: true } } },
    });
    return linhas.map((l) => ({ ordem: l.ordem, conta: l.contaProvedor }));
  }

  /** Grava a falha com o response cru preservado. Nunca lança. */
  async registrarFalha(params: {
    transacaoId?: bigint;
    usuarioId?: bigint;
    contaProvedorId: bigint;
    tipo: TipoFalhaAdquirente;
    ordemTentativa: number;
    erro: unknown;
    dadosRequisicao?: Record<string, unknown>;
    latenciaMs?: number;
  }) {
    const d = dissecarErro(params.erro);
    try {
      await this.prisma.falhaAdquirente.create({
        data: {
          transacaoId: params.transacaoId,
          usuarioId: params.usuarioId,
          contaProvedorId: params.contaProvedorId,
          tipo: params.tipo,
          ordemTentativa: params.ordemTentativa,
          mensagem: d.mensagem?.slice(0, 2000),
          statusHttp: d.statusHttp,
          codigoErro: d.codigoErro?.slice(0, 100),
          dadosRequisicao: (params.dadosRequisicao ?? undefined) as never,
          dadosResposta: (d.dadosResposta ?? undefined) as never,
          latenciaMs: params.latenciaMs,
        },
      });
    } catch (e) {
      // Monitoramento não pode derrubar a venda: se o registro falhar, a
      // contingência segue e o erro fica no log.
      this.log.error(
        `Falha ao registrar falha de adquirente: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Fecha o ciclo: marca em quais adquirentes a venda foi salva. É o que
   * responde "onde a cobrança acabou sendo gerada" na tela de monitoramento.
   */
  async marcarResolvidas(transacaoId: bigint, contaProvedorId: bigint) {
    try {
      await this.prisma.falhaAdquirente.updateMany({
        where: { transacaoId, resolvidaPorContaProvedorId: null },
        data: { resolvidaPorContaProvedorId: contaProvedorId, resolvidaEm: new Date() },
      });
    } catch (e) {
      this.log.error(`Falha ao marcar resolução: ${(e as Error).message}`);
    }
  }

  /** Classifica um erro solto vindo do client do provedor. */
  static classificar(erro: unknown): TipoFalhaAdquirente {
    if (erro instanceof FalhaAdquirenteError) return erro.tipo;
    return TIPO_FALHA_ADQUIRENTE.ERRO_PROVEDOR;
  }
}
