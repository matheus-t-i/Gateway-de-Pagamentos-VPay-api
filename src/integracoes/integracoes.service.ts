import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  appIntegracao,
  EventoIntegracao,
  money,
  ParametrosRastreio,
  SITUACAO_ENVIO_INTEGRACAO,
  STATUS_REMOTO_POR_EVENTO,
  StatusRemotoPedido,
  TIPO_INTEGRACAO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { decryptText } from '../common/crypto.util';
import { getRastreio } from '../common/request-context';
import { UtmifyClient } from './utmify/utmify.client';
import { XtrackyClient } from './xtracky/xtracky.client';
import { EnvioApp, ErroEnvioIntegracao, PedidoVenda, ResultadoEnvio } from './tipos';

/** Reais → centavos inteiros. Decimal.js porque dinheiro nunca é float. */
function centavos(valor: Prisma.Decimal | string): number {
  return money(valor.toString()).mul(100).toDecimalPlaces(0).toNumber();
}

/**
 * Apps conectados pelo lojista (`/desenvolvedores/integracoes`).
 *
 * Nada aqui pode derrubar o caminho do dinheiro: os ganchos chamam
 * `notificarSemFalhar`, que engole qualquer erro. Uma venda não deixa de ser
 * creditada — nem um callback deixa de sair — porque a Utmify está fora do ar.
 */
@Injectable()
export class IntegracoesService {
  private readonly logger = new Logger(IntegracoesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly utmify: UtmifyClient,
    private readonly xtracky: XtrackyClient,
  ) {}

  // ------------------------------------------------------------- disparo

