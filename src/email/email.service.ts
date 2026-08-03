import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { montarEmail, MARCA } from './email.templates';
import { TipoEmail } from '../shared';

/**
 * Envio de e-mail transacional.
 *
 * Sem SMTP configurado (dev), cai no modo LOG: o e-mail é registrado no console
 * em vez de enviado — assim o fluxo completo funciona localmente sem depender
 * de um servidor externo.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private readonly remetente: string;
  private readonly habilitado: boolean;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');
    this.remetente =
      this.config.get<string>('SMTP_FROM') ?? `${MARCA.nome} <${MARCA.email}>`;
    this.habilitado = !!host;

    if (this.habilitado) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(this.config.get<string>('SMTP_PORT') ?? 587),
        secure: this.config.get<string>('SMTP_SECURE') === 'true',
        auth: this.config.get<string>('SMTP_USER')
          ? {
              user: this.config.get<string>('SMTP_USER'),
              pass: this.config.get<string>('SMTP_PASS'),
            }
          : undefined,
      });
    } else {
      this.logger.warn(
        'SMTP_HOST não configurado — e-mails serão apenas registrados no log (modo desenvolvimento).',
      );
    }
  }

  async enviar(params: {
    tipo: TipoEmail;
    para: string;
    nome?: string;
    dados?: Record<string, string>;
  }) {
    const { assunto, texto, html } = montarEmail(
      params.tipo,
      params.nome,
      params.dados ?? {},
    );

    if (!this.transporter) {
      this.logger.log(
        `[EMAIL:LOG] tipo=${params.tipo} para=${params.para} assunto="${assunto}"` +
          (params.dados?.url ? ` url=${params.dados.url}` : ''),
      );
      return { enviado: false, modo: 'log' as const };
    }

    await this.transporter.sendMail({
      from: this.remetente,
      to: params.para,
      subject: assunto,
      text: texto,
      html,
    });
    this.logger.log(`[EMAIL] enviado tipo=${params.tipo} para=${params.para}`);
    return { enviado: true, modo: 'smtp' as const };
  }

  onModuleDestroy() {
    this.transporter?.close();
  }
}
