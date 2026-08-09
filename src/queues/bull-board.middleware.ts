import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { PAPEIS, PERMISSOES, SITUACAO_USUARIO } from '../shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Protege Bull Board (/admin/queues) com JWT Bearer + permissão `admin.filas.ver`.
 * Uso via cookie `access_token` ou header Authorization.
 *
 * Não passa pelo `JwtAuthGuard` (é middleware Express, montado antes do roteador
 * do Nest), então a permissão efetiva é resolvida aqui — mesma regra do guard:
 * só perfis ATIVOS contam e ADMINISTRADOR tem tudo.
 */
@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    try {
      const header = req.headers.authorization;
      const cookie = (req.headers.cookie || '')
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('access_token='))
        ?.split('=')[1];
      const token = header?.startsWith('Bearer ') ? header.slice(7) : cookie;
      if (!token) throw new UnauthorizedException();

      const payload = await this.jwt.verifyAsync<{
        sub: string;
        papeis?: string[];
        tipo?: string;
      }>(token);
      /**
       * Só JWT de SESSÃO do painel abre as filas. O token da API pública é
       * assinado com o MESMO `JWT_SECRET` (não há audience/issuer separando os
       * dois), mas seu `sub` é id de CREDENCIAL, não de usuário. Sem esta
       * recusa, um lojista trocaria a chave por um token cujo `sub` colide com
       * o id de um ADMINISTRADOR (as sequências de usuário e credencial são
       * independentes e ambas começam em 1) e abriria o Bull Board como admin.
       * É a MESMA confusão de tipo que o `JwtAuthGuard` barra pelo claim
       * `tipo`; este middleware é um terceiro verificador do mesmo segredo e
       * precisa replicar a checagem.
       */
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
        res.status(403).send('Sem permissao para as filas');
        return;
      }
      const permitido =
        papeis.includes(PAPEIS.ADMINISTRADOR) ||
        (await this.temPermissaoFilas(usuario.id));
      if (!permitido) {
        res.status(403).send('Sem permissao para as filas');
        return;
      }
      next();
    } catch {
      res.status(401).send('Unauthorized — Bearer token com admin.filas.ver');
    }
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
