import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as ipaddr from 'ipaddr.js';
import { PrismaService } from '../prisma/prisma.service';
import { SITUACAO_USUARIO } from '../shared';
import { hashSegredo, verificarSegredo } from './segredo-hash';
import { RateLimitService } from './rate-limit.service';

/**
 * Como fica em `req.apiCredential` depois de autenticado — o contrato que os
 * handlers da API pública consomem (escopos, IP allowlist, dono).
 */
export type CredencialAutenticada = {
  id: string;
  usuarioId: string;
  escopos: string[];
  temIpAllowlist: boolean;
  exigirAssinaturaHmac: boolean;
  segredoHmacCriptografado: string | null;
  segredoHmacAnteriorCriptografado: string | null;
};

/** Contexto da requisição que a validação precisa (auditoria + allowlist). */
export type ContextoRequisicao = { ip?: string; path?: string };

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

/**
 * Autenticação de credencial de API, em dois momentos distintos:
 *
 * - `autenticarPorChaveSegredo`: o par chave/segredo, usado SOMENTE na emissão
 *   do token (`POST /v1/auth/token`). É a verificação criptográfica cara, com
 *   rate limit próprio e a janela de rotação de segredo.
 * - `carregarCredencialAtiva`: usada pelo guard Bearer em TODA requisição de
 *   negócio. Não toca em segredo — relê a credencial no banco para revogação,
 *   expiração, bloqueio de conta e IP allowlist valerem na requisição
 *   seguinte, sem esperar o token expirar (mesma razão pela qual o RBAC
 *   resolve permissão no banco e não dentro do JWT).
 */
