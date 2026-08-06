import { Injectable, Logger } from '@nestjs/common';
import {
  operacaoCallback,
  SITUACAO_ENTREGA_WEBHOOK,
  SITUACAO_USUARIO,
  statusCallback,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { decryptText } from '../common/crypto.util';

/**
 * `2026-08-03 11:40:04` no fuso de Brasília — é o horário que o lojista vê no
 * painel e no extrato do banco. `sv-SE` é usado só porque produz exatamente
 * `YYYY-MM-DD HH:mm:ss`, sem depender de biblioteca de data.
 */
function dataHoraBr(data: Date): string {
  return data.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

/** Um lugar para onde este evento deve ser entregue. */
export type Destino = {
  url: string;
  configuracaoWebhookId: bigint | null;
  nomeHeaderAutenticacao: string | null;
  segredo: string | null;
  origem: 'PAINEL' | 'OPERACAO';
};

/**
 * Normaliza a URL só para COMPARAR destinos. Sem isto,
 * `https://site.com/hook` e `https://site.com/hook/` seriam tratadas como
 * endereços diferentes e o lojista receberia o callback duas vezes.
 * A URL original é preservada para o envio.
 */
export function chaveUrl(url: string): string {
  try {
    const u = new URL(url);
    const caminho = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${caminho}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

/**
 * Entrega de callback ao lojista. Compartilhado entre a entrega automática
 * (`2-pix-webhook-send`) e o reenvio manual (`11-webhook-reenvio`) — as duas
 * PRECISAM resolver destino, header e histórico do mesmo jeito, senão o
 * reenvio testaria um caminho diferente do que roda em produção.
 */
@Injectable()
export class EntregaWebhookService {
  private readonly logger = new Logger(EntregaWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dados da transação usados no corpo do callback. Buscados UMA vez por
   * evento, no momento da entrega — assim o lojista recebe o estado atual
   * mesmo num reenvio manual feito depois.
   */
  async carregarDados(idTransacaoPublico: string, usuarioId: bigint) {
    return this.prisma.transacao.findFirst({
      where: { idTransacaoPublico, usuarioId },
      include: {
        pix: true,
        usuario: { select: { nomeFantasia: true, nomeRazaoSocial: true } },
      },
    });
  }

  /**
   * Corpo público do callback. Formato plano (sem envelope) — o lojista lê
   * `status` + `operacao` direto na raiz.
   *
   * Nunca vaza id interno: a transação é referenciada só por `idTransacao`
   * (uuid público) e `referencia_externa` (o id do lado do lojista).
   *
   * `urlcallback` é o destino DESTA entrega, então o corpo é montado por
   * destino — com webhook do painel e `urlCallback` da operação apontando para
   * lugares diferentes, cada um recebe o corpo com a sua própria URL.
   */
  montarCorpo(
    dados: NonNullable<Awaited<ReturnType<EntregaWebhookService['carregarDados']>>>,
    urlDestino: string,
  ): string {
    const cashIn = dados.direcao === 'ENTRADA';
    const pix = dados.pix;

    // O beneficiário do saque e o pagador da cobrança ocupam o mesmo par de
    // campos (`nome`/`documento`): é sempre "a contraparte" da operação.
    const nome = cashIn ? pix?.nomePagador : pix?.nomeBeneficiario;
    const documento = cashIn ? pix?.documentoPagador : pix?.documentoBeneficiario;

    const liquido = dados.valorLiquidacaoEmpresa.abs().toFixed(2);

    return JSON.stringify({
      usuario: dados.usuario.nomeFantasia ?? dados.usuario.nomeRazaoSocial,
      referencia_externa: dados.referenciaExterna,
      valor_bruto: Number(dados.valorBruto),
      nome: nome ?? null,
      documento: documento ?? null,
      ...(cashIn ? { email: pix?.emailPagador ?? null } : {}),
      data_registro: dataHoraBr(dados.criadoEm),
      status: statusCallback(dados.situacao, dados.direcao),
      idTransacao: dados.idTransacaoPublico,
      endToEnd: pix?.identificadorFimAFim ?? null,
      ...(cashIn
        ? {
            codigo_pagamento: pix?.pixCopiaCola ?? null,
            paymentCodeBase64: pix?.pixCopiaCola
              ? Buffer.from(pix.pixCopiaCola, 'utf8').toString('base64')
              : null,
            // Quanto entrou na carteira do lojista, já sem a tarifa.
            deposito_liquido: liquido,
          }
        : {
            // Quanto saiu da carteira do lojista: valor + tarifa do saque.
            valor_liquidado: liquido,
          }),
      data_med: dados.primeiroMedRecebidoEm
        ? dataHoraBr(dados.primeiroMedRecebidoEm)
        : null,
      urlcallback: urlDestino,
      operacao: operacaoCallback(dados.direcao),
    });
  }

  /**
   * Destinos deste evento: os webhooks do painel que assinam o tipo, mais o
   * `urlCallback` informado na criação da operação.
   *
   * URLs repetidas entram uma vez só — o cadastro do painel tem prioridade
   * porque é ele que carrega o header de autenticação.
   */
  async resolverDestinos(
    usuarioId: bigint,
    idTransacaoPublico: string,
    tipoEvento: string,
  ): Promise<Destino[]> {
    // Conta fora do ar (encerrada, suspensa, bloqueada) não recebe callback —
    // nem pelo cadastro do painel nem pelo `urlCallback` da operação. Desligar
    // só as configurações deixaria o `urlCallback` de eventos já na fila
    // continuar entregando depois do encerramento.
    const titular = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: { situacao: true },
    });
    if (titular?.situacao !== SITUACAO_USUARIO.ATIVO) return [];

    const configs = await this.prisma.configuracaoWebhookUsuario.findMany({
      where: { usuarioId, ativo: true },
      orderBy: { id: 'asc' },
    });

    const destinos: Destino[] = [];
    const vistos = new Set<string>();

    for (const cfg of configs) {
      const tipos = (cfg.tiposEvento as string[]) ?? [];
      if (tipos.length > 0 && !tipos.includes(tipoEvento)) continue;
      const chave = chaveUrl(cfg.urlDestino);
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      destinos.push({
        url: cfg.urlDestino,
        configuracaoWebhookId: cfg.id,
        nomeHeaderAutenticacao: cfg.nomeHeaderAutenticacao,
        segredo: this.segredoDe(cfg.segredoCriptografado),
        origem: 'PAINEL',
      });
    }

    const tx = await this.prisma.transacao.findFirst({
      where: { idTransacaoPublico, usuarioId },
      select: { urlCallback: true },
    });
    if (tx?.urlCallback && !vistos.has(chaveUrl(tx.urlCallback))) {
      // SEM header de autenticação: a credencial pertence ao webhook cadastrado
      // no painel e não vaza para uma URL passada solta na criação do PIX —
      // senão qualquer chamada da API levaria o segredo para onde quisesse.
      destinos.push({
        url: tx.urlCallback,
        configuracaoWebhookId: null,
        nomeHeaderAutenticacao: null,
        segredo: null,
        origem: 'OPERACAO',
      });
    }

    return destinos;
  }

  private segredoDe(criptografado: string | null): string | null {
    if (!criptografado) return null;
    try {
      return decryptText(criptografado);
    } catch {
      // Chave de criptografia trocada: melhor entregar sem o header do que
      // deixar o lojista sem callback nenhum.
      this.logger.warn('não foi possível decifrar o segredo do webhook');
      return null;
    }
  }

  /**
   * Entrega para todos os destinos. Uma falha não pode impedir os outros de
   * receberem: entrega todos e só então propaga o primeiro erro, para o BullMQ
   * retentar.
   */
  async entregarTodos(params: {
    usuarioId: bigint;
    eventoOutboxId: bigint;
    idTransacaoPublico: string;
    tipoEvento: string;
  }): Promise<{ entregas: number }> {
    const destinos = await this.resolverDestinos(
      params.usuarioId,
      params.idTransacaoPublico,
      params.tipoEvento,
    );
    if (!destinos.length) return { entregas: 0 };

    const dados = await this.carregarDados(
      params.idTransacaoPublico,
      params.usuarioId,
    );
    if (!dados) {
      this.logger.warn(
        `transação ${params.idTransacaoPublico} não encontrada — nada a entregar`,
      );
      return { entregas: 0 };
    }

    let primeiroErro: unknown = null;
    for (const destino of destinos) {
      try {
        await this.entregar(
          destino,
          params.eventoOutboxId,
          params.usuarioId,
          // Corpo por destino: `urlcallback` reflete para onde ESTA entrega vai.
          this.montarCorpo(dados, destino.url),
        );
      } catch (e) {
        primeiroErro ??= e;
      }
    }
    if (primeiroErro) throw primeiroErro;

    return { entregas: destinos.length };
  }

  async entregar(
    destino: Destino,
    eventoOutboxId: bigint,
    usuarioId: bigint,
    corpoEnvio: string,
  ) {
    const tentativa =
      (await this.prisma.entregaWebhook.count({
        where: { eventoOutboxId, configuracaoWebhookId: destino.configuracaoWebhookId },
      })) + 1;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (destino.nomeHeaderAutenticacao && destino.segredo) {
      headers[destino.nomeHeaderAutenticacao] = destino.segredo;
    }

    const started = Date.now();
    try {
      const res = await fetch(destino.url, {
        method: 'POST',
        headers,
        body: corpoEnvio,
      });
      const corpo = (await res.text()).slice(0, 2000);
      await this.prisma.entregaWebhook.create({
        data: {
          eventoOutboxId,
          configuracaoWebhookId: destino.configuracaoWebhookId,
          urlDestino: destino.url,
          usuarioId,
          numeroTentativa: tentativa,
          situacao: res.ok
            ? SITUACAO_ENTREGA_WEBHOOK.SUCESSO
            : SITUACAO_ENTREGA_WEBHOOK.FALHA,
          statusHttp: res.status,
          corpoResposta: corpo,
          latenciaMs: Date.now() - started,
          enviadoEm: new Date(),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e);
      await this.prisma.entregaWebhook.create({
        data: {
          eventoOutboxId,
          configuracaoWebhookId: destino.configuracaoWebhookId,
          urlDestino: destino.url,
          usuarioId,
          numeroTentativa: tentativa,
          situacao: SITUACAO_ENTREGA_WEBHOOK.FALHA,
          mensagemErro: erro,
          latenciaMs: Date.now() - started,
          enviadoEm: new Date(),
        },
      });
      throw e;
    }
  }
}
