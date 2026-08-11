import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import {
  JWT_AUDIENCE_PAINEL,
  JWT_ISSUER,
} from '../common/jwt-claims';
import { PAPEIS, PERMISSOES, SITUACAO_USUARIO } from '../shared';
import { PrismaService } from '../prisma/prisma.service';

/** Rota de criação de sessão do Bull Board (form POST top-level vindo do painel). */
export const BULL_BOARD_SESSAO_PATH = '/admin/queues/sessao';
const BULL_BOARD_PATH = '/admin/queues';

/** Teto da sessão do board — o cookie nunca vive mais que o próprio JWT. */
const SESSAO_MAX_MS = 60 * 60 * 1000;

/**
 * Protege Bull Board (/admin/queues) com JWT Bearer + permissão `admin.filas.ver`.
 *
 * Não passa pelo `JwtAuthGuard` (é middleware Express, montado antes do roteador
 * do Nest), então a permissão efetiva é resolvida aqui — mesma regra do guard:
 * só perfis ATIVOS contam e ADMINISTRADOR tem tudo.
 *
 * Em produção o painel (Vercel) e a API (Render) são domínios distintos: cookie
 * plantado pelo painel via `document.cookie` nunca chega aqui. Por isso a sessão
 * é criada pela PRÓPRIA API: o painel faz um form POST top-level em
 * `/admin/queues/sessao` com o JWT no corpo; validado, a API responde
 * `Set-Cookie` (HttpOnly, SameSite=Lax, escopado em /admin/queues) e redireciona
 * para o board. Top-level POST porque Set-Cookie em XHR cross-site é cookie
 * third-party (Safari bloqueia) — e `SameSite=Lax` mata o CSRF nos botões de
 * retry/clean do board, que `None` reabriria. O POST em si não precisa de
 * proteção CSRF: a credencial é o token no corpo, não um cookie ambiente.
 */
@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const pathname = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (req.method === 'POST' && pathname === BULL_BOARD_SESSAO_PATH) {
      return this.criarSessao(req, res);
    }
    try {
      const header = req.headers.authorization;
      const cookie = (req.headers.cookie || '')
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('access_token='))
        ?.split('=')[1];
      const token = header?.startsWith('Bearer ') ? header.slice(7) : cookie;
      if (!token) throw new UnauthorizedException();
      await this.validarTokenPainel(token);
      next();
    } catch (erro) {
      this.responderErro(res, erro);
    }
  }

  private async criarSessao(req: Request, res: Response) {
    try {
      const token = (req.body as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string' || token.length === 0) {
        throw new UnauthorizedException();
      }
      const payload = await this.validarTokenPainel(token);
      // O cookie herda a validade do JWT (o middleware reverifica `exp` a cada
      // request de toda forma) e fica escopado ao board — o resto da API nunca
      // recebe, nem precisa receber, esse cookie.
      const restanteMs = payload.exp
        ? payload.exp * 1000 - Date.now()
        : SESSAO_MAX_MS;
      res.cookie('access_token', token, {
        httpOnly: true,
        secure: this.ehHttps(req),
        sameSite: 'lax',
        path: BULL_BOARD_PATH,
        maxAge: Math.max(0, Math.min(restanteMs, SESSAO_MAX_MS)),
      });
      // 303: o navegador troca o POST por GET ao seguir o redirect.
      res.redirect(303, BULL_BOARD_PATH);
    } catch (erro) {
      this.responderErro(res, erro);
    }
  }

  /**
   * Valida o JWT de SESSÃO do painel e a permissão de filas; lança se inválido.
   * Audience/issuer já separam do token da API; o claim `tipo` continua como
   * defesa em profundidade (sub da API é id de CREDENCIAL, não de usuário).
   */
  private async validarTokenPainel(
    token: string,
  ): Promise<{ sub: string; exp?: number }> {
    const payload = await this.jwt.verifyAsync<{
      sub: string;
      papeis?: string[];
      tipo?: string;
      exp?: number;
    }>(token, {
      issuer: JWT_ISSUER(),
      audience: JWT_AUDIENCE_PAINEL(),
    });
    if (payload.tipo) throw new UnauthorizedException();
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: BigInt(payload.sub) },
      include: { papeis: { include: { papel: true } } },
    });
    const papeis =
      usuario?.papeis.filter((p) => p.papel.ativo).map((p) => p.papel.nome) ?? [];
    if (
      !usuario ||
      usuario.situacao !== SITUACAO_USUARIO.ATIVO ||
      usuario.contaBloqueada
    ) {
      throw new ForbiddenException();
    }
    const permitido =
      papeis.includes(PAPEIS.ADMINISTRADOR) ||
      (await this.temPermissaoFilas(usuario.id));
    if (!permitido) throw new ForbiddenException();
    return payload;
  }

  private responderErro(res: Response, erro: unknown) {
    if (erro instanceof ForbiddenException) {
      res.status(403).send('Sem permissao para as filas');
      return;
    }
    res.status(401).send('Unauthorized — Bearer token com admin.filas.ver');
  }

  /** Atrás do Render `req.secure` depende de TRUST_PROXY; o header cobre o resto. */
  private ehHttps(req: Request): boolean {
    if (req.secure) return true;
    const proto = req.headers['x-forwarded-proto'];
    return String(proto ?? '').split(',')[0].trim() === 'https';
  }

  private async temPermissaoFilas(usuarioId: bigint): Promise<boolean> {
    const linhas = await this.prisma.$queryRaw<Array<{ codigo: string }>>`
      SELECT pm.codigo
      FROM usuarios_papeis up
      JOIN papeis p ON p.id = up.papel_id AND p.ativo = TRUE
      JOIN papeis_permissoes pp ON pp.papel_id = p.id
      JOIN permissoes pm ON pm.id = pp.permissao_id
      WHERE up.usuario_id = ${usuarioId} AND pm.codigo = ${PERMISSOES.ADMIN_FILAS_VER}
      LIMIT 1
    `;
    return linhas.length > 0;
  }
}
