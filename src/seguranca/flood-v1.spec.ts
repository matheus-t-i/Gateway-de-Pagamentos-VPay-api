import { FloodV1Middleware } from './flood-v1.middleware';
import { RegistroAcessoApiMiddleware } from './registro-acesso-api.middleware';

/**
 * O teto que roda ANTES do roteamento: é a única proteção que rota inexistente
 * atravessa (o guard global exige handler casado) e o que impede varredura de
 * encher `registros_acesso_api` de INSERT sem limite.
 */
describe('FloodV1Middleware — teto por IP antes do roteamento', () => {
  function montar(dentroDoTeto: boolean | Promise<boolean>) {
    // `check` responde ao PREFIXO da chave: :v1-pre decide o teto, :v1-flood-log
    // controla o throttle do warn (1 = ainda não logou neste minuto).
    const check = jest.fn((key: string) => {
      if (key.includes(':v1-flood-log')) return Promise.resolve(true);
      return typeof dentroDoTeto === 'boolean'
        ? Promise.resolve(dentroDoTeto)
        : dentroDoTeto;
    });
    const mw = new FloodV1Middleware({ check } as never);
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status };
    const next = jest.fn();
    return { mw, check, res, next, json, status };
  }

  const esperar = () => new Promise((r) => setImmediate(r));

  it('dentro do teto: segue para o roteamento, sem 429', async () => {
    const { mw, res, next } = montar(true);
    mw.use(
      { path: '/api/v1/pix/cobrancas', headers: {}, ip: '203.0.113.9' } as never,
      res as never,
      next,
    );
    await esperar();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('acima do teto: 429 sem chegar ao roteamento nem à trilha', async () => {
    const { mw, res, next, json } = montar(false);
    mw.use(
      { path: '/api/v1/login', headers: {}, ip: '203.0.113.9' } as never,
      res as never,
      next,
    );
    await esperar();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 429 }));
  });

  it('acima do teto: registra 1 warn por minuto por IP (throttle via :v1-flood-log)', async () => {
    const { mw, check } = montar(false);
    mw.use(
      { path: '/api/v1/login', headers: {}, ip: '203.0.113.9' } as never,
      { status: () => ({ json: jest.fn() }) } as never,
      jest.fn(),
    );
    await esperar();
    // A 2ª chamada de check é o gate do log — 1 tentativa a cada 60s.
    expect(check).toHaveBeenCalledWith('rl:ip:203.0.113.9:v1-flood-log', 1, 60);
  });

  it('rota fora de /v1 passa direto, sem gastar Redis', async () => {
    const { mw, check, next } = montar(true);
    mw.use(
      { path: '/api/painel/dashboard', headers: {}, ip: '203.0.113.9' } as never,
      {} as never,
      next,
    );
    await esperar();
    expect(next).toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('conta pelo IP real (cf-connecting-ip), não pelo edge da Cloudflare, com teto 1200', async () => {
    const { mw, check, next } = montar(true);
    mw.use(
      {
        path: '/api/v1/auth/token',
        headers: { 'cf-connecting-ip': '18.118.154.5' },
        ip: '104.23.1.1',
      } as never,
      {} as never,
      next,
    );
    await esperar();
    expect(check).toHaveBeenCalledWith('rl:ip:18.118.154.5:v1-pre', 1200, 60);
  });

  it('Redis com surpresa não derruba a chamada, nem emite 429 (falha aberta)', async () => {
    const { mw, res, next } = montar(Promise.reject(new Error('boom')));
    mw.use(
      { path: '/api/v1/saldo', headers: {}, ip: '203.0.113.9' } as never,
      res as never,
      next,
    );
    await esperar();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

/**
 * A garantia do incidente de 17/08: flood ANTES da trilha. Testar a classe
 * isolada não prova que, barrado o flood, a trilha NÃO grava — isso depende da
 * ordem de `app.use` no main.ts. Aqui a ordem é reproduzida (flood → trilha) e
 * o que se afirma é o comportamento observável: acima do teto, zero INSERT.
 */
describe('flood + trilha compostos (ordem do main.ts)', () => {
  function cadeia(dentroDoTeto: boolean) {
    const check = jest.fn((key: string) =>
      Promise.resolve(key.includes(':v1-flood-log') ? true : dentroDoTeto),
    );
    const flood = new FloodV1Middleware({ check } as never);

    const create = jest.fn(async () => ({}));
    const trilha = new RegistroAcessoApiMiddleware({
      registroAcessoApi: { create },
    } as never);

    const ouvintes: Array<() => void> = [];
    const res = {
      statusCode: 429,
      status: jest.fn(() => ({ json: jest.fn() })),
      on: (evento: string, cb: () => void) => {
        if (evento === 'finish') ouvintes.push(cb);
      },
    };
    const req = {
      method: 'POST',
      path: '/api/v1/rota-que-nao-existe',
      originalUrl: '/api/v1/rota-que-nao-existe',
      url: '/api/v1/rota-que-nao-existe',
      headers: {},
      ip: '3.128.190.247',
    };
    const dispararFinish = () => ouvintes.forEach((cb) => cb());
    return { flood, trilha, req, res, create, dispararFinish };
  }

  const esperar = () => new Promise((r) => setImmediate(r));

  it('barrado pelo flood: a trilha nunca é alcançada, zero INSERT', async () => {
    const { flood, trilha, req, res, create, dispararFinish } = cadeia(false);
    // main.ts encadeia: floodV1.use(...next = () => trilhaApi.use(...))
    flood.use(req as never, res as never, () =>
      trilha.use(req as never, res as never, jest.fn()),
    );
    await esperar();
    dispararFinish(); // se a trilha tivesse rodado, teria registrado o finish
    await esperar();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(create).not.toHaveBeenCalled();
  });

  it('dentro do teto: a trilha roda e grava a chamada', async () => {
    const { flood, trilha, req, res, create, dispararFinish } = cadeia(true);
    res.statusCode = 404;
    flood.use(req as never, res as never, () =>
      trilha.use(req as never, res as never, jest.fn()),
    );
    await esperar();
    dispararFinish();
    await esperar();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
