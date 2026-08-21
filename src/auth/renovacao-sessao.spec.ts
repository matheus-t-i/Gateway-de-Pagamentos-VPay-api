import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JWT_AUDIENCE_PAINEL, JWT_ISSUER } from '../common/jwt-claims';
import {
  estaNaJanelaDeRenovacao,
  instanteRenovacao,
  MARGEM_MINIMA_RENOVACAO_MS,
  renovacaoPermitida,
} from '../shared';
import { AuthController } from './auth.controller';
import { JwtAuthGuard, type UsuarioAutenticado } from './jwt-auth.guard';
import {
  segundosDaDuracao,
  TETO_SESSAO_HORAS_PADRAO,
  tetoSessaoMs,
} from './sessao.util';

/**
 * `otplib` é ESM e derruba o transform do ts-jest quando entra pela cadeia
 * `auth.controller` → `totp.controller`. O TOTP não participa da renovação: o
 * guard já resolveu autenticação e 2FA antes de o handler rodar.
 */
jest.mock('./totp.controller', () => ({ validarTotp: jest.fn(() => true) }));

/**
 * Renovação silenciosa da sessão do painel (`POST /auth/renovar`).
 *
 * O painel troca o token por um novo aos 75% da validade para quem está
 * trabalhando não ser deslogado no meio de uma tarefa. O risco do recurso é
 * transformar "sessão de 1h" em "sessão eterna", então o que estes casos travam
 * é justamente o que impede isso — janela mínima, teto absoluto e perfis lidos
 * do banco — mais o combinado com o front, que é a parte que quebra em
 * silêncio: front e API precisam concordar sobre QUANDO renovar, e a recusa
 * nunca pode ser 401 (o painel trata 401 como sessão morta e vai para o login).
 */
