import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  caminhoSemQuery,
  deveLogarErroHttp,
  mensagemDeHttpException,
} from './pino.config';

describe('log de erro HTTP', () => {
  it('caminhoSemQuery corta token da query (postback Valorion)', () => {
    expect(
      caminhoSemQuery({
        originalUrl: '/api/webhooks/valorion/pix-in?token=segredo',
      }),
    ).toBe('/api/webhooks/valorion/pix-in');
  });

  it('4xx de negócio é logável; 401 e health não', () => {
    expect(deveLogarErroHttp(400, '/api/painel/transacoes/saques')).toBe(true);
    expect(deveLogarErroHttp(403, '/api/painel/transacoes/saques')).toBe(true);
    expect(deveLogarErroHttp(500, '/api/painel/transacoes/saques')).toBe(true);
    expect(deveLogarErroHttp(401, '/api/painel/transacoes/saques')).toBe(false);
    expect(deveLogarErroHttp(503, '/health/ready')).toBe(false);
    expect(deveLogarErroHttp(200, '/api/painel/dashboard')).toBe(false);
  });

  it('extrai a mensagem de BadRequestException (o texto que o Render precisa achar)', () => {
    const e = new BadRequestException('Provedor/conta indisponível');
    expect(mensagemDeHttpException(e.getResponse())).toBe(
      'Provedor/conta indisponível',
    );
  });

  it('junta array de validação sem vazar internals', () => {
    expect(
      mensagemDeHttpException({
        statusCode: 400,
        message: ['valor must be a string', 'chavePixIdPublico should not be empty'],
        error: 'Bad Request',
      }),
    ).toBe('valor must be a string; chavePixIdPublico should not be empty');
  });

  it('UnauthorizedException existe mas 401 não vai ao log', () => {
    const e = new UnauthorizedException();
    expect(e.getStatus()).toBe(401);
    expect(deveLogarErroHttp(e.getStatus(), '/api/auth/me')).toBe(false);
  });
});
