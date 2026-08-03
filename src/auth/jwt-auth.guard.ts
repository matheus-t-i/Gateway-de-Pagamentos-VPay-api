import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { PAPEIS, SITUACAO_USUARIO } from '../shared';

export type JwtPayload = {
  sub: string;
  email: string;
  papeis: string[];
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers.authorization as string | undefined;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token ausente');
    }
    const token = header.slice(7);
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
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
    req.user = {
      id: usuario.id.toString(),
      email: usuario.email,
      temaPreferido: usuario.temaPreferido,
      papeis: usuario.papeis.map((p) => p.papel.nome),
    };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly roles: string[]) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const userRoles: string[] = req.user?.papeis ?? [];
    if (!this.roles.some((r) => userRoles.includes(r))) {
      throw new ForbiddenException('Papel insuficiente');
    }
    return true;
  }
}

export function AdminGuard() {
  return new RolesGuard([PAPEIS.ADMINISTRADOR]);
}
