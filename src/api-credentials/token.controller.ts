import { Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  JWT_AUDIENCE_API,
  JWT_ISSUER,
} from '../common/jwt-claims';
import { extrairIpCliente } from '../common/client-ip.util';
import { CredencialAuthService } from './credencial-auth.service';

/**
 * Discrimina o token da API pública do JWT de sessão do painel — os dois são
 * assinados com o MESMO `JWT_SECRET`. Sem o claim, um token de API (sub = id
 * da credencial) seria aceito pelo `JwtAuthGuard` como se `sub` fosse id de
 * usuário, e vice-versa.
 */
export const TIPO_TOKEN_API = 'credencial_api';

export type TokenApiPayload = {
  sub: string;
  tipo: typeof TIPO_TOKEN_API;
};

/**
 * Emissão do token de acesso da API pública (fluxo OAuth2 client_credentials
 * na semântica): o par `x-api-key`/`x-api-secret` entra AQUI e somente aqui —
 * as rotas de negócio aceitam só o Bearer resultante.
 *
 * O token expira (`API_TOKEN_TTL_SEGUNDOS`) e obriga o lojista a reemitir; a
 * revogação, porém, NÃO depende da expiração: o guard Bearer relê a credencial
 * no banco a cada requisição.
 */
@Controller('v1/auth')
export class TokenApiController {
  constructor(
    private readonly credAuth: CredencialAuthService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Post('token')
  async emitir(@Req() req: {
    headers: Record<string, string | undefined>;
    ip?: string;
    path?: string;
    apiCredential?: { id: string; usuarioId: string };
  }) {
    const publicKey =
      req.headers['x-api-key'] || (req.headers['x-public-key'] as string | undefined);
    const secret =
      req.headers['x-api-secret'] || (req.headers['x-secret-key'] as string | undefined);
    if (!publicKey || !secret) {
      throw new UnauthorizedException('Credenciais API ausentes');
    }

    // extrairIpCliente, não req.ip: atrás de Cloudflare+Render req.ip é o edge
    // CF — a allowlist da credencial nunca casava com o IP real do lojista.
    const cred = await this.credAuth.autenticarPorChaveSegredo(publicKey, secret, {
      ip: extrairIpCliente(req),
      path: req.path,
    });

    /**
     * A trilha de `/admin/seguranca` identifica o autor por `req.apiCredential`
     * — nas rotas de negócio é o ApiTokenGuard quem o seta, mas aqui a
     * autenticação acontece no controller. Sem esta linha, TODA emissão de
     * token — justamente o evento em que alguém prova posse do segredo —
     * entrava anônima na auditoria ("não identificado" na tela, usuarioId
     * nulo na linha).
     */
    req.apiCredential = { id: cred.id, usuarioId: cred.usuarioId };

    const ttlSegundos = Number(this.config.get('API_TOKEN_TTL_SEGUNDOS') ?? 3600);
    const payload: TokenApiPayload = { sub: cred.id, tipo: TIPO_TOKEN_API };
    const accessToken = await this.jwt.signAsync(payload, {
      expiresIn: ttlSegundos,
      issuer: JWT_ISSUER(),
      audience: JWT_AUDIENCE_API(),
    });

    /**
     * Formato de resposta do OAuth2 (RFC 6749): é o que SDKs e ferramentas de
     * mercado esperam desserializar. `escopos` é informativo — a autorização
     * real é conferida no banco a cada chamada.
     */
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ttlSegundos,
      escopos: cred.escopos,
    };
  }
}
