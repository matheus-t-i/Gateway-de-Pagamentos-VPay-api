import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ESCOPOS_API } from '../shared';
import {
  JWT_AUDIENCE_API,
  JWT_ISSUER,
} from '../common/jwt-claims';
import { extrairIpCliente } from '../common/client-ip.util';
import { CredencialAuthService } from './credencial-auth.service';
import { RateLimitService } from './rate-limit.service';
import {
  HEADER_VPAY_NONCE,
  HEADER_VPAY_SIGNATURE,
  HEADER_VPAY_TIMESTAMP,
  verificarAssinaturaHmacRequest,
} from './request-hmac';
import { TIPO_TOKEN_API, type TokenApiPayload } from './token.controller';

/**
 * Guard das rotas de negócio da API pública (`/v1/pix/*`): exige o Bearer
 * emitido por `POST /v1/auth/token`. O par chave/segredo NÃO é aceito aqui.
 *
 * O token só prova posse do segredo no momento da emissão. Tudo que muda de
 * estado — revogar credencial, bloquear conta, editar allowlist de IP — é
 * relido do banco a cada requisição via `carregarCredencialAtiva`: revogação
 * corta o acesso na chamada seguinte, sem esperar o token expirar.
 *
 * Quando a credencial exige HMAC (ou `API_HMAC_OBRIGATORIO=true`), valida
 * também `x-vpay-timestamp` + `x-vpay-nonce` + `x-vpay-signature`.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly credAuth: CredencialAuthService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
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
      payload = await this.jwt.verifyAsync<TokenApiPayload>(header.slice(7), {
        issuer: JWT_ISSUER(),
        audience: JWT_AUDIENCE_API(),
      });
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

    // extrairIpCliente, não req.ip: atrás de Cloudflare+Render req.ip é o edge
    // CF — a allowlist da credencial nunca casava com o IP real do lojista.
    const cred = await this.credAuth.carregarCredencialAtiva(
      BigInt(payload.sub),
      { ip: extrairIpCliente(req), path: req.path },
    );
    req.apiCredential = cred;

    const hmacGlobal =
      this.config.get<string>('API_HMAC_OBRIGATORIO') === 'true' ||
      this.config.get<string>('API_HMAC_OBRIGATORIO') === '1';
    if (hmacGlobal || cred.exigirAssinaturaHmac) {
      const nonce = String(req.headers[HEADER_VPAY_NONCE] ?? '');
      // Anti-replay: nonce de uso único por credencial (TTL = janela HMAC).
      if (nonce && !(await this.rateLimit.reservarNonceHmac(cred.id, nonce))) {
        throw new UnauthorizedException('x-vpay-nonce já utilizado');
      }
      const bodyRaw =
        typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)
          ? req.rawBody
          : JSON.stringify(req.body ?? {});
      verificarAssinaturaHmacRequest({
        method: req.method,
        path: req.path,
        timestampHeader: req.headers[HEADER_VPAY_TIMESTAMP] as string | undefined,
        nonceHeader: nonce || undefined,
        signatureHeader: req.headers[HEADER_VPAY_SIGNATURE] as string | undefined,
        bodyRaw,
        segredoHmacCriptografado: cred.segredoHmacCriptografado,
        segredoHmacAnteriorCriptografado: cred.segredoHmacAnteriorCriptografado,
      });
    }

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
