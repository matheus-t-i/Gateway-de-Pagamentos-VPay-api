import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request, Response, NextFunction } from 'express';
import { PAPEIS } from '../shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Protege Bull Board (/admin/queues) com JWT Bearer + papel ADMINISTRADOR.
 * Uso via cookie `access_token` ou header Authorization.
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

      const payload = await this.jwt.verifyAsync<{ sub: string; papeis?: string[] }>(token);
      const usuario = await this.prisma.usuario.findUnique({
        where: { id: BigInt(payload.sub) },
        include: { papeis: { include: { papel: true } } },
      });
      const papeis = usuario?.papeis.map((p) => p.papel.nome) ?? [];
      if (!usuario || usuario.situacao !== 'ATIVO' || !papeis.includes(PAPEIS.ADMINISTRADOR)) {
        res.status(403).send('ADMINISTRADOR required');
        return;
      }
      next();
    } catch {
      res.status(401).send('Unauthorized — Bearer token ADMINISTRADOR required');
    }
  }
}
