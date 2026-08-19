import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  JWT_AUDIENCE_API,
  JWT_AUDIENCE_PAINEL,
  JWT_ISSUER,
} from '../common/jwt-claims';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiTokenGuard } from './api-token.guard';
import { CredencialAuthService } from './credencial-auth.service';
import { RateLimitService } from './rate-limit.service';
import { TIPO_TOKEN_API, TokenApiController } from './token.controller';
import { BullBoardAuthMiddleware } from '../queues/bull-board.middleware';
import { RegistroAcessoApiMiddleware } from '../seguranca/registro-acesso-api.middleware';

/**
 * O token da API pública e o JWT de sessão do painel são assinados com o MESMO
 * `JWT_SECRET`. O que os separa é o claim `tipo` + audience — e estes testes
 * garantem que a separação vale nos DOIS sentidos.
 */
describe('token da API pública (Bearer)', () => {
  const jwt = new JwtService({ secret: 'segredo-de-teste' });

  const credencial = {
    id: '42',
    usuarioId: '7',
    escopos: ['pix.cobranca.criar'],
    temIpAllowlist: false,
    exigirAssinaturaHmac: false,
    segredoHmacCriptografado: null,
    segredoHmacAnteriorCriptografado: null,
  };

  const credAuth = {
    carregarCredencialAtiva: jest.fn().mockResolvedValue(credencial),
  } as unknown as CredencialAuthService;

  const rateLimit = {
    reservarNonceHmac: jest.fn().mockResolvedValue(true),
  } as unknown as RateLimitService;

  const config = {
    get: jest.fn().mockReturnValue('false'),
  } as unknown as ConfigService;

  function contexto(
    authorization?: string,
    headersExtras: Record<string, string> = {},
  ) {
    const req: Record<string, unknown> = {
      headers: authorization ? { authorization, ...headersExtras } : headersExtras,
      ip: '127.0.0.1',
      path: '/v1/pix/cobrancas',
      method: 'POST',
      body: {},
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => function handler() {},
      getClass: () => class Classe {},
    } as unknown as ExecutionContext;
    return { ctx, req };
  }

  function guard() {
    return new ApiTokenGuard(jwt, credAuth, rateLimit, config);
  }

  const signApi = (payload: object, extras?: object) =>
    jwt.signAsync(payload, {
      expiresIn: 3600,
      issuer: JWT_ISSUER(),
      audience: JWT_AUDIENCE_API(),
      ...extras,
    });

  const signPainel = (payload: object) =>
    jwt.signAsync(payload, {
      expiresIn: 3600,
      issuer: JWT_ISSUER(),
      audience: JWT_AUDIENCE_PAINEL(),
    });

  beforeEach(() => jest.clearAllMocks());

  it('aceita o token emitido em /v1/auth/token e injeta req.apiCredential', async () => {
    const token = await signApi({ sub: '42', tipo: TIPO_TOKEN_API });
    const { ctx, req } = contexto(`Bearer ${token}`);

    await expect(guard().canActivate(ctx)).resolves.toBe(true);
    expect(req.apiCredential).toEqual(credencial);
    expect(credAuth.carregarCredencialAtiva).toHaveBeenCalledWith(BigInt(42), {
      ip: '127.0.0.1',
      path: '/v1/pix/cobrancas',
    });
  });

  /**
   * Regressão: atrás de Cloudflare+Render, `req.ip` é o edge da CF — a allowlist
   * da credencial comparava com ele e recusava o IP real do lojista com
   * "IP não permitido". O IP tem que vir de `extrairIpCliente` (cf-connecting-ip)
   * nos DOIS pontos: guard Bearer e emissão do token.
   */
  it('guard Bearer valida allowlist pelo cf-connecting-ip, não pelo req.ip', async () => {
    const token = await signApi({ sub: '42', tipo: TIPO_TOKEN_API });
    const { ctx } = contexto(`Bearer ${token}`, {
      'cf-connecting-ip': '179.51.222.151',
    });

    await expect(guard().canActivate(ctx)).resolves.toBe(true);
    expect(credAuth.carregarCredencialAtiva).toHaveBeenCalledWith(BigInt(42), {
      ip: '179.51.222.151',
      path: '/v1/pix/cobrancas',
    });
  });

  it('emissão do token valida allowlist pelo cf-connecting-ip, não pelo req.ip', async () => {
    const credAuthEmissao = {
      autenticarPorChaveSegredo: jest.fn().mockResolvedValue(credencial),
    } as unknown as CredencialAuthService;
    const configEmissao = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const controller = new TokenApiController(credAuthEmissao, jwt, configEmissao);

    await controller.emitir({
      headers: {
        'x-api-key': 'vp_chave',
        'x-api-secret': 'segredo',
        'cf-connecting-ip': '179.51.222.151',
      },
      ip: '104.23.1.1',
      path: '/v1/auth/token',
    });

    expect(credAuthEmissao.autenticarPorChaveSegredo).toHaveBeenCalledWith(
      'vp_chave',
      'segredo',
      { ip: '179.51.222.151', path: '/v1/auth/token' },
    );
  });

  /**
   * Regressão da tela /admin/seguranca: a trilha identifica o autor por
   * `req.apiCredential`, que nas rotas de negócio é setado pelo guard. Na
   * emissão a autenticação acontece no controller — sem repassar a credencial
   * para a request, o evento mais sensível da API pública (alguém provou posse
   * do segredo) era gravado como "não identificado".
   */
  it('emissão popula req.apiCredential para a trilha de segurança', async () => {
    const credAuthEmissao = {
      autenticarPorChaveSegredo: jest.fn().mockResolvedValue(credencial),
    } as unknown as CredencialAuthService;
    const configEmissao = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const controller = new TokenApiController(credAuthEmissao, jwt, configEmissao);

    const req: {
      headers: Record<string, string | undefined>;
      apiCredential?: { id: string; usuarioId: string };
    } = { headers: { 'x-api-key': 'vp_chave', 'x-api-secret': 'segredo' } };

    await controller.emitir(req);

    expect(req.apiCredential).toMatchObject({ id: '42', usuarioId: '7' });
  });

  /**
   * Fecha o buraco que o teste acima sozinho não fecha: prova que a TRILHA
   * grava a emissão IDENTIFICADA. A trilha registra `res.on('finish')` no
   * início do `use()` — ANTES de o controller mutar `req.apiCredential` — e só
   * lê a credencial quando o finish dispara. Compor os dois sobre o MESMO `req`
   * (use → emitir → finish) mata a regressão de "capturar a credencial no
   * início do use()", que passaria nos dois specs isolados e ressuscitaria o
   * usuarioId nulo na auditoria.
   */
  it('a trilha grava a emissão com usuarioId, lendo a credencial APÓS o emitir', async () => {
    const credAuthEmissao = {
      autenticarPorChaveSegredo: jest.fn().mockResolvedValue(credencial),
    } as unknown as CredencialAuthService;
    const configEmissao = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const controller = new TokenApiController(credAuthEmissao, jwt, configEmissao);

    const create = jest.fn((_arg: { data: Record<string, unknown> }) =>
      Promise.resolve({}),
    );
    const trilha = new RegistroAcessoApiMiddleware({
      registroAcessoApi: { create },
    } as never);

    const ouvintes: Array<() => void> = [];
    const res = {
      statusCode: 201,
      on: (evento: string, cb: () => void) => {
        if (evento === 'finish') ouvintes.push(cb);
      },
    };
    const req: Record<string, unknown> = {
      method: 'POST',
      path: '/api/v1/auth/token',
      ip: '203.0.113.9',
      headers: { 'x-api-key': 'vp_chave', 'x-api-secret': 'segredo' },
    };

    // Ordem real do main.ts: trilha registra o finish, DEPOIS o handler roda.
    trilha.use(req as never, res as never, () => {});
    await controller.emitir(req as never);
    ouvintes.forEach((cb) => cb());
    await new Promise((r) => setImmediate(r));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      usuarioId: BigInt(7),
      credencialApiId: BigInt(42),
      statusHttp: 201,
    });
  });

  it('recusa requisição sem Authorization', async () => {
    await expect(guard().canActivate(contexto().ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('JWT de sessão do painel NÃO abre a API pública', async () => {
    const tokenPainel = await signPainel({
      sub: '42',
      email: 'a@b.c',
      papeis: ['CLIENTE'],
    });
    await expect(
      guard().canActivate(contexto(`Bearer ${tokenPainel}`).ctx),
    ).rejects.toThrow('Token de acesso inválido');
  });

  it('token da API NÃO abre o painel (JwtAuthGuard)', async () => {
    const prisma = {
      usuario: { findUnique: jest.fn() },
    };
    const painelGuard = new JwtAuthGuard(
      jwt,
      prisma as never,
      new Reflector(),
    );
    const tokenApi = await signApi({ sub: '1', tipo: TIPO_TOKEN_API });
    const { ctx } = contexto(`Bearer ${tokenApi}`);
    await expect(painelGuard.canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.usuario.findUnique).not.toHaveBeenCalled();
  });

  it('token expirado devolve mensagem específica', async () => {
    const vencido = await signApi(
      { sub: '42', tipo: TIPO_TOKEN_API },
      { expiresIn: -10 },
    );
    await expect(
      guard().canActivate(contexto(`Bearer ${vencido}`).ctx),
    ).rejects.toThrow(/expirado/i);
  });

  it('token forjado com outro segredo é recusado', async () => {
    const outroSegredo = new JwtService({ secret: 'outro' });
    const forjado = await outroSegredo.signAsync(
      { sub: '42', tipo: TIPO_TOKEN_API },
      {
        expiresIn: 3600,
        issuer: JWT_ISSUER(),
        audience: JWT_AUDIENCE_API(),
      },
    );
    await expect(
      guard().canActivate(contexto(`Bearer ${forjado}`).ctx),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('Bull Board recusa token da API pública', async () => {
    const prisma = {
      usuario: { findUnique: jest.fn() },
    };
    const mw = new BullBoardAuthMiddleware(jwt, prisma as never);
    const token = await signApi({ sub: '1', tipo: TIPO_TOKEN_API });
    const req = {
      headers: { authorization: `Bearer ${token}` },
    } as never;
    const res = {} as never;
    const next = jest.fn();
    await expect(mw.use(req, res, next)).rejects.toThrow();
    expect(prisma.usuario.findUnique).not.toHaveBeenCalled();
  });
});
