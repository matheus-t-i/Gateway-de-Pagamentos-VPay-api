import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUE_NAMES, SaqueAutomaticoJobPayload } from '../shared';
import { TesourariaService } from '../tesouraria/tesouraria.service';

/**
 * Saque automático do saldo parado na adquirente.
 *
 * Sem `execucaoId` o job é o tick periódico; com `execucaoId` é o disparo
 * manual do painel. O tick roda a cada minuto, mas quem define a frequência de
 * cada saque é o `intervaloMinimoMinutos` do gatilho.
 */
@Processor(QUEUE_NAMES.SAQUE_AUTOMATICO)
@Injectable()
export class SaqueAutomaticoProcessor extends WorkerHost {
  private readonly logger = new Logger(SaqueAutomaticoProcessor.name);

  constructor(private readonly tesouraria: TesourariaService) {
    super();
  }

  async process(job: Job<SaqueAutomaticoJobPayload>) {
    if (job.data.execucaoId) {
      return this.tesouraria.processarExecucao(BigInt(job.data.execucaoId));
    }

    const contas = await this.tesouraria.atualizarTodosSaldos();
    const reconciliadas = await this.tesouraria.reconciliarPendentes();
    const criadas = await this.tesouraria.avaliarGatilhos();

    // Uma adquirente que recusa o saque não pode impedir as outras de sacarem —
    // por isso cada execução é isolada e a falha fica registrada na própria
    // execução (FALHA + mensagem), visível na tela de saldos.
    let disparadas = 0;
    for (const execucaoId of criadas) {
      try {
        await this.tesouraria.processarExecucao(BigInt(execucaoId));
        disparadas += 1;
      } catch (e) {
        this.logger.error(
          `execução ${execucaoId} falhou: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    if (criadas.length > 0 || reconciliadas > 0) {
      this.logger.log(
        `tick tesouraria: contas=${contas} reconciliadas=${reconciliadas} disparadas=${disparadas}/${criadas.length}`,
      );
    }
    return { contas, reconciliadas, criadas: criadas.length, disparadas };
  }
}
