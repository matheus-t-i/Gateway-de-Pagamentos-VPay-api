import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import {
  CodigoPermissao,
  descricaoPermissao,
  PERMISSOES,
  SITUACAO_USUARIO,
} from '../shared';
import {
  JWT_AUDIENCE_PAINEL,
  JWT_ISSUER,
} from '../common/jwt-claims';
import { CHAVE_PERMISSOES } from './permissoes.decorator';
import { permissoesEfetivas } from './permissoes.util';

export type JwtPayload = {
  sub: string;
  email: string;
  papeis: string[];
};

/** Usuário autenticado, como fica em `req.user`. */
export type UsuarioAutenticado = {
  id: string;
  email: string;
  temaPreferido: string;
  papeis: string[];
  /** Permissões efetivas — união dos perfis ATIVOS do usuário. */
  permissoes: string[];
  totpHabilitado: boolean;
};

/** Checagem de permissão fora do guard (regra de negócio dentro do handler). */
export function temPermissao(
  user: { permissoes?: string[] } | undefined,
  codigo: CodigoPermissao,
): boolean {
  return user?.permissoes?.includes(codigo) ?? false;
}

/**
 * Enxerga dados de todos os clientes, e não só os próprios. Usado nas
 * listagens que antes decidiam o escopo por `papeis.includes(ADMINISTRADOR)`.
 */
export function temEscopoGlobal(user: { permissoes?: string[] } | undefined) {
  return temPermissao(user, PERMISSOES.ESCOPO_GLOBAL);
}

/** Rotas liberadas enquanto admin ainda não ativou 2FA. */
const ROTAS_SEM_2FA_ADMIN = [
  '/auth/me',
  '/auth/totp',
  '/auth/logout',
  '/auth/tema',
];

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers.authorization as string | undefined;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token ausente');
    }
    const token = header.slice(7);
    let payload: JwtPayload & { tipo?: string };
    try {
      payload = await this.jwt.verifyAsync(token, {
        issuer: JWT_ISSUER(),
        audience: JWT_AUDIENCE_PAINEL(),
      });
    } catch {
      throw new UnauthorizedException('Token inválido');
    }
    /**
     * Token da API pública (`POST /v1/auth/token`) não abre o painel: é
     * assinado com o MESMO segredo, mas o `sub` dele é id de CREDENCIAL — sem
     * esta recusa, ele autenticaria como o usuário que por acaso tivesse o
     * mesmo id numérico.
     */
    if (payload.tipo) {
      throw new UnauthorizedException('Token inválido');
    }
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: BigInt(payload.sub) },
      include: {
        papeis: { include: { papel: true } },
      },
    });
    if (
      !usuario ||
      usuario.situacao !== SITUACAO_USUARIO.ATIVO ||
      usuario.contaBloqueada
    ) {
      throw new ForbiddenException('Usuário não autorizado');
    }

    // Perfis inativos não concedem nada: inativar um perfil precisa cortar o
    // acesso de quem já está com sessão aberta, sem esperar novo login.
    const papeis = usuario.papeis
      .filter((p) => p.papel.ativo)
      .map((p) => p.papel.nome);
    const permissoes = await permissoesEfetivas(this.prisma, usuario.id, papeis);

    const user: UsuarioAutenticado = {
      id: usuario.id.toString(),
      email: usuario.email,
      temaPreferido: usuario.temaPreferido,
      papeis,
      permissoes,
      totpHabilitado: usuario.totpHabilitado,
    };
    req.user = user;

    // Admin / escopo global sem 2FA: só consegue ativar TOTP e ver a própria conta.
    if (temEscopoGlobal(user) && !usuario.totpHabilitado) {
      const path = String(req.path ?? req.url ?? '');
      const liberado = ROTAS_SEM_2FA_ADMIN.some(
        (p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`),
      );
      if (!liberado) {
        throw new ForbiddenException(
          'Perfis administrativos exigem 2FA. Ative em Configurações → Segurança.',
        );
      }
    }

    this.assertPermissoes(context, user);
    return true;
  }

  private assertPermissoes(context: ExecutionContext, user: UsuarioAutenticado) {
    const exigidas =
      this.reflector.getAllAndOverride<CodigoPermissao[] | undefined>(
        CHAVE_PERMISSOES,
        [context.getHandler(), context.getClass()],
      ) ?? [];
    const faltando = exigidas.filter((c) => !user.permissoes.includes(c));
    if (faltando.length) {
      throw new ForbiddenException(
        `Seu perfil de acesso não permite esta operação (${faltando
          .map(descricaoPermissao)
          .join('; ')}).`,
      );
    }
  }
}
