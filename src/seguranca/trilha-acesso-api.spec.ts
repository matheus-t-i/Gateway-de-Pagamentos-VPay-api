import {
  ehRotaSensivel,
  RegistroAcessoApiMiddleware,
} from './registro-acesso-api.middleware';

describe('ehRotaSensivel — o que entra na trilha', () => {
  it('pega as cinco rotas sensíveis da API pública', () => {
    for (const r of [
      '/v1/auth/token',
      '/v1/pix/cobrancas',
      '/v1/pix/saques',
      '/v1/pix/transacoes/abc-123',
      '/v1/saldo',
    ]) {
      expect(ehRotaSensivel(r)).toBe(true);
    }
  });

  it('NÃO pega painel, admin, webhook nem health', () => {
    for (const r of [
      '/painel/dashboard',
      '/admin/seguranca/acessos',
      '/webhooks/valorion/pix-in',
      '/health/ready',
      '/auth/login',
    ]) {
      expect(ehRotaSensivel(r)).toBe(false);
    }
  });

  it('não confunde prefixo parecido', () => {
    // Guardar o painel inteiro por engano encheria a trilha de ruído e
    // esconderia a rajada de 401 que a tela existe para mostrar.
    expect(ehRotaSensivel('/v10/pix')).toBe(false);
    expect(ehRotaSensivel('/api/v1/saldo')).toBe(false); // já vem sem prefixo
    expect(ehRotaSensivel('/v1')).toBe(true);
  });
});

describe('RegistroAcessoApiMiddleware', () => {
  function montar(opts?: { falharGravacao?: boolean }) {
    const criados: Array<Record<string, unknown>> = [];
    const prisma = {
      registroAcessoApi: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (opts?.falharGravacao) throw new Error('banco fora do ar');
          criados.push(data);
          return data;
        }),
      },
    };
    const mw = new RegistroAcessoApiMiddleware(prisma as never);
    return { mw, criados, prisma };
  }

  /** Simula o ciclo do Express: middleware roda, depois o `finish` dispara. */
  async function rodar(
    mw: RegistroAcessoApiMiddleware,
    req: Record<string, unknown>,
    statusCode = 401,
  ) {
    const ouvintes: Array<() => void> = [];
    const res = {
      statusCode,
      on: (evento: string, cb: () => void) => {
        if (evento === 'finish') ouvintes.push(cb);
      },
    };
    const next = jest.fn();
    mw.use(req as never, res as never, next);
    for (const cb of ouvintes) cb();
    // A gravação é assíncrona (não bloqueia a resposta).
    await new Promise((r) => setImmediate(r));
    return { next, res };
  }

  const reqBase = {
    method: 'POST',
    path: '/api/v1/pix/saques',
    ip: '203.0.113.9',
    headers: {
      'x-api-key': 'vp_chave_publica',
      'x-api-secret': 'SEGREDO_SUPER_SECRETO',
      authorization: 'Bearer token.que.nao.pode.vazar',
      'user-agent': 'curl/8.0',
    },
    identificadorRastreio: 'rastreio-1',
    mensagemErroHttp: 'Credencial inválida',
    codigoErroHttp: 'Unauthorized',
  };

  it('grava a chamada recusada com IP, chave tentada e o erro', async () => {
    const { mw, criados } = montar();
    await rodar(mw, { ...reqBase }, 401);

    expect(criados).toHaveLength(1);
    expect(criados[0]).toMatchObject({
      metodo: 'POST',
      caminho: '/v1/pix/saques',
      statusHttp: 401,
      sucesso: false,
      codigoErro: 'Unauthorized',
      mensagemErro: 'Credencial inválida',
      enderecoIp: '203.0.113.9',
      chavePublica: 'vp_chave_publica',
      agenteUsuario: 'curl/8.0',
      identificadorRastreio: 'rastreio-1',
    });
  });

  /**
   * O ponto mais importante do arquivo: a tela é de leitura ampla, e segredo
   * gravado ali seria vazamento com carimbo de auditoria.
   */
  it('NUNCA grava segredo, Bearer ou corpo da requisição', async () => {
    const { mw, criados } = montar();
    await rodar(mw, { ...reqBase, body: { valor: '10', chavePix: '123' } }, 401);

    const gravado = JSON.stringify(criados[0]);
    expect(gravado).not.toContain('SEGREDO_SUPER_SECRETO');
    expect(gravado).not.toContain('token.que.nao.pode.vazar');
    expect(gravado).not.toContain('chavePix');
    expect(criados[0]).not.toHaveProperty('body');
  });

  it('vincula credencial e cliente quando a autenticação passou', async () => {
    const { mw, criados } = montar();
    await rodar(
      mw,
      {
        ...reqBase,
        mensagemErroHttp: undefined,
        codigoErroHttp: undefined,
        apiCredential: { id: '7', usuarioId: '3' },
      },
      201,
    );
    expect(criados[0]).toMatchObject({
      statusHttp: 201,
      sucesso: true,
      credencialApiId: 7n,
      usuarioId: 3n,
      codigoErro: null,
      mensagemErro: null,
    });
  });

  /**
   * Requisição RECUSADA cuja identidade foi provada (403 de IP fora da
   * allowlist, 401 de token expirado): a trilha grava o dono. Antes, toda
   * recusa desse tipo entrava como "não identificado" na tela — justamente o
   * sinal de credencial usada de onde não devia.
   */
  it('grava o dono quando a identidade foi provada mas a requisição foi RECUSADA', async () => {
    const { mw, criados } = montar();
    await rodar(
      mw,
      {
        ...reqBase,
        path: '/api/v1/auth/token',
        credencialIdentificada: { id: '42', usuarioId: '7' },
        mensagemErroHttp: 'IP não permitido',
        codigoErroHttp: 'Forbidden',
      },
      403,
    );

    expect(criados[0]).toMatchObject({
      usuarioId: BigInt(7),
      credencialApiId: BigInt(42),
      statusHttp: 403,
      sucesso: false,
    });
  });

  it('sem identidade provada, segue sem dono — só a chave apresentada', async () => {
    const { mw, criados } = montar();
    await rodar(mw, { ...reqBase }, 401);

    expect(criados[0]).toMatchObject({
      usuarioId: null,
      credencialApiId: null,
      chavePublica: 'vp_chave_publica',
    });
  });

  it('ignora rota não sensível sem sequer registrar o gancho', async () => {
    const { mw, criados, prisma } = montar();
    const { next } = await rodar(mw, { ...reqBase, path: '/api/painel/dashboard' }, 401);
    expect(next).toHaveBeenCalled();
    expect(prisma.registroAcessoApi.create).not.toHaveBeenCalled();
    expect(criados).toHaveLength(0);
  });

  /**
   * Doutrina: perder uma linha de auditoria é ruim; derrubar um saque por
   * causa do log seria transformar observabilidade em incidente de dinheiro.
   */
  it('falha de gravação NÃO derruba a requisição', async () => {
    const { mw } = montar({ falharGravacao: true });
    const { next } = await rodar(mw, { ...reqBase }, 401);
    expect(next).toHaveBeenCalledTimes(1);
    // Chegar aqui sem promise rejeitada já é o teste: nada estourou.
  });

  it('chama next() sempre, e antes de qualquer gravação', async () => {
    const { mw, prisma } = montar();
    const next = jest.fn();
    const res = { statusCode: 200, on: jest.fn() };
    mw.use({ ...reqBase } as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(prisma.registroAcessoApi.create).not.toHaveBeenCalled();
  });
});
