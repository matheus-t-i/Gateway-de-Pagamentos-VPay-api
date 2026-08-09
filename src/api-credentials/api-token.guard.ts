import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ESCOPOS_API } from '../shared';
import { CredencialAuthService } from './credencial-auth.service';
import { TIPO_TOKEN_API, type TokenApiPayload } from './token.controller';

/**
 * Guard das rotas de negócio da API pública (`/v1/pix/*`): exige o Bearer
 * emitido por `POST /v1/auth/token`. O par chave/segredo NÃO é aceito aqui.
 *
 * O token só prova posse do segredo no momento da emissão. Tudo que muda de
 * estado — revogar credencial, bloquear conta, editar allowlist de IP — é
 * relido do banco a cada requisição via `carregarCredencialAtiva`: revogação
 * corta o acesso na chamada seguinte, sem esperar o token expirar.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly credAuth: CredencialAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers.authorization as string | undefined;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Token de acesso ausente. Gere um em POST /v1/auth/token e envie no header Authorization: Bearer <token>.',
      );
    }

    let payload: TokenApiPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenApiPayload>(header.slice(7));
    } catch (e) {
      /**
       * Expiração tem mensagem própria: é o único 401 esperado na operação
       * normal, e a correção é do lojista (reemitir), não do suporte.
       */
      if ((e as Error).name === 'TokenExpiredError') {
        throw new UnauthorizedException(
          'Token de acesso expirado. Gere um novo em POST /v1/auth/token.',
        );
      }
      throw new UnauthorizedException('Token de acesso inválido');
    }

    // JWT de sessão do painel não abre a API pública — mesmo segredo de
    // assinatura, público diferente. Ver TIPO_TOKEN_API.
    if (payload.tipo !== TIPO_TOKEN_API) {
      throw new UnauthorizedException('Token de acesso inválido');
    }

    req.apiCredential = await this.credAuth.carregarCredencialAtiva(
      BigInt(payload.sub),
      { ip: req.ip, path: req.path },
    );
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
