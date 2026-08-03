import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Converte erros conhecidos do Prisma em respostas HTTP legíveis.
 * Sem isto, violar uma constraint (ex.: nome de credencial duplicado) vira
 * "500 Internal server error" sem pista para o cliente.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    switch (exception.code) {
      case 'P2002': {
        const alvo = (exception.meta?.target as string[] | undefined)?.join(', ');
        res.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          message: alvo
            ? `Já existe um registro com estes valores (${alvo}).`
            : 'Registro duplicado.',
        });
        return;
      }
      case 'P2025':
        res.status(HttpStatus.NOT_FOUND).json({
          statusCode: HttpStatus.NOT_FOUND,
          error: 'Not Found',
          message: 'Registro não encontrado.',
        });
        return;
      case 'P2003':
        res.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          message: 'Referência inválida (registro relacionado inexistente).',
        });
        return;
      default:
        // Não expor detalhes internos do banco ao cliente.
        this.logger.error(`Prisma ${exception.code}: ${exception.message}`);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Internal Server Error',
          message: 'Erro ao processar a requisição.',
        });
    }
  }
}
