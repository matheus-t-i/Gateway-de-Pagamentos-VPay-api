import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { IntegracaoEnvioJobPayload, QUEUE_NAMES } from '../shared';
import { IntegracoesService } from '../integracoes/integracoes.service';

/**
 * Entrega de pedidos aos apps que o lojista conectou (Utmify e afins).
 *
 * Fila separada da entrega de callback: aqui não há dinheiro em jogo — o pior
 * caso é o relatório de campanha do lojista ficar desatualizado. Por isso o job
 * só relança em falha RETENTÁVEL (timeout, 5xx); recusa definitiva (payload
 * inválido, token errado, janela de 7/45 dias da Utmify estourada) já foi
 * gravada em `envios_integracao` e não vira retentativa, para não encher a fila
 * de trabalho que nunca vai passar.
 */
@Processor(QUEUE_NAMES.INTEGRACAO_ENVIO)
@Injectable()
export class IntegracaoEnvioProcessor extends WorkerHost {
  private readonly logger = new Logger(IntegracaoEnvioProcessor.name);

  constructor(private readonly integracoes: IntegracoesService) {
    super();
  }

  async process(job: Job<IntegracaoEnvioJobPayload>) {
    const envioId = BigInt(job.data.envioId);
    const r = await this.integracoes.processarEnvio(envioId);
    if (!r.ok) {
      this.logger.warn(`envio ${job.data.envioId} não entregue: ${r.motivo}`);
    }
    return r;
  }
}
