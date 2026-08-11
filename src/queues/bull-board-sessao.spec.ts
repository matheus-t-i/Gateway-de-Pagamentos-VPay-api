import { JwtService } from '@nestjs/jwt';
import { JWT_AUDIENCE_API, JWT_AUDIENCE_PAINEL, JWT_ISSUER } from '../common/jwt-claims';
import { SITUACAO_USUARIO } from '../shared';
import { BullBoardAuthMiddleware, BULL_BOARD_SESSAO_PATH } from './bull-board.middleware';

/**
 * Sessão do Bull Board: em produção painel e API vivem em domínios distintos,
 * então o cookie é emitido pela PRÓPRIA API via form POST top-level em
 * /admin/queues/sessao. Estes testes garantem o contrato do cookie (HttpOnly,
 * SameSite=Lax, escopado no board) e que a rota de sessão exige exatamente a
 * mesma autorização do board.
 */
describe('Bull Board — sessão via POST /admin/queues/sessao', () => {
  const jwt = new JwtService({ secret: 'segredo-de-teste' });

  const usuarioAdmin = {
    id: 7n,
    situacao: SITUACAO_USUARIO.ATIVO,
    contaBloqueada: false,
    papeis: [{ papel: { ativo: true, nome: 'ADMINISTRADOR' } }],
  };

  function prismaCom(usuario: unknown) {
    return {
      usuario: { findUnique: jest.fn().mockResolvedValue(usuario) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
  }

  function reqSessao(body: unknown) {
    return {
      method: 'POST',
      originalUrl: BULL_BOARD_SESSAO_PATH,
      headers: {},
      secure: true,
      body,
    } as never;
  }

  function resMock() {
    return {
      cookie: jest.fn(),
      redirect: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
  }

  const signPainel = (payload: object, extras?: object) =>
    jwt.signAsync(payload, {
      expiresIn: 3600,
      issuer: JWT_ISSUER(),
      audience: JWT_AUDIENCE_PAINEL(),
      ...extras,
    });

  it('token válido de admin: planta cookie HttpOnly/Lax escopado no board e redireciona 303', async () => {
    const mw = new BullBoardAuthMiddleware(jwt, prismaCom(usuarioAdmin) as never);
    const token = await signPainel({ sub: '7', papeis: ['ADMINISTRADOR'] });
    const res = resMock();
    const next = jest.fn();

    await mw.use(reqSessao({ token }), res as never, next);

    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      token,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/admin/queues',
      }),
    );
    const opts = res.cookie.mock.calls[0][2] as { maxAge: number };
    // Herda a validade do JWT (1h aqui) — nunca cookie eterno.
    expect(opts.maxAge).toBeGreaterThan(0);
    expect(opts.maxAge).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(res.redirect).toHaveBeenCalledWith(303, '/admin/queues');
    // A rota de sessão nunca cai no board.
    expect(next).not.toHaveBeenCalled();
  });

  it('sem token no corpo: 401 e nenhum cookie', async () => {
    const mw = new BullBoardAuthMiddleware(jwt, prismaCom(usuarioAdmin) as never);
    const res = resMock();

    await mw.use(reqSessao({}), res as never, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('token da API pública (claim tipo) não cria sessão', async () => {
    const prisma = prismaCom(usuarioAdmin);
    const mw = new BullBoardAuthMiddleware(jwt, prisma as never);
    const tokenApi = await jwt.signAsync(
      { sub: '42', tipo: 'credencial_api' },
      { expiresIn: 3600, issuer: JWT_ISSUER(), audience: JWT_AUDIENCE_API() },
    );
    const res = resMock();

    await mw.use(reqSessao({ token: tokenApi }), res as never, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.cookie).not.toHaveBeenCalled();
    expect(prisma.usuario.findUnique).not.toHaveBeenCalled();
  });

  it('usuário sem admin.filas.ver: 403 e nenhum cookie', async () => {
    const semPermissao = {
      ...usuarioAdmin,
      papeis: [{ papel: { ativo: true, nome: 'OPERADOR' } }],
    };
    const mw = new BullBoardAuthMiddleware(jwt, prismaCom(semPermissao) as never);
    const token = await signPainel({ sub: '7', papeis: ['OPERADOR'] });
    const res = resMock();

    await mw.use(reqSessao({ token }), res as never, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('GET no board continua exigindo cookie/header (nada mudou no caminho antigo)', async () => {
    const mw = new BullBoardAuthMiddleware(jwt, prismaCom(usuarioAdmin) as never);
    const token = await signPainel({ sub: '7', papeis: ['ADMINISTRADOR'] });
    const res = resMock();
    const next = jest.fn();

    await mw.use(
      {
        method: 'GET',
        originalUrl: '/admin/queues',
        headers: { cookie: `access_token=${token}` },
      } as never,
      res as never,
      next,
    );

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
