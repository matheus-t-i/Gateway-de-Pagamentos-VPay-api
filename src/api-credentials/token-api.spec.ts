import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiTokenGuard } from './api-token.guard';
import { CredencialAuthService } from './credencial-auth.service';
import { TIPO_TOKEN_API } from './token.controller';
import { BullBoardAuthMiddleware } from '../queues/bull-board.middleware';

/**
 * O token da API pública e o JWT de sessão do painel são assinados com o MESMO
 * `JWT_SECRET`. O que os separa é o claim `tipo` — e estes testes garantem que
 * a separação vale nos DOIS sentidos: um token de API tem `sub` = id de
 * CREDENCIAL, e aceito no painel viraria sessão do usuário que por acaso
 * tivesse o mesmo id numérico.
 */
describe('token da API pública (Bearer)', () => {
  const jwt = new JwtService({ secret: 'segredo-de-teste' });

  const credencial = {
    id: '42',
    usuarioId: '7',
    escopos: ['pix.cobranca.criar'],
    temIpAllowlist: false,
  };

  const credAuth = {
    carregarCredencialAtiva: jest.fn().mockResolvedValue(credencial),
  } as unknown as CredencialAuthService;

  function contexto(authorization?: string) {
    const req: Record<string, unknown> = {
      headers: authorization ? { authorization } : {},
      ip: '127.0.0.1',
      path: '/v1/pix/cobrancas',
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => function handler() {},
      getClass: () => class Classe {},
    } as unknown as ExecutionContext;
    return { ctx, req };
  }

  beforeEach(() => jest.clearAllMocks());

  it('aceita o token emitido em /v1/auth/token e injeta req.apiCredential', async () => {
    const guard = new ApiTokenGuard(jwt, credAuth);
    const token = await jwt.signAsync(
      { sub: '42', tipo: TIPO_TOKEN_API },
      { expiresIn: 3600 },
    );
    const { ctx, req } = contexto(`Bearer ${token}`);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.apiCredential).toEqual(credencial);
    expect(credAuth.carregarCredencialAtiva).toHaveBeenCalledWith(BigInt(42), {
      ip: '127.0.0.1',
      path: '/v1/pix/cobrancas',
    });
  });

  it('recusa requisição sem Authorization', async () => {
    const guard = new ApiTokenGuard(jwt, credAuth);
    await expect(guard.canActivate(contexto().ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('JWT de sessão do painel NÃO abre a API pública', async () => {
    const guard = new ApiTokenGuard(jwt, credAuth);
    // Mesmo formato que o login emite: sub/email/papeis, sem `tipo`.
    const tokenPainel = await jwt.signAsync(
      { sub: '42', email: 'a@b.c', papeis: ['CLIENTE'] },
      { expiresIn: 3600 },
    );
    await expect(
      guard.canActivate(contexto(`Bearer ${tokenPainel}`).ctx),
    ).rejects.toThrow('Token de acesso inválido');
    expect(credAuth.carregarCredencialAtiva).not.toHaveBeenCalled();
  });

  it('token de API NÃO abre o painel', async () => {
    const prisma = { usuario: { findUnique: jest.fn() } };
    const guard = new JwtAuthGuard(
      jwt,
      prisma as never,
      new Reflector(),
    );
    const tokenApi = await jwt.signAsync(
      { sub: '42', tipo: TIPO_TOKEN_API },
      { expiresIn: 3600 },
    );
    await expect(
      guard.canActivate(contexto(`Bearer ${tokenApi}`).ctx),
    ).rejects.toThrow('Token inválido');
    // Recusado ANTES de tocar o banco: o sub nem chega a ser tratado como usuário.
    expect(prisma.usuario.findUnique).not.toHaveBeenCalled();
  });

  it('token expirado responde 401 orientando a reemitir', async () => {
    const guard = new ApiTokenGuard(jwt, credAuth);
    const vencido = await jwt.signAsync(
      { sub: '42', tipo: TIPO_TOKEN_API },
      { expiresIn: -1 },
    );
    await expect(
      guard.canActivate(contexto(`Bearer ${vencido}`).ctx),
    ).rejects.toThrow('Token de acesso expirado. Gere um novo em POST /v1/auth/token.');
  });

  it('assinatura estranha responde 401 genérico', async () => {
    const guard = new ApiTokenGuard(jwt, credAuth);
    const outroSegredo = new JwtService({ secret: 'outro' });
    const forjado = await outroSegredo.signAsync(
      { sub: '42', tipo: TIPO_TOKEN_API },
      { expiresIn: 3600 },
    );
    await expect(
      guard.canActivate(contexto(`Bearer ${forjado}`).ctx),
    ).rejects.toThrow('Token de acesso inválido');
  });
});

/**
 * O Bull Board (/admin/queues) é um TERCEIRO verificador do mesmo `JWT_SECRET`,
 * fora do `JwtAuthGuard` (middleware Express). Ele precisa replicar a separação
 * por claim `tipo`: sem isso, um token de API (`sub` = id de CREDENCIAL) cujo
 * número colide com o id de um ADMINISTRADOR abriria as filas como admin.
 */
describe('BullBoardAuthMiddleware — token de API não abre as filas', () => {
  const jwt = new JwtService({ secret: 'segredo-de-teste' });

  function resposta() {
    const r: { statusCode?: number; body?: string; status: (n: number) => typeof r; send: (b: string) => void } = {
      status(n: number) {
        r.statusCode = n;
        return r;
      },
      send(b: string) {
        r.body = b;
      },
    };
    return r;
  }

  it('token de API (claim tipo) recebe 401 sem sequer tocar o banco', async () => {
    const prisma = { usuario: { findUnique: jest.fn() } };
    const mw = new BullBoardAuthMiddleware(jwt, prisma as never);
    const token = await jwt.signAsync(
      { sub: '1', tipo: TIPO_TOKEN_API },
      { expiresIn: 3600 },
    );
    const res = resposta();
    const next = jest.fn();
    await mw.use(
      { headers: { authorization: `Bearer ${token}` } } as never,
      res as never,
      next as never,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    // O sub nem chega a ser tratado como id de usuário.
    expect(prisma.usuario.findUnique).not.toHaveBeenCalled();
  });

  it('JWT de sessão do painel de um ADMINISTRADOR ativo passa', async () => {
    const prisma = {
      usuario: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1n,
          situacao: 'ATIVO',
          contaBloqueada: false,
          papeis: [{ papel: { ativo: true, nome: 'ADMINISTRADOR' } }],
        }),
      },
    };
    const mw = new BullBoardAuthMiddleware(jwt, prisma as never);
    // Token de painel: sub/email/papeis, SEM claim tipo.
    const token = await jwt.signAsync(
      { sub: '1', email: 'a@b.c', papeis: ['ADMINISTRADOR'] },
      { expiresIn: 3600 },
    );
    const res = resposta();
    const next = jest.fn();
    await mw.use(
      { headers: { authorization: `Bearer ${token}` } } as never,
      res as never,
      next as never,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });
});
