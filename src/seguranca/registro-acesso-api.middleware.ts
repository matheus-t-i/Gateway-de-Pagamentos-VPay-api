import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { extrairIpCliente } from '../common/client-ip.util';
import { rotaSemPrefixo } from '../common/api-prefix';

/** Só as rotas sensíveis da API pública entram na trilha. */
export function ehRotaSensivel(caminho: string): boolean {
  return /^\/v1(\/|$)/.test(caminho);
}

type ReqApi = Request & {
  apiCredential?: { id: string; usuarioId: string };
  identificadorRastreio?: string;
  mensagemErroHttp?: string;
  codigoErroHttp?: string;
};

/**
 * Trilha de segurança das rotas `/v1/*` — alimenta `/admin/seguranca`.
 *
 * ⚠️ **É MIDDLEWARE, e não interceptor, por um motivo que custou uma
 * descoberta em teste:** no Nest a ordem é middleware → guard → interceptor.
 * Como interceptor, TUDO que o `ApiTokenGuard` recusa (401 de credencial
 * inválida, 403 de escopo, IP fora da allowlist) nunca chegava a ser gravado
 * — ou seja, faltava exatamente o material que uma tela de segurança existe
 * para mostrar. Medido: de 6 chamadas recusadas, só 1 era registrada.
 *
 * O gancho é `res.on('finish')`: dispara depois da resposta enviada, com o
 * status FINAL, qualquer que tenha sido o caminho (guard, pipe, handler ou
 * filtro de exceção).
 *
 * ⚠️ **Nunca derruba a requisição.** A gravação acontece após a resposta já
 * ter ido embora e com `catch` que só loga: perder uma linha de auditoria é
 * ruim, derrubar uma cobrança por causa do log seria transformar
 * observabilidade em incidente de dinheiro.
 *
 * ⚠️ **Nunca guarda segredo.** Vai só a chave PÚBLICA (`x-api-key`); o
 * `x-api-secret`, o Bearer e o corpo da requisição ficam de fora por
 * construção — esta tabela é lida numa tela ampla, e um segredo ali seria
 * vazamento com carimbo de auditoria.
 */
@Injectable()
export class RegistroAcessoApiMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RegistroAcessoApiMiddleware.name);

  constructor(private readonly prisma: PrismaService) {}

  use(req: ReqApi, res: Response, next: NextFunction) {
    const caminho = rotaSemPrefixo(req);
    if (!ehRotaSensivel(caminho)) return next();

    const comecou = Date.now();
    res.on('finish', () => {
      void this.gravar(req, res, caminho, Date.now() - comecou);
    });
    next();
  }

  private async gravar(
    req: ReqApi,
    res: Response,
    caminho: string,
    latenciaMs: number,
  ) {
    try {
      const cabecalho = (nome: string) => {
        const bruto = req.headers[nome];
        const v = Array.isArray(bruto) ? bruto[0] : bruto;
        return typeof v === 'string' && v.trim() ? v.trim() : null;
      };
      const status = res.statusCode;
      await this.prisma.registroAcessoApi.create({
        data: {
          // Preenchidos pelo guard quando a autenticação passou; nulos no 401,
          // que é justamente quando `chavePublica` salva a investigação.
          usuarioId: req.apiCredential?.usuarioId
            ? BigInt(req.apiCredential.usuarioId)
            : null,
          credencialApiId: req.apiCredential?.id
            ? BigInt(req.apiCredential.id)
            : null,
          chavePublica: cabecalho('x-api-key')?.slice(0, 120) ?? null,
          enderecoIp: extrairIpCliente(req).slice(0, 45) || null,
          agenteUsuario: cabecalho('user-agent')?.slice(0, 500) ?? null,
          metodo: req.method.slice(0, 10),
          caminho: caminho.slice(0, 500),
          statusHttp: status,
          sucesso: status < 400,
          codigoErro: req.codigoErroHttp?.slice(0, 80) ?? null,
          mensagemErro: req.mensagemErroHttp?.slice(0, 500) ?? null,
          latenciaMs,
          identificadorRastreio: req.identificadorRastreio?.slice(0, 100) ?? null,
        },
      });
    } catch (e) {
      // Engolido de propósito: ver a doutrina no topo da classe.
      this.logger.warn(
        `falha ao gravar trilha de acesso ${caminho}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
