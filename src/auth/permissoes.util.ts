import { PrismaService } from '../prisma/prisma.service';
import { PAPEIS, TODAS_PERMISSOES } from '../shared';

/**
 * União das permissões dos perfis ATIVOS do usuário.
 *
 * O JWT não carrega permissão de propósito: revogar um perfil precisa valer na
 * requisição seguinte, não só quando o token expirar. Por isso isto é resolvido
 * no banco a cada request autenticada (`JwtAuthGuard`) e também no login, para
 * o painel já montar o menu certo sem esperar o `/auth/me`.
 *
 * ADMINISTRADOR recebe o catálogo inteiro por definição — trava anti-lockout:
 * se alguém desmarcasse `admin.perfis.editar` do perfil de administrador,
 * ninguém mais conseguiria consertar o sistema pelo painel.
 */
export async function permissoesEfetivas(
  prisma: PrismaService,
  usuarioId: bigint,
  papeis: string[],
): Promise<string[]> {
  if (papeis.includes(PAPEIS.ADMINISTRADOR)) return [...TODAS_PERMISSOES];

  const linhas = await prisma.$queryRaw<Array<{ codigo: string }>>`
    SELECT DISTINCT pm.codigo
    FROM usuarios_papeis up
    JOIN papeis p ON p.id = up.papel_id AND p.ativo = TRUE
    JOIN papeis_permissoes pp ON pp.papel_id = p.id
    JOIN permissoes pm ON pm.id = pp.permissao_id
    WHERE up.usuario_id = ${usuarioId}
  `;
  return linhas.map((l) => l.codigo);
}