  /**
   * Registra o envio deste evento para cada app que o lojista conectou e
   * enfileira o trabalho. Nunca lança.
   */
  async notificarSemFalhar(transacaoId: bigint, evento: EventoIntegracao) {
    try {
      await this.notificar(transacaoId, evento);
    } catch (e) {
      this.logger.error(
        `falha ao agendar integrações da tx ${transacaoId} (${evento}): ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  /**
   * Reenfileira envios que ficaram RESERVADOS mas nunca saíram.
   *
   * Uma linha PENDENTE velha significa que o job se perdeu entre a reserva e a
   * fila — worker morto no meio, Redis fora do ar no `enqueue` (que engole erro
   * de propósito, para não derrubar o caminho do dinheiro). Sem esta varredura
   * a venda simplesmente nunca chega ao app, sem erro em lugar nenhum: o pior
   * tipo de falha, a silenciosa.
   *
   * `idadeMinimaMs` evita corrida com o job que acabou de ser enfileirado e
   * ainda não começou.
   */
  async reenfileirarPendentes(idadeMinimaMs = 60_000, limite = 100) {
    const corte = new Date(Date.now() - idadeMinimaMs);
    const presos = await this.prisma.envioIntegracao.findMany({
      where: {
        situacao: SITUACAO_ENVIO_INTEGRACAO.PENDENTE,
        criadoEm: { lte: corte },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limite,
    });
    if (!presos.length) return { reenfileirados: 0 };

    this.logger.warn(
      `${presos.length} envio(s) de integração presos em PENDENTE — reenfileirando`,
    );
    for (const envio of presos) {
      await this.queues.enqueueIntegracaoEnvio({
        envioId: envio.id.toString(),
        identificadorRastreio: getRastreio(),
      });
    }
    return { reenfileirados: presos.length };
  }

  /**
   * Reserva os envios deste evento DENTRO da transação recebida — usado pelo
   * `5-outbox-publisher`, que precisa que a reserva e o claim do outbox sejam
   * atômicos.
   *
   * Sem isso existe uma janela real de perda: o claim é irreversível, então um
   * worker que morra depois de reivindicar o evento e antes de reservar o envio
   * faz a venda nunca chegar ao app — e o evento nunca mais é reprocessado.
   * Confirmado em teste: venda paga, outbox publicado, zero envios.
   *
   * Devolve os ids reservados para o chamador enfileirar DEPOIS do commit
   * (enfileirar dentro da transação correria o risco de o worker pegar o job
   * antes de a linha existir).
   */
  async reservarEnviosDoEvento(
    tx: Prisma.TransactionClient,
    params: { transacaoId: bigint; usuarioId: bigint; evento: EventoIntegracao },
  ): Promise<bigint[]> {
    const venda = await tx.transacao.findUnique({
      where: { id: params.transacaoId },
      select: { id: true, direcao: true, _count: { select: { itens: true } } },
    });
    if (!venda || venda.direcao !== 'ENTRADA' || venda._count.itens === 0) return [];

    const integracoes = await tx.integracaoUsuario.findMany({
      where: { usuarioId: params.usuarioId, ativo: true },
      orderBy: { id: 'asc' },
    });
    if (!integracoes.length) return [];

    const statusRemoto = STATUS_REMOTO_POR_EVENTO[params.evento];
    const ids: bigint[] = [];

    for (const integracao of integracoes) {
      const assinados = (integracao.eventos as string[]) ?? [];
      if (assinados.length && !assinados.includes(params.evento)) continue;
      const id = await this.reservarEnvio(
        integracao.id,
        venda.id,
        statusRemoto,
        tx,
      );
      if (id) ids.push(id);
    }
    return ids;
  }

  /** Enfileira envios já reservados. Nunca lança. */
  async enfileirarEnvios(ids: bigint[]) {
    for (const id of ids) {
      await this.queues.enqueueIntegracaoEnvio({
        envioId: id.toString(),
        identificadorRastreio: getRastreio(),
      });
    }
  }

  private async notificar(transacaoId: bigint, evento: EventoIntegracao) {
    const tx = await this.prisma.transacao.findUnique({
      where: { id: transacaoId },
      select: {
        id: true,
        usuarioId: true,
        direcao: true,
        _count: { select: { itens: true } },
      },
    });
    if (!tx) return;

    // Só VENDA vai para app de rastreio: cash-out não é pedido, e o depósito
    // pelo painel (o lojista pondo saldo na própria conta) não tem itens nem
    // comprador — entraria no relatório de campanha dele como faturamento falso.
    if (tx.direcao !== 'ENTRADA' || tx._count.itens === 0) return;

    const integracoes = await this.prisma.integracaoUsuario.findMany({
      where: { usuarioId: tx.usuarioId, ativo: true },
      orderBy: { id: 'asc' },
    });
    if (!integracoes.length) return;

    const statusRemoto = STATUS_REMOTO_POR_EVENTO[evento];

    for (const integracao of integracoes) {
      const assinados = (integracao.eventos as string[]) ?? [];
      // Lista vazia = todos, mesma convenção do `tiposEvento` do webhook.
      if (assinados.length && !assinados.includes(evento)) continue;

      const envioId = await this.reservarEnvio(integracao.id, tx.id, statusRemoto);
      if (!envioId) continue;

      await this.queues.enqueueIntegracaoEnvio({
        envioId: envioId.toString(),
        identificadorRastreio: getRastreio(),
      });
    }
  }

  /**
   * Garante UMA linha por (integração, venda, status) e devolve o id quando há
   * trabalho a fazer.
   *
   * É esta unique que impede o envio duplicado quando um job é reprocessado à
   * mão. Já enviado com sucesso → devolve `null` (nada a refazer); parado em
   * PENDENTE/FALHA → devolve o id, porque aí a tentativa anterior não chegou ao
   * fim e repetir é o certo.
   */
  private async reservarEnvio(
    integracaoId: bigint,
    transacaoId: bigint,
    statusRemoto: StatusRemotoPedido,
    /** Client da transação em curso, quando a reserva precisa ser atômica. */
    cliente: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<bigint | null> {
    const existente = await cliente.envioIntegracao.findUnique({
      where: {
        integracaoId_transacaoId_statusRemoto: {
          integracaoId,
          transacaoId,
          statusRemoto,
        },
      },
      select: { id: true, situacao: true },
    });
    if (existente) {
      return existente.situacao === SITUACAO_ENVIO_INTEGRACAO.SUCESSO
        ? null
        : existente.id;
    }

    try {
      const criado = await cliente.envioIntegracao.create({
        data: {
          integracaoId,
          transacaoId,
          statusRemoto,
          situacao: SITUACAO_ENVIO_INTEGRACAO.PENDENTE,
        },
        select: { id: true },
      });
      return criado.id;
    } catch (e) {
      // Corrida com outro job: a unique fez o trabalho dela. O envio já está
      // agendado por quem chegou primeiro.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return null;
      }
      throw e;
    }
  }

  // ------------------------------------------------------------- execução

  /**
   * Executa um envio já reservado. Chamado pelo processor da fila
   * `12-integracao-envio` e pelo reenvio manual da tela.
   *
   * Lança em falha RETENTÁVEL (para o BullMQ tentar de novo) e devolve
   * `{ ok: false }` em falha definitiva — que já foi gravada e não melhora com
   * repetição.
   */
  async processarEnvio(envioId: bigint): Promise<{ ok: boolean; motivo?: string }> {
    const envio = await this.prisma.envioIntegracao.findUnique({
      where: { id: envioId },
      include: { integracao: true },
    });
    if (!envio) return { ok: false, motivo: 'envio inexistente' };
    if (envio.situacao === SITUACAO_ENVIO_INTEGRACAO.SUCESSO) {
      return { ok: true, motivo: 'já enviado' };
    }
    if (!envio.integracao.ativo) {
      await this.registrarFalha(envio.id, 'Integração inativa no momento do envio.');
      return { ok: false, motivo: 'integração inativa' };
    }

    const pedido = await this.carregarPedido(envio.transacaoId);
    if (!pedido) {
      await this.registrarFalha(envio.id, 'Venda não encontrada.');
      return { ok: false, motivo: 'venda inexistente' };
    }

    // App sem credencial (Xtracky) tem a coluna nula: decifrar
    // incondicionalmente mataria toda venda dele aqui, antes de qualquer POST,
    // com uma mensagem mandando o lojista cadastrar um token que não existe.
    let token: string | null = null;
    if (envio.integracao.credenciaisCriptografadas) {
      try {
        token = decryptText(envio.integracao.credenciaisCriptografadas);
      } catch {
        // Chave de criptografia trocada: o lojista precisa recadastrar a
        // credencial. Não é retentável.
        await this.registrarFalha(
          envio.id,
          'Não foi possível decifrar a credencial — cadastre o token novamente.',
        );
        return { ok: false, motivo: 'credencial ilegível' };
      }
    }

    try {
      const r = await this.enviarPara(envio.integracao.tipo, {
        token,
        pedido,
        status: envio.statusRemoto as StatusRemotoPedido,
        // Só marca teste em app que sabe o que fazer com isso. Na Xtracky não
        // existe `isTest`: mandar "teste" geraria conversão real no relatório
        // do lojista.
        teste:
          envio.integracao.modoTeste &&
          (appIntegracao(envio.integracao.tipo)?.suportaTeste ?? false),
      });
      await this.prisma.envioIntegracao.update({
        where: { id: envio.id },
        data: {
          situacao: SITUACAO_ENVIO_INTEGRACAO.SUCESSO,
          numeroTentativa: { increment: 1 },
          statusHttp: r.statusHttp,
          corpoResposta: r.corpoResposta,
          // 2xx com descarte não é falha (retentar não muda nada), mas também
          // não é entrega: o aviso fica visível na tela em vez de virar um
          // "Sucesso" que esconde a venda que não foi contabilizada.
          mensagemErro: r.avisoDescartado ?? null,
          latenciaMs: r.latenciaMs,
          enviadoEm: new Date(),
        },
      });
      return { ok: true };
    } catch (e) {
      const erro =
        e instanceof ErroEnvioIntegracao
          ? e
          : new ErroEnvioIntegracao(
              e instanceof Error ? e.message : String(e),
              false,
            );
      await this.registrarFalha(
        envio.id,
        erro.message,
        erro.statusHttp,
        erro.corpoResposta,
        erro.latenciaMs,
      );
      // Retentável volta a lançar: quem decide o backoff é o BullMQ.
      if (!erro.definitivo) throw erro;
      return { ok: false, motivo: erro.message };
    }
  }

  /**
   * Despacho por app. Tipado pelo contrato NEUTRO (`EnvioApp`), não pelo client
   * da Utmify — senão o `switch` pararia de compilar assim que dois apps
   * divergissem, por um motivo que não tem nada a ver com o problema.
   */
  private enviarPara(tipo: string, envio: EnvioApp): Promise<ResultadoEnvio> {
    switch (tipo) {
      case TIPO_INTEGRACAO.UTMIFY:
        return this.utmify.enviar(envio);
      case TIPO_INTEGRACAO.XTRACKY:
        return this.xtracky.enviar(envio);
      default:
        // Tipo no banco sem client no código: definitivo, e o log diz qual é.
        throw new ErroEnvioIntegracao(`App não suportado: ${tipo}`, true);
    }
  }

  private async registrarFalha(
    envioId: bigint,
    mensagem: string,
    statusHttp?: number,
    corpoResposta?: string,
    latenciaMs?: number,
  ) {
    await this.prisma.envioIntegracao.update({
      where: { id: envioId },
      data: {
        situacao: SITUACAO_ENVIO_INTEGRACAO.FALHA,
        numeroTentativa: { increment: 1 },
        statusHttp: statusHttp ?? null,
        corpoResposta: corpoResposta ?? null,
        mensagemErro: mensagem.slice(0, 2000),
        latenciaMs: latenciaMs ?? null,
        enviadoEm: new Date(),
      },
    });
  }

  // ------------------------------------------------------------- leitura

  /**
   * A venda em formato neutro, lida no momento do envio — não no momento em que
   * o evento foi agendado. Assim um reenvio manual leva o estado ATUAL da venda
   * para o app, e não uma foto velha.
   */
  async carregarPedido(transacaoId: bigint): Promise<PedidoVenda | null> {
    const tx = await this.prisma.transacao.findUnique({
      where: { id: transacaoId },
      include: { pix: true, itens: { orderBy: { id: 'asc' } } },
    });
    if (!tx) return null;

    const rastreio = (tx.parametrosRastreio as ParametrosRastreio | null) ?? {};

    return {
      idPedido: tx.idTransacaoPublico,
      referenciaExterna: tx.referenciaExterna,
      criadoEm: tx.criadoEm,
      pagoEm: tx.concluidoEm ?? tx.liquidadoEm,
      devolvidoEm: tx.primeiroMedRecebidoEm,
      cliente: {
        nome: tx.pix?.nomePagador ?? null,
        email: tx.pix?.emailPagador ?? null,
        telefone: tx.pix?.telefonePagador ?? null,
        documento: tx.pix?.documentoPagador ?? null,
      },
      itens: tx.itens.map((i) => ({
        id: i.id.toString(),
        titulo: i.titulo,
        quantidade: i.quantidade,
        valorUnitarioCentavos: centavos(i.valorUnitario),
      })),
      valorBrutoCentavos: centavos(tx.valorBruto),
      tarifaCentavos: centavos(tx.valorTarifaPix),
      liquidoLojistaCentavos: centavos(tx.valorLiquidacaoEmpresa.abs()),
      rastreio,
    };
  }
}