describe('renovação silenciosa da sessão do painel', () => {
  const jwt = new JwtService({ secret: 'segredo-de-teste' });
  const MINUTO = 60_000;
  const HORA = 60 * MINUTO;

  const usuario: UsuarioAutenticado = {
    id: '7',
    email: 'lojista@vpay.com.br',
    temaPreferido: 'PADRAO',
    papeis: ['CLIENTE'],
    permissoes: ['painel.dashboard.ver'],
    totpHabilitado: true,
  };

  /** Só `this.jwt` é usado no renovar — prisma e filas não entram no caminho. */
  const controller = () => new AuthController(null as never, jwt, null as never);

  type Payload = {
    sub: string;
    email: string;
    papeis: string[];
    inicioSessao?: number;
    iat?: number;
    exp?: number;
  };

  /** Request como o `JwtAuthGuard` a entrega ao handler. */
  const requisicao = (payload: Partial<Payload>, user = usuario) => ({
    user,
    jwtPayload: {
      sub: '7',
      email: usuario.email,
      papeis: ['CLIENTE'],
      ...payload,
    },
  });

  /** Token de 1h com 45 min gastos — exatamente o ponto em que o front pede. */
  const tokenGasto = (agora: number, extras: Partial<Payload> = {}) => ({
    iat: Math.floor((agora - 45 * MINUTO) / 1000),
    exp: Math.floor((agora + 15 * MINUTO) / 1000),
    ...extras,
  });

  const decodificar = (token: string) =>
    jwt.decode(token) as {
      sub: string;
      email: string;
      papeis: string[];
      inicioSessao?: number;
      iat: number;
      exp: number;
      aud?: string;
      iss?: string;
      tipo?: string;
    };

  const envOriginal = { ...process.env };
  beforeEach(() => {
    process.env.JWT_EXPIRES_IN = '1h';
    delete process.env.SESSAO_PAINEL_MAX_HORAS;
  });
  afterAll(() => {
    process.env = envOriginal;
  });

  it('renova o token quando 75% da validade já passou', async () => {
    const agora = Date.now();
    const { accessToken, sessaoExpiraEm } = await controller().renovar(
      requisicao(tokenGasto(agora)),
    );

    const novo = decodificar(accessToken);
    expect(novo.sub).toBe('7');
    expect(novo.exp * 1000).toBeGreaterThan(agora + 55 * MINUTO);
    // Teto padrão de 12h a partir do login (aqui, do `iat` do token antigo).
    // `iat` é truncado para segundos, então a folga de 1s é do truncamento.
    const fimDaSessao = agora - 45 * MINUTO + TETO_SESSAO_HORAS_PADRAO * HORA;
    expect(
      Math.abs(new Date(sessaoExpiraEm as string).getTime() - fimDaSessao),
    ).toBeLessThanOrEqual(1000);
  });

  /**
   * O token renovado é um token de PAINEL: mesmo issuer/audience e SEM o claim
   * `tipo`, que é o que separa a sessão do painel do Bearer da API pública.
   * Errar isso aqui deslogaria todo mundo no primeiro uso do token novo.
   */
  it('o token renovado continua sendo um token de painel válido', async () => {
    const { accessToken } = await controller().renovar(
      requisicao(tokenGasto(Date.now())),
    );

    await expect(
      jwt.verifyAsync(accessToken, {
        issuer: JWT_ISSUER(),
        audience: JWT_AUDIENCE_PAINEL(),
      }),
    ).resolves.toMatchObject({ sub: '7' });
    expect(decodificar(accessToken).tipo).toBeUndefined();
  });

  /**
   * A `referência` de quem pode entrar é o BANCO, não o token que chegou. Sem
   * isto, tirar o perfil de administrador de alguém no meio da sessão não valia
   * nada: a renovação copiaria `papeis` do token antigo e devolveria o
   * privilégio por mais uma hora.
   */
  it('os papéis do token novo vêm do banco, não do token antigo', async () => {
    const { accessToken } = await controller().renovar(
      requisicao(tokenGasto(Date.now(), { papeis: ['ADMINISTRADOR'] })),
    );

    expect(decodificar(accessToken).papeis).toEqual(['CLIENTE']);
  });

  it('token recente demais NÃO renova (senão a sessão vira eterna em laço)', async () => {
    const agora = Date.now();
    await expect(
      controller().renovar(
        requisicao({
          iat: Math.floor((agora - 5 * MINUTO) / 1000),
          exp: Math.floor((agora + 55 * MINUTO) / 1000),
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('token sem iat/exp não renova', async () => {
    await expect(controller().renovar(requisicao({}))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  /**
   * O painel trata 401 de rota autenticada como sessão morta e manda para o
   * login na hora. Recusar a renovação com 401 derrubaria a sessão que ainda
   * está válida — exatamente o contrário do combinado ("não renovou? deixa
   * expirar normalmente").
   */
  it('toda recusa é 403 — nunca 401, que o painel lê como sessão morta', async () => {
    const agora = Date.now();
    process.env.SESSAO_PAINEL_MAX_HORAS = '12';

    const recusas = [
      requisicao({}),
      requisicao({
        iat: Math.floor((agora - MINUTO) / 1000),
        exp: Math.floor((agora + 59 * MINUTO) / 1000),
      }),
      requisicao(
        tokenGasto(agora, { inicioSessao: Math.floor((agora - 12 * HORA) / 1000) }),
      ),
    ];

    for (const req of recusas) {
      await expect(controller().renovar(req)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(controller().renovar(req)).rejects.toMatchObject({
        status: 403,
      });
    }
  });

  describe('teto absoluto da sessão', () => {
    it('passado o teto, não renova mais — é login de novo', async () => {
      const agora = Date.now();
      process.env.SESSAO_PAINEL_MAX_HORAS = '12';

      await expect(
        controller().renovar(
          requisicao(
            tokenGasto(agora, {
              inicioSessao: Math.floor((agora - 12 * HORA) / 1000),
            }),
          ),
        ),
      ).rejects.toThrow(/Duração máxima da sessão/i);
    });

    /**
     * O ÚLTIMO token da sessão é encurtado até o teto em vez de passar dele.
     * Sem o encurtamento sobraria um token válido depois do fim da sessão, e o
     * contador da tela mostraria um prazo que não existe.
     */
    it('o último token é encurtado para terminar junto com a sessão', async () => {
      const agora = Date.now();
      process.env.SESSAO_PAINEL_MAX_HORAS = '12';
      const inicioSessao = Math.floor((agora - (12 * HORA - 10 * MINUTO)) / 1000);

      const { accessToken } = await controller().renovar(
        requisicao(tokenGasto(agora, { inicioSessao })),
      );

      const novo = decodificar(accessToken);
      // Encurtado para o que RESTA da sessão (~10 min), não a hora inteira.
      // O arredondamento é sempre para baixo: o token nunca passa do teto.
      expect(novo.exp - novo.iat).toBeLessThanOrEqual(600);
      expect(novo.exp - novo.iat).toBeGreaterThan(595);
      expect(novo.exp).toBeLessThanOrEqual(inicioSessao + 12 * 3600);
    });

    it('SESSAO_PAINEL_MAX_HORAS=0 desliga o teto', async () => {
      const agora = Date.now();
      process.env.SESSAO_PAINEL_MAX_HORAS = '0';

      const { accessToken, sessaoExpiraEm } = await controller().renovar(
        requisicao(
          tokenGasto(agora, {
            inicioSessao: Math.floor((agora - 30 * HORA) / 1000),
          }),
        ),
      );

      expect(sessaoExpiraEm).toBeNull();
      expect(decodificar(accessToken).exp - decodificar(accessToken).iat).toBe(3600);
    });

    /**
     * Deploy com tráfego vivo: quem já estava logado tem token SEM
     * `inicioSessao`. Se a renovação exigisse o claim, o recurso nasceria
     * derrubando a sessão de todo mundo que estava no ar no momento do deploy.
     */
    it('token emitido antes desta versão (sem inicioSessao) renova pelo iat', async () => {
      const agora = Date.now();
      process.env.SESSAO_PAINEL_MAX_HORAS = '12';
      const antigo = tokenGasto(agora);

      const { accessToken } = await controller().renovar(requisicao(antigo));

      expect(decodificar(accessToken).inicioSessao).toBe(antigo.iat);
    });

    it('o início da sessão é preservado a cada renovação', async () => {
      const agora = Date.now();
      const inicioSessao = Math.floor((agora - 3 * HORA) / 1000);

      const { accessToken } = await controller().renovar(
        requisicao(tokenGasto(agora, { inicioSessao })),
      );

      expect(decodificar(accessToken).inicioSessao).toBe(inicioSessao);
    });
  });

  /**
   * A parte que quebra em SILÊNCIO: se o front pedisse numa janela que a API
   * recusa, nada erraria em lugar nenhum — a renovação só falharia sempre e a
   * sessão cairia como se o recurso nunca tivesse existido.
   */
  describe('front e API concordam sobre a janela', () => {
    const janela = { emitidoEm: 0, expiraEm: HORA };

    it('o front pede aos 75% gastos', () => {
      expect(instanteRenovacao(janela)).toBe(45 * MINUTO);
      expect(estaNaJanelaDeRenovacao(janela, 45 * MINUTO - 1)).toBe(false);
      expect(estaNaJanelaDeRenovacao(janela, 45 * MINUTO)).toBe(true);
    });

    it('a API já aceita nesse instante, com folga para relógio adiantado', () => {
      expect(renovacaoPermitida(janela, instanteRenovacao(janela))).toBe(true);
      // A folga é de 25% da validade (15 min num token de 1h).
      expect(renovacaoPermitida(janela, 30 * MINUTO)).toBe(true);
      expect(renovacaoPermitida(janela, 30 * MINUTO - 1)).toBe(false);
    });

    it('perto demais do vencimento o front desiste (token novo nasceria morto)', () => {
      expect(
        estaNaJanelaDeRenovacao(janela, HORA - MARGEM_MINIMA_RENOVACAO_MS),
      ).toBe(false);
      expect(estaNaJanelaDeRenovacao(janela, HORA + 1)).toBe(false);
    });

    /**
     * Token sem `iat` legível: janela de duração zero. Os dois lados têm que
     * DESLIGAR a renovação — dar vida extra a um token que não sabemos ler
     * seria o pior desfecho possível.
     */
    it('janela ilegível não renova de nenhum dos lados', () => {
      const cega = { emitidoEm: HORA, expiraEm: HORA };
      expect(estaNaJanelaDeRenovacao(cega, HORA - 1)).toBe(false);
      expect(renovacaoPermitida(cega, HORA)).toBe(false);
    });
  });

  describe('leitura da configuração', () => {
    it('segundosDaDuracao entende o formato de JWT_EXPIRES_IN', () => {
      expect(segundosDaDuracao('1h')).toBe(3600);
      expect(segundosDaDuracao('45m')).toBe(2700);
      expect(segundosDaDuracao('90s')).toBe(90);
      expect(segundosDaDuracao('2d')).toBe(172800);
      expect(segundosDaDuracao('3600')).toBe(3600);
    });

    it('valor ausente ou incompreensível cai no padrão, não em zero', () => {
      expect(segundosDaDuracao(undefined)).toBe(3600);
      expect(segundosDaDuracao('')).toBe(3600);
      expect(segundosDaDuracao('para sempre')).toBe(3600);
      expect(segundosDaDuracao('0')).toBe(3600);
    });

    it('teto ausente ou inválido cai no padrão — nunca em "sem teto"', () => {
      expect(tetoSessaoMs(undefined)).toBe(TETO_SESSAO_HORAS_PADRAO * HORA);
      expect(tetoSessaoMs('')).toBe(TETO_SESSAO_HORAS_PADRAO * HORA);
      expect(tetoSessaoMs('abacaxi')).toBe(TETO_SESSAO_HORAS_PADRAO * HORA);
      expect(tetoSessaoMs('-1')).toBe(TETO_SESSAO_HORAS_PADRAO * HORA);
      expect(tetoSessaoMs('8')).toBe(8 * HORA);
      expect(tetoSessaoMs('0')).toBe(0);
    });
  });

  /**
   * Fecha o ciclo: o token que a renovação devolve abre o painel de verdade
   * (guard completo, com usuário lido do banco). Um erro de issuer/audience ou
   * um claim a mais passaria nos testes acima e só apareceria em produção,
   * como logout geral no minuto 45.
   */
  it('o token renovado é aceito pelo JwtAuthGuard', async () => {
    const { accessToken } = await controller().renovar(
      requisicao(tokenGasto(Date.now())),
    );

    const prisma = {
      usuario: {
        findUnique: jest.fn().mockResolvedValue({
          id: BigInt(7),
          email: usuario.email,
          situacao: 'ATIVO',
          contaBloqueada: false,
          temaPreferido: 'PADRAO',
          totpHabilitado: true,
          papeis: [{ papel: { nome: 'CLIENTE', ativo: true } }],
        }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ codigo: 'painel.dashboard.ver' }]),
    };
    const guard = new JwtAuthGuard(jwt, prisma as never, new Reflector());

    const req: Record<string, unknown> = {
      headers: { authorization: `Bearer ${accessToken}` },
      path: '/api/painel/dashboard',
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => function handler() {},
      getClass: () => class Classe {},
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ id: '7', papeis: ['CLIENTE'] });
  });
});
