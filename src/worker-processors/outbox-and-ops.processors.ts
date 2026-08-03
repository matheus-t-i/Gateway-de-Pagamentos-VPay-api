import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  LiberacaoSaldoJobPayload,
  OutboxPublishJobPayload,
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_ENTREGA_WEBHOOK,
  SITUACAO_LIBERACAO,
  SITUACAO_PROVEDOR,
  SITUACAO_TRANSACAO,
  money,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { QueuesService } from '../queues/queues.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { decryptCredentials, decryptText } from '../common/crypto.util';

/** Um lugar para onde este evento deve ser entregue. */
type Destino = {
  url: string;
  configuracaoWebhookId: bigint | null;
  nomeHeaderAutenticacao: string | null;
  segredo: string | null;
  origem: 'PAINEL' | 'OPERACAO';
};

/**
 * Normaliza a URL só para COMPARAR destinos. Sem isto,
 * `https://site.com/hook` e `https://site.com/hook/` seriam tratadas como
 * endereços diferentes e o lojista receberia o callback duas vezes.
 * A URL original é preservada para o envio.
 */
function chaveUrl(url: string): string {
  try {
    const u = new URL(url);
    const caminho = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${caminho}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

@Processor(QUEUE_NAMES.PIX_WEBHOOK_SEND)
@Injectable()
export class PixWebhookSendProcessor extends WorkerHost {
  private readonly logger = new Logger(PixWebhookSendProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<PixJobPayload>) {
    const payload = job.data.payload as {
      tipoEvento: string;
      idPublico: string;
      empresaId: string;
      eventoOutboxId?: string;
      conteudo?: unknown;
    };
    this.logger.log(`entregando webhook lojista evento=${payload.tipoEvento}`);

    // Corpo público enviado ao lojista: nunca vazar ids internos (empresaId,
    // eventoOutboxId). A transação é referenciada apenas como idTransacao.
    const corpoEnvio = JSON.stringify({
      tipoEvento: payload.tipoEvento,
      idTransacao: payload.idPublico,
      dados: payload.conteudo ?? null,
      ocorridoEm: new Date().toISOString(),
    });

    const empresaId = BigInt(payload.empresaId);

    let eventoOutboxId = payload.eventoOutboxId
      ? BigInt(payload.eventoOutboxId)
      : undefined;

    if (!eventoOutboxId) {
      const outbox = await this.prisma.eventoOutbox.findFirst({
        where: {
          empresaId,
          identificadorAgregado: payload.idPublico,
          tipoEvento: payload.tipoEvento,
        },
        orderBy: { id: 'desc' },
      });
      eventoOutboxId = outbox?.id;
    }
    if (!eventoOutboxId) return { ok: true, entregas: 0, motivo: 'sem evento outbox' };

    const destinos = await this.resolverDestinos(
      empresaId,
      payload.idPublico,
      payload.tipoEvento,
    );

    // Uma falha não pode impedir os outros destinos de receberem: entrega todos
    // e só então propaga o erro para o BullMQ retentar.
    let primeiroErro: unknown = null;
    for (const destino of destinos) {
      try {
        await this.entregar(destino, eventoOutboxId, empresaId, corpoEnvio);
      } catch (e) {
        primeiroErro ??= e;
      }
    }
    if (primeiroErro) throw primeiroErro;

    return { ok: true, entregas: destinos.length };
  }

  /**
   * Destinos deste evento: os webhooks do painel que assinam o tipo, mais o
   * `urlCallback` informado na criação da operação.
   *
   * URLs repetidas entram uma vez só — o cadastro do painel tem prioridade
   * porque é ele que carrega o header de autenticação.
   */
  private async resolverDestinos(
    empresaId: bigint,
    idTransacaoPublico: string,
    tipoEvento: string,
  ): Promise<Destino[]> {
    const configs = await this.prisma.configuracaoWebhookEmpresa.findMany({
      where: { empresaId, ativo: true },
      orderBy: { id: 'asc' },
    });

    const destinos: Destino[] = [];
    const vistos = new Set<string>();

    for (const cfg of configs) {
      const tipos = (cfg.tiposEvento as string[]) ?? [];
      if (tipos.length > 0 && !tipos.includes(tipoEvento)) continue;
      const chave = chaveUrl(cfg.urlDestino);
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      destinos.push({
        url: cfg.urlDestino,
        configuracaoWebhookId: cfg.id,
        nomeHeaderAutenticacao: cfg.nomeHeaderAutenticacao,
        segredo: this.segredoDe(cfg.segredoCriptografado),
        origem: 'PAINEL',
      });
    }

    const tx = await this.prisma.transacao.findFirst({
      where: { idTransacaoPublico, empresaId },
      select: { urlCallback: true },
    });
    if (tx?.urlCallback && !vistos.has(chaveUrl(tx.urlCallback))) {
      // SEM header de autenticação: a credencial pertence ao webhook cadastrado
      // no painel e não vaza para uma URL passada solta na criação do PIX —
      // senão qualquer chamada da API levaria o segredo para onde quisesse.
      destinos.push({
        url: tx.urlCallback,
        configuracaoWebhookId: null,
        nomeHeaderAutenticacao: null,
        segredo: null,
        origem: 'OPERACAO',
      });
    }

    return destinos;
  }

  private segredoDe(criptografado: string | null): string | null {
    if (!criptografado) return null;
    try {
      return decryptText(criptografado);
    } catch {
      // Chave de criptografia trocada: melhor entregar sem o header do que
      // deixar o lojista sem callback nenhum.
      this.logger.warn('não foi possível decifrar o segredo do webhook');
      return null;
    }
  }

  private async entregar(
    destino: Destino,
    eventoOutboxId: bigint,
    empresaId: bigint,
    corpoEnvio: string,
  ) {
    const tentativa =
      (await this.prisma.entregaWebhook.count({
        where: { eventoOutboxId, configuracaoWebhookId: destino.configuracaoWebhookId },
      })) + 1;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (destino.nomeHeaderAutenticacao && destino.segredo) {
      headers[destino.nomeHeaderAutenticacao] = destino.segredo;
    }

    const started = Date.now();
    try {
      const res = await fetch(destino.url, {
        method: 'POST',
        headers,
        body: corpoEnvio,
      });
      const corpo = (await res.text()).slice(0, 2000);
      await this.prisma.entregaWebhook.create({
        data: {
          eventoOutboxId,
          configuracaoWebhookId: destino.configuracaoWebhookId,
          urlDestino: destino.url,
          empresaId,
          numeroTentativa: tentativa,
          situacao: res.ok
            ? SITUACAO_ENTREGA_WEBHOOK.SUCESSO
            : SITUACAO_ENTREGA_WEBHOOK.FALHA,
          statusHttp: res.status,
          corpoResposta: corpo,
          latenciaMs: Date.now() - started,
          enviadoEm: new Date(),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e);
      await this.prisma.entregaWebhook.create({
        data: {
          eventoOutboxId,
          configuracaoWebhookId: destino.configuracaoWebhookId,
          urlDestino: destino.url,
          empresaId,
          numeroTentativa: tentativa,
          situacao: SITUACAO_ENTREGA_WEBHOOK.FALHA,
          mensagemErro: erro,
          latenciaMs: Date.now() - started,
          enviadoEm: new Date(),
        },
      });
      throw e;
    }
  }
}

@Processor(QUEUE_NAMES.OUTBOX_PUBLISHER)
@Injectable()
export class OutboxPublisherProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxPublisherProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {
    super();
  }

  async process(job: Job<OutboxPublishJobPayload>) {
    const candidatos = job.data.eventoOutboxId
      ? await this.prisma.eventoOutbox.findMany({
          where: { id: BigInt(job.data.eventoOutboxId), publicadoRedisEm: null },
        })
      : await this.prisma.eventoOutbox.findMany({
          where: { publicadoRedisEm: null },
          take: 50,
          orderBy: { id: 'asc' },
        });

    // Claim atômico: só publica quem conseguiu marcar publicadoRedisEm (0 -> 1).
    // Sem isto, o job periódico e o enfileiramento direto processam o mesmo
    // evento em paralelo e o lojista recebe o callback várias vezes.
    const pending = [];
    for (const ev of candidatos) {
      const claim = await this.prisma.eventoOutbox.updateMany({
        where: { id: ev.id, publicadoRedisEm: null },
        data: { publicadoRedisEm: new Date() },
      });
      if (claim.count === 1) pending.push(ev);
    }

    for (const ev of pending) {
      try {
        await this.queues.enqueuePixWebhookSend({
          provider: 'system',
          payload: {
            tipoEvento: ev.tipoEvento,
            idPublico: ev.identificadorAgregado,
            empresaId: ev.empresaId?.toString() ?? '',
            eventoOutboxId: ev.id.toString(),
            conteudo: ev.conteudo,
          },
          identificadorRastreio: job.data.identificadorRastreio,
        });
      } catch (e) {
        this.logger.error(e);
        // Falhou ao enfileirar: devolve o claim para nova tentativa.
        await this.prisma.eventoOutbox.update({
          where: { id: ev.id },
          data: {
            publicadoRedisEm: null,
            quantidadeTentativasPublicacao: { increment: 1 },
            ultimoErroPublicacao: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
    return { published: pending.length };
  }
}

@Processor(QUEUE_NAMES.LIBERACAO_SALDO)
@Injectable()
export class LiberacaoSaldoProcessor extends WorkerHost {
  private readonly logger = new Logger(LiberacaoSaldoProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {
    super();
  }

  async process(_job: Job<LiberacaoSaldoJobPayload>) {
    const due = await this.prisma.liberacaoSaldo.findMany({
      where: { situacao: SITUACAO_LIBERACAO.AGENDADA, liberarEm: { lte: new Date() } },
      take: 50,
    });
    this.logger.log(`liberacoes vencidas: ${due.length}`);

    for (const lib of due) {
      await this.prisma.liberacaoSaldo.update({
        where: { id: lib.id },
        data: {
          situacao: SITUACAO_LIBERACAO.PROCESSANDO,
          quantidadeTentativas: { increment: 1 },
        },
      });
      try {
        const from =
          lib.tipoLiberacao === 'RESERVA' ? 'RESERVADO' : 'PENDENTE_LIBERACAO';
        const result = await this.ledger.aplicarMovimentacoes({
          empresaId: lib.empresaId,
          entries: [
            {
              tipoSaldo: from,
              tipoMovimento: 'DEBITO',
              natureza: 'LIBERACAO',
              valor: money(lib.valor.toString()),
              chaveIdempotencia: `lib:deb:${lib.id}`,
              transacaoId: lib.transacaoId,
              descricao: `Liberação ${lib.tipoLiberacao}`,
            },
            {
              tipoSaldo: 'DISPONIVEL',
              tipoMovimento: 'CREDITO',
              natureza: 'LIBERACAO',
              valor: money(lib.valor.toString()),
              chaveIdempotencia: `lib:cred:${lib.id}`,
              transacaoId: lib.transacaoId,
              descricao: `Liberação ${lib.tipoLiberacao} → disponível`,
            },
          ],
        });
        await this.prisma.liberacaoSaldo.update({
          where: { id: lib.id },
          data: {
            situacao: SITUACAO_LIBERACAO.LIBERADA,
            processadoEm: new Date(),
            movimentacaoLiberacaoId: result.movimentacoes[1]?.id,
          },
        });
      } catch (e) {
        await this.prisma.liberacaoSaldo.update({
          where: { id: lib.id },
          data: {
            situacao: SITUACAO_LIBERACAO.FALHA,
            ultimoErro: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
    return { processed: due.length };
  }
}

@Processor(QUEUE_NAMES.CONCILIACAO)
@Injectable()
export class ConciliacaoProcessor extends WorkerHost {
  private readonly logger = new Logger(ConciliacaoProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
  ) {
    super();
  }

  async process() {
    const pendentes = await this.prisma.transacao.findMany({
      where: {
        situacao: {
          in: [
            SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO,
            SITUACAO_TRANSACAO.PROCESSANDO,
          ],
        },
        criadoEm: { lte: new Date(Date.now() - 5 * 60 * 1000) },
      },
      take: 30,
      include: {
        contaProvedor: { include: { provedor: true } },
        tentativas: { orderBy: { numeroTentativa: 'desc' }, take: 1 },
      },
    });
    this.logger.log(`conciliação pendentes=${pendentes.length}`);

    for (const tx of pendentes) {
      if (
        !tx.contaProvedor ||
        tx.contaProvedor.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO
      )
        continue;
      const liquidanteId = tx.tentativas[0]?.idTransacaoLiquidante;
      if (!liquidanteId) continue;
      let credenciais: Record<string, unknown>;
      try {
        credenciais = decryptCredentials(tx.contaProvedor.credenciaisCriptografadas);
      } catch {
        credenciais = JSON.parse(tx.contaProvedor.credenciaisCriptografadas);
      }
      try {
        const status = await this.providers.get(tx.contaProvedor.provedor.codigo).getStatus({
          idTransacaoLiquidante: liquidanteId,
          idTransacaoPrivado: tx.idTransacaoPrivado,
          credenciais,
        });
        this.logger.debug(
          `tx ${tx.idTransacaoPublico} remote=${status.status}`,
        );
      } catch (e) {
        this.logger.warn(`falha conciliação ${tx.id}: ${e}`);
      }
    }
    return { checked: pendentes.length };
  }
}
