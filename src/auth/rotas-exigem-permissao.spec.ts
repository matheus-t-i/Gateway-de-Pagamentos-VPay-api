import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CHAVE_PERMISSOES } from './permissoes.decorator';

/**
 * `otplib` → `@scure/base` é ESM puro e não passa pelo transform do jest
 * (mesmo problema documentado em `ativar-sem-documentacao.spec.ts`). Aqui o
 * mock é no próprio `otplib`: este spec precisa dos CONTROLLERS reais — é a
 * metadata dos decorators que está em teste — e ela não depende da lib.
 */
jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verifySync: jest.fn(),
}));

/**
 * Teste de ARQUITETURA: toda rota atrás do `JwtAuthGuard` tem que declarar
 * `@RequerPermissao` — no método ou na classe — ou constar da allowlist de
 * conta própria abaixo, com justificativa.
 *
 * Por quê: o `assertPermissoes` do guard é fail-open de propósito
 * (`reflector.get(...) ?? []`) — rota nova sem o decorator fica aberta a
 * QUALQUER autenticado, inclusive cliente comum em rota de admin, sem erro em
 * lugar nenhum. Sem RLS no banco, o decorator é a única barreira além do
 * `where { usuarioId }` de cada query. Este teste transforma o esquecimento em
 * quebra de build.
 *
 * Rota que fica sem decorator DE PROPÓSITO entra em `ROTAS_SEM_DECORATOR` com
 * a justificativa — e entrada que deixar de existir também FALHA: allowlist
 * morta só dá falsa sensação de cobertura. Só há duas justificativas válidas:
 * conta própria (o alvo é sempre o titular do JWT, sem id de conta na URL) e
 * checagem de permissão DENTRO do handler (quando a regra é um OU de
 * permissões, que o decorator não expressa — ele exige todas).
 */

/** `Classe.metodo` → por que a rota pode ficar sem `@RequerPermissao`. */
const ROTAS_SEM_DECORATOR: Record<string, string> = {
  // Conta própria — a mesma classe de `/auth/me` (CLAUDE.md, "Perfis de acesso").
  'AuthController.me': 'conta própria: o painel não abre nenhuma tela sem GET /auth/me',
  'AuthController.atualizarPerfil': 'conta própria: edita os dados do titular do JWT',
  'AuthController.atualizarTema': 'conta própria: preferência de tema do titular',
  'TotpController.iniciar': 'conta própria: setup do 2FA — barrar aqui é o deadlock do admin sem TOTP',
  'TotpController.confirmar': 'conta própria: setup do 2FA',
  'TotpController.desabilitar': 'conta própria: 2FA do titular (exige senha + código atual)',
  'ContaController.alterarSenha': 'conta própria: troca a senha do titular, reverificando a atual',
  'ContaController.elegibilidadeEncerramento': 'conta própria: consulta pré-encerramento da própria conta',
  'ContaController.encerrar': 'conta própria: encerra a própria conta',
  'PainelCondicoesController.condicoes': 'conta própria: taxas/limites do titular, sem id de conta na URL',
  // Permissão checada no handler (OU de permissões — decorator exigiria todas).
  'AdminPendenciasController.contagem':
    'checa ADMIN_APROVACOES_VER ou ADMIN_CHAVES_PIX_VER no handler; sem nenhuma → 403',
};

function arquivosController(dir: string): string[] {
  const achados: string[] = [];
  for (const nome of fs.readdirSync(dir)) {
    const caminho = path.join(dir, nome);
    if (fs.statSync(caminho).isDirectory()) {
      achados.push(...arquivosController(caminho));
    } else if (nome.endsWith('.controller.ts')) {
      achados.push(caminho);
    }
  }
  return achados;
}

type Controller = { new (...args: unknown[]): unknown };

function controllersDoProjeto(): Controller[] {
  const raiz = path.resolve(__dirname, '..');
  const classes: Controller[] = [];
  for (const arquivo of arquivosController(raiz)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const modulo = require(arquivo) as Record<string, unknown>;
    for (const exportado of Object.values(modulo)) {
      if (
        typeof exportado === 'function' &&
        Reflect.getMetadata(PATH_METADATA, exportado) !== undefined
      ) {
        classes.push(exportado as Controller);
      }
    }
  }
  return classes;
}

function ehJwtAuthGuard(guard: unknown): boolean {
  return guard === JwtAuthGuard;
}

/** Handlers de rota do controller: métodos do prototype com verbo HTTP. */
function handlersDeRota(cls: Controller): { nome: string; fn: Function }[] {
  const proto = cls.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((nome) => nome !== 'constructor')
    .map((nome) => ({ nome, fn: proto[nome] as Function }))
    .filter(
      ({ fn }) =>
        typeof fn === 'function' &&
        Reflect.getMetadata(METHOD_METADATA, fn) !== undefined,
    );
}

describe('rotas autenticadas exigem @RequerPermissao (arquitetura)', () => {
  const controllers = controllersDoProjeto();

  it('encontrou os controllers do projeto', () => {
    // Sanidade do próprio teste: se o glob quebrar, a suíte não pode "passar"
    // por ter varrido lista vazia.
    expect(controllers.length).toBeGreaterThanOrEqual(20);
  });

  it('toda rota atrás do JwtAuthGuard declara permissão ou está na allowlist', () => {
    const violacoes: string[] = [];

    for (const cls of controllers) {
      const guardsClasse: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, cls) ?? [];
      const classeGuardada = guardsClasse.some(ehJwtAuthGuard);
      const permissaoClasse: string[] | undefined = Reflect.getMetadata(
        CHAVE_PERMISSOES,
        cls,
      );

      for (const { nome, fn } of handlersDeRota(cls)) {
        const guardsMetodo: unknown[] =
          Reflect.getMetadata(GUARDS_METADATA, fn) ?? [];
        if (!classeGuardada && !guardsMetodo.some(ehJwtAuthGuard)) continue;

        // Mesma resolução do guard: método sobrepõe classe (getAllAndOverride).
        const permissao: string[] | undefined =
          Reflect.getMetadata(CHAVE_PERMISSOES, fn) ?? permissaoClasse;
        if (permissao && permissao.length > 0) continue;

        const rota = `${cls.name}.${nome}`;
        if (rota in ROTAS_SEM_DECORATOR) continue;

        violacoes.push(rota);
      }
    }

    expect(violacoes).toEqual([]);
  });

  it('a allowlist não tem entrada morta', () => {
    const rotasExistentes = new Set(
      controllers.flatMap((cls) =>
        handlersDeRota(cls).map(({ nome }) => `${cls.name}.${nome}`),
      ),
    );
    const mortas = Object.keys(ROTAS_SEM_DECORATOR).filter(
      (rota) => !rotasExistentes.has(rota),
    );
    expect(mortas).toEqual([]);
  });
});