@Injectable()
export class CredencialAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async autenticarPorChaveSegredo(
    publicKey: string,
    secret: string,
    ctx: ContextoRequisicao,
  ): Promise<CredencialAutenticada> {
    /**
     * `select` explícito no lugar de `include: { usuario: true }`: aquele
     * carregava senhaHash, CPF/CNPJ, e-mail e segredo TOTP do titular na
     * memória, para ler duas colunas.
     */
    const cred = await this.prisma.credencialApi.findUnique({
      where: { chavePublica: publicKey },
      select: {
        id: true,
        usuarioId: true,
        segredoHash: true,
        segredoHashAnterior: true,
        segredoAnteriorExpiraEm: true,
        escopos: true,
        ativo: true,
        revogadoEm: true,
        expiraEm: true,
        ipsPermitidos: { select: { ipOuCidr: true } },
        usuario: { select: { situacao: true, contaBloqueada: true } },
      },
    });

    /**
     * Freio ANTES de verificar o segredo.
     *
     * A chave pública não é segredo — aparece na tela do painel. Sem este
     * teto, qualquer um de posse de uma podia forçar a verificação
     * criptográfica (e o INSERT de evento) à vontade. Conta tentativas, não
     * sucessos, e vale mesmo para chave inexistente — senão vira oráculo de
     * existência.
     */
    if (!(await this.rateLimit.checkTentativaAuth(publicKey))) {
      throw new UnauthorizedException('Credencial inválida');
    }

    /**
     * Credencial inexistente, inativa, revogada, expirada ou com segredo errado
     * respondem TODAS a mesma coisa.
     *
     * Mensagens distintas antes da verificação do segredo confirmavam a
     * existência da chave e vazavam o estado da conta do lojista para quem não
     * tinha o segredo. Estado de conta só depois de provar que a credencial é
     * sua.
     */
    const credencialInvalida = new UnauthorizedException('Credencial inválida');
    if (!cred || !cred.ativo || cred.revogadoEm) throw credencialInvalida;
    if (cred.expiraEm && cred.expiraEm < new Date()) throw credencialInvalida;

    let { ok, precisaMigrar } = await verificarSegredo(cred.segredoHash, secret);

    /**
     * Janela de rotação: o segredo ANTERIOR continua valendo até expirar, para
     * o lojista trocar a chave na frota dele sem parar de vender.
     *
     * `precisaMigrar` é forçado a `false` aqui — e isso NÃO é detalhe. Se o
     * hash anterior for do formato argon2 legado, `verificarSegredo` devolveria
     * `precisaMigrar: true`, e a migração lazy reescreveria `segredoHash` (o
     * ATUAL) com o hash do segredo ANTIGO: a rotação seria desfeita sozinha e o
     * segredo novo pararia de funcionar.
     */
    if (!ok && cred.segredoHashAnterior) {
      const aindaVale =
        !cred.segredoAnteriorExpiraEm || cred.segredoAnteriorExpiraEm > new Date();
      if (aindaVale) {
        const anterior = await verificarSegredo(cred.segredoHashAnterior, secret);
        if (anterior.ok) {
          ok = true;
          precisaMigrar = false;
        }
      }
    }

    if (!ok) {
      // Fora do caminho da resposta: um Postgres lento aqui transformava um
      // 401 em 500 e ainda somava latência à tentativa inválida.
      void this.prisma.eventoSeguranca
        .create({
          data: {
            usuarioId: cred.usuarioId,
            credencialApiId: cred.id,
            tipoEvento: 'CREDENCIAL_INVALIDA',
            severidade: 'ALTA',
            enderecoIp: ctx.ip,
            caminho: ctx.path,
          },
        })
        .catch(() => {});
      throw credencialInvalida;
    }

    /**
     * Reescreve o hash legado no formato novo — só agora, com o segredo em
     * claro confirmado. Fire-and-forget: falhar aqui apenas faz a próxima
     * emissão de token pagar argon2 de novo, nunca derruba a chamada.
     */
    if (precisaMigrar) {
      void this.prisma.credencialApi
        .update({ where: { id: cred.id }, data: { segredoHash: hashSegredo(secret) } })
        .catch(() => {});
    }

    // Só depois de o segredo conferir é que faz sentido explicar o motivo: quem
    // tem a credencial tem direito a saber que a conta está bloqueada.
    return this.validarEstadoComum(cred, ctx);
  }

  /**
   * Caminho do guard Bearer: o token já provou a posse do segredo (foi emitido
   * com ele); aqui o que importa é o ESTADO ATUAL — revogar a credencial,
   * bloquear a conta ou mudar a allowlist corta o acesso na requisição
   * seguinte, mesmo com token ainda dentro da validade.
   */
  async carregarCredencialAtiva(
    credencialApiId: bigint,
    ctx: ContextoRequisicao,
  ): Promise<CredencialAutenticada> {
    const cred = await this.prisma.credencialApi.findUnique({
      where: { id: credencialApiId },
      select: {
        id: true,
        usuarioId: true,
        escopos: true,
        ativo: true,
        revogadoEm: true,
        expiraEm: true,
        exigirAssinaturaHmac: true,
        segredoHmacCriptografado: true,
        segredoHmacAnteriorCriptografado: true,
        segredoAnteriorExpiraEm: true,
        ipsPermitidos: { select: { ipOuCidr: true } },
        usuario: { select: { situacao: true, contaBloqueada: true } },
      },
    });

    /**
     * Aqui a mensagem PODE ser específica: quem chegou com um token assinado
     * por nós já provou que teve o segredo — dizer "credencial revogada" não
     * vaza nada e explica ao lojista por que a integração parou.
     */
    if (!cred || !cred.ativo || cred.revogadoEm) {
      throw new UnauthorizedException(
        'Credencial revogada ou inativa — o token não vale mais.',
      );
    }
    if (cred.expiraEm && cred.expiraEm < new Date()) {
      throw new UnauthorizedException('Credencial expirada — o token não vale mais.');
    }

    return this.validarEstadoComum(cred, ctx);
  }

  /** Estado da conta + IP allowlist — igual nos dois caminhos. */
  private validarEstadoComum(
    cred: {
      id: bigint;
      usuarioId: bigint;
      escopos: unknown;
      ipsPermitidos: { ipOuCidr: string }[];
      usuario: { situacao: string; contaBloqueada: boolean };
      exigirAssinaturaHmac?: boolean;
      segredoHmacCriptografado?: string | null;
      segredoHmacAnteriorCriptografado?: string | null;
      segredoAnteriorExpiraEm?: Date | null;
    },
    ctx: ContextoRequisicao,
  ): CredencialAutenticada {
    if (cred.usuario.situacao !== SITUACAO_USUARIO.ATIVO || cred.usuario.contaBloqueada) {
      throw new ForbiddenException('Conta titular não ativa');
    }

    const clientIp = (ctx.ip || '').replace('::ffff:', '');
    if (cred.ipsPermitidos.length > 0) {
      const allowed = cred.ipsPermitidos.some((ip) => ipMatches(clientIp, ip.ipOuCidr));
      if (!allowed) {
        void this.prisma.eventoSeguranca
          .create({
            data: {
              usuarioId: cred.usuarioId,
              credencialApiId: cred.id,
              tipoEvento: 'IP_BLOQUEADO',
              severidade: 'ALTA',
              enderecoIp: clientIp,
              caminho: ctx.path,
            },
          })
          .catch(() => {});
        throw new ForbiddenException('IP não permitido');
      }
    }

    const anteriorAtivo =
      !!cred.segredoHmacAnteriorCriptografado &&
      (!cred.segredoAnteriorExpiraEm || cred.segredoAnteriorExpiraEm > new Date());

    return {
      id: cred.id.toString(),
      usuarioId: cred.usuarioId.toString(),
      escopos: (cred.escopos as string[]) ?? [],
      temIpAllowlist: cred.ipsPermitidos.length > 0,
      exigirAssinaturaHmac: cred.exigirAssinaturaHmac ?? false,
      segredoHmacCriptografado: cred.segredoHmacCriptografado ?? null,
      segredoHmacAnteriorCriptografado: anteriorAtivo
        ? (cred.segredoHmacAnteriorCriptografado ?? null)
        : null,
    };
  }
}
