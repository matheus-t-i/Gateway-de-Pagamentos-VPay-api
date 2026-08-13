import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { caminhoSemQuery, deveLogarErroHttp } from './pino.config';

/**
 * Converte erros conhecidos do Prisma em respostas HTTP legíveis.
 * Sem isto, violar uma constraint (ex.: nome de credencial duplicado) vira
 * "500 Internal server error" sem pista para o cliente.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<
      Request & { identificadorRastreio?: string; mensagemErroHttp?: string }
    >();
    const res = ctx.getResponse<Response>();

    const responder = (status: number, error: string, message: string) => {
      req.mensagemErroHttp = message;
      const path = caminhoSemQuery(req);
      if (deveLogarErroHttp(status, path)) {
        const linha = req.identificadorRastreio
          ? `${req.method} ${path} ${status} ${message} rastreio=${req.identificadorRastreio}`
          : `${req.method} ${path} ${status} ${message}`;
        if (status >= 500) this.logger.error(linha);
        else this.logger.warn(linha);
      }
      res.status(status).json({ statusCode: status, error, message });
    };

    switch (exception.code) {
      case 'P2002': {
        // Não expor meta.target (nomes de colunas/índices) ao cliente.
        responder(
          HttpStatus.CONFLICT,
          'Conflict',
          'Já existe um registro com estes valores.',
        );
        return;
      }
      case 'P2025':
        responder(HttpStatus.NOT_FOUND, 'Not Found', 'Registro não encontrado.');
        return;
      case 'P2003':
        responder(
          HttpStatus.BAD_REQUEST,
          'Bad Request',
          'Referência inválida (registro relacionado inexistente).',
        );
        return;
      default:
        // Código Prisma no log interno; cliente só vê mensagem genérica.
        this.logger.error(`Prisma ${exception.code}: ${exception.message}`);
        responder(
          HttpStatus.INTERNAL_SERVER_ERROR,
          'Internal Server Error',
          'Erro ao processar a requisição.',
        );
    }
  }
}
