import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EmailJobPayload, QUEUE_NAMES } from '../shared';
import { EmailService } from '../email/email.service';

/**
 * Entrega de e-mail transacional. Fica em fila (com retentativa) porque SMTP
 * é serviço externo: uma indisponibilidade não pode derrubar o cadastro nem
 * a aprovação de uma conta.
 */
@Processor(QUEUE_NAMES.EMAILS)
@Injectable()
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly email: EmailService) {
    super();
  }

  async process(job: Job<EmailJobPayload>) {
    const { tipo, para, nome, dados } = job.data;
    this.logger.log(`enviando e-mail tipo=${tipo} para=${para}`);
    const r = await this.email.enviar({ tipo, para, nome, dados });
    return { ok: true, ...r };
  }
}
