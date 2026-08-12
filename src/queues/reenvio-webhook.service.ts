import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getRastreio } from '../common/request-context';
import { QueuesService } from './queues.service';
import { podeReenviarCallback } from '../shared/callback-lojista';

/**
 * Reenvio manual do callback de uma transação (botão do painel e do admin).
 *
 * Reenvia a ENTREGA de um evento que já existe — não recria evento nem
 * reprocessa dinheiro. O job vai para a fila dedicada `11-webhook-reenvio`.
 */
@Injectable()
export class ReenvioWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  /**
   * @param usuarioIdRestricao quando informado, só reenvia se a transação for
   * dessa conta — é o que impede o painel do cliente de reenviar callback de
   * transação alheia (o admin passa `undefined` e alcança qualquer conta).
   */
  async solicitar(params: {
    idTransacaoPublico: string;
    usuarioIdRestricao?: bigint;
    atorId: bigint;
    enderecoIp?: string;
  }) {
    const tx = await this.prisma.transacao.findUnique({
      where: { idTransacaoPublico: params.idTransacaoPublico },
      select: {
        id: true,
        usuarioId: true,
        idTransacaoPublico: true,
        urlCallback: true,
        situacao: true,
        direcao: true,
      },
    });
    if (!tx) throw new NotFoundException('Transação não encontrada');
    if (
      params.usuarioIdRestricao !== undefined &&
      tx.usuarioId !== params.usuarioIdRestricao
    ) {
      throw new NotFoundException('Transação não encontrada');
    }

    if (!podeReenviarCallback(tx.situacao, tx.direcao as 'ENTRADA' | 'SAIDA')) {
      throw new BadRequestException(
        'Reenvio só vale em status finais com callback: cobrança paga ou MED, ' +
          'saque concluído ou recusado. Aguardando pagamento / falha na geração ' +
          'não geram webhook.',
      );
    }

    // O evento mais recente da transação é o estado que o lojista precisa
    // receber de novo (ex.: pago e depois devolvido → reenvia a devolução).
    const evento = await this.prisma.eventoOutbox.findFirst({
      where: {
        identificadorAgregado: tx.idTransacaoPublico,
        usuarioId: tx.usuarioId,
      },
      orderBy: { id: 'desc' },
    });
    if (!evento) {
      throw new BadRequestException(
        'Esta transação ainda não gerou nenhum callback para reenviar — ' +
          'só operações que chegaram a um estado notificável (paga, devolvida, ' +
          'saque concluído) têm evento.',
      );
    }

    // Sem destino, o reenvio "daria certo" entregando para lugar nenhum. Melhor
    // dizer isso agora do que o lojista ficar esperando o callback.
    const temWebhookPainel = await this.prisma.configuracaoWebhookUsuario.count({
      where: { usuarioId: tx.usuarioId, ativo: true },
    });
    if (!temWebhookPainel && !tx.urlCallback) {
      throw new BadRequestException(
        'A conta não tem webhook ativo cadastrado nem urlCallback nesta ' +
          'operação — não há para onde reenviar.',
      );
    }

    await this.queues.enqueueWebhookReenvio({
      eventoOutboxId: evento.id.toString(),
      idTransacaoPublico: tx.idTransacaoPublico,
      solicitadoPorUsuarioId: params.atorId.toString(),
      identificadorRastreio: getRastreio(),
    });

    await this.prisma.registroAuditoria.create({
      data: {
        usuarioAtorId: params.atorId,
        usuarioAfetadoId: tx.usuarioId,
        origem: 'PAINEL',
        operacao: 'ACAO_NEGOCIO',
        acao: 'WEBHOOK_REENVIAR',
        nomeTabela: 'eventos_outbox',
        chaveRegistro: evento.id.toString(),
        enderecoIp: params.enderecoIp,
        dadosNovos: {
          idTransacao: tx.idTransacaoPublico,
          tipoEvento: evento.tipoEvento,
        } as never,
      },
    });

    return {
      ok: true,
      idTransacao: tx.idTransacaoPublico,
      tipoEvento: evento.tipoEvento,
    };
  }
}
