import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import * as ipaddr from 'ipaddr.js';
import { PrismaService } from '../prisma/prisma.service';
import { ESCOPOS_API, SITUACAO_USUARIO } from '../shared';
import { createHash } from 'node:crypto';

function ipMatches(clientIp: string, allowed: string): boolean {
  try {
    if (allowed.includes('/')) {
      const [range, bits] = ipaddr.parseCIDR(allowed);
      const parsed = ipaddr.process(clientIp);
      if (range.kind() !== parsed.kind()) return false;
      return parsed.match([range, bits]);
    }
    return ipaddr.process(clientIp).toString() === ipaddr.process(allowed).toString();
  } catch {
    return clientIp === allowed;
  }
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const publicKey =
      (req.headers['x-api-key'] as string | undefined) ||
      (req.headers['x-public-key'] as string | undefined);
    const secret =
      (req.headers['x-api-secret'] as string | undefined) ||
      (req.headers['x-secret-key'] as string | undefined);

    if (!publicKey || !secret) {
      throw new UnauthorizedException('Credenciais API ausentes');
    }

    const cred = await this.prisma.credencialApi.findUnique({
      where: { chavePublica: publicKey },
      include: { ipsPermitidos: true, usuario: true },
    });

    if (!cred || !cred.ativo || cred.revogadoEm) {
      throw new UnauthorizedException('Credencial inválida');
    }
    if (cred.expiraEm && cred.expiraEm < new Date()) {
      throw new UnauthorizedException('Credencial expirada');
    }
    if (cred.usuario.situacao !== SITUACAO_USUARIO.ATIVO || cred.usuario.contaBloqueada) {
      throw new ForbiddenException('Conta titular não ativa');
    }

    const ok = await argon2.verify(cred.segredoHash, secret);
    if (!ok) {
      await this.prisma.eventoSeguranca.create({
        data: {
          usuarioId: cred.usuarioId,
          credencialApiId: cred.id,
          tipoEvento: 'CREDENCIAL_INVALIDA',
          severidade: 'ALTA',
          enderecoIp: req.ip,
          caminho: req.path,
        },
      });
      throw new UnauthorizedException('Credencial inválida');
    }

    const clientIp = (req.ip || '').replace('::ffff:', '');
    if (cred.ipsPermitidos.length > 0) {
      const allowed = cred.ipsPermitidos.some((ip) =>
        ipMatches(clientIp, ip.ipOuCidr),
      );
      if (!allowed) {
        await this.prisma.eventoSeguranca.create({
          data: {
            usuarioId: cred.usuarioId,
            credencialApiId: cred.id,
            tipoEvento: 'IP_BLOQUEADO',
            severidade: 'ALTA',
            enderecoIp: clientIp,
            caminho: req.path,
          },
        });
        throw new ForbiddenException('IP não permitido');
      }
    }

    // Rate limit simples via Redis-like counter em memória + política
    const rlKey = `rl:cred:${cred.id}`;
    // deferred to interceptor with Redis; store context here
    req.apiCredential = {
      id: cred.id.toString(),
      usuarioId: cred.usuarioId.toString(),
      escopos: (cred.escopos as string[]) ?? [],
      temIpAllowlist: cred.ipsPermitidos.length > 0,
    };
    req._rlKey = rlKey;
    return true;
  }
}

/**
 * Exige um escopo específico na credencial de API.
 * Sem isto o campo `escopos` era gravado mas nunca verificado — qualquer
 * credencial válida podia chamar qualquer rota.
 */
export function assertEscopo(
  cred: { escopos: string[] } | undefined,
  escopo: string,
) {
  if (!cred?.escopos?.includes(escopo)) {
    throw new ForbiddenException(
      `Credencial sem permissão para "${escopo}". Habilite o escopo na chave de API.`,
    );
  }
}

/**
 * Saque via API é operação de risco: além do escopo, exige que a credencial
 * tenha allowlist de IP configurada (não pode ser usada de qualquer lugar).
 */
export function assertSaqueViaApiPermitido(cred?: {
  escopos: string[];
  temIpAllowlist?: boolean;
}) {
  // Constante, não literal: com a string solta, renomear o escopo no catálogo
  // não quebrava o build e a checagem passava a nunca casar.
  assertEscopo(cred, ESCOPOS_API.PIX_SAQUE_CRIAR);
  if (!cred?.temIpAllowlist) {
    throw new ForbiddenException(
      'Saque via API exige credencial com IP liberado. Cadastre os IPs permitidos na chave de API.',
    );
  }
}

@Injectable()
export class IdempotencyInterceptor {
  // used as helper service
  constructor(private readonly prisma: PrismaService) {}

  hashBody(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
  }

  async getExisting(usuarioId: bigint, chave: string) {
    return this.prisma.chaveIdempotencia.findUnique({
      where: {
        usuarioId_chaveIdempotencia: { usuarioId, chaveIdempotencia: chave },
      },
    });
  }

  async save(params: {
    usuarioId: bigint;
    credencialApiId: bigint;
    chave: string;
    hash: string;
    transacaoId?: bigint;
    status: number;
    corpo: unknown;
  }) {
    return this.prisma.chaveIdempotencia.create({
      data: {
        usuarioId: params.usuarioId,
        credencialApiId: params.credencialApiId,
        chaveIdempotencia: params.chave,
        hashRequisicao: params.hash,
        transacaoId: params.transacaoId,
        statusResposta: params.status,
        corpoResposta: params.corpo as object,
        expiraEm: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  }
}
