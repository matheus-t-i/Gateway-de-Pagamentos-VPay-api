import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  ESCOPOS_API,
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_CHAVE_PIX,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
  SITUACAO_USUARIO,
  money,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { ConfigPixService } from '../ledger/ledger.service';
import { decryptCredentials } from '../common/crypto.util';

/**
 * Erro de regra de negócio na revalidação: o saque NÃO pode ser enviado.
 * Sobe como falha do job para ficar visível no Bull Board e ser analisado —
 * nunca "conserta" sozinho mexendo em saldo.
 */
class SaqueBloqueadoError extends Error {}

/**
 * Envia o saque à liquidante.
 *
 * `concurrency: 1` — um saque por vez. Dois jobs do mesmo lojista processando
 * em paralelo poderiam passar juntos pelas checagens de saldo e pagar duas
 * vezes; serializando, cada um revalida já enxergando o efeito do anterior.
 *
 * O job NUNCA confia no que foi validado na criação. Ele pode ser reprocessado
 * manualmente (retry no Bull Board / Redis) horas depois, quando a chave PIX já
 * foi reprovada, a conta foi bloqueada ou o saldo mudou — então TODAS as regras
 * são conferidas de novo aqui, imediatamente antes de mover dinheiro.
 */
@Processor(QUEUE_NAMES.PIX_CASH_OUT, { concurrency: 1 })
@Injectable()
export class PixCashOutProcessor extends WorkerHost {
  private readonly logger = new Logger(PixCashOutProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
    private readonly configPix: ConfigPixService,
  ) {
    super();
  }

  async process(job: Job<PixJobPayload>) {
    const body = job.data.payload as {
      transacaoId: string;
      idTransacaoPrivado: string;
    };
    this.logger.log(`processando saque tx=${body.transacaoId}`);

    const tx = await this.prisma.transacao.findUniqueOrThrow({
      where: { id: BigInt(body.transacaoId) },
      include: {
        pix: true,
        contaProvedor: { include: { provedor: true } },
        usuario: { select: { situacao: true, contaBloqueada: true } },
        credencialApi: {
          select: { ativo: true, revogadoEm: true, expiraEm: true, escopos: true },
        },
      },
    });

    // ── 1. Já foi enviado? ────────────────────────────────────────────────
    // A checagem mais importante do arquivo. Se existe tentativa de SUCESSO,
    // a ordem já saiu para a liquidante: reenviar paga o beneficiário de novo.
    // Reprocessar um job antigo no Redis é exatamente como isso aconteceria.
    const jaEnviado = await this.prisma.tentativaTransacao.findFirst({
      where: { transacaoId: tx.id, situacao: SITUACAO_TENTATIVA.SUCESSO },
      select: { id: true, idTransacaoLiquidante: true },
    });
    if (jaEnviado) {
      this.logger.warn(
        `saque tx=${tx.id} já enviado à liquidante ` +
          `(${jaEnviado.idTransacaoLiquidante}) — reprocessamento ignorado`,
      );
      return {
        ok: true,
        ignorado: true,
        motivo: 'saque já enviado à liquidante',
        idTransacaoLiquidante: jaEnviado.idTransacaoLiquidante,
      };
    }

    // ── 2. Estado da transação ────────────────────────────────────────────
    const enviaveis: string[] = [
      SITUACAO_TRANSACAO.PENDENTE,
      SITUACAO_TRANSACAO.PROCESSANDO,
    ];
    if (!enviaveis.includes(tx.situacao)) {
      this.logger.warn(
        `saque tx=${tx.id} em ${tx.situacao} — não é estado enviável, ignorado`,
      );
      return { ok: true, ignorado: true, motivo: `situação ${tx.situacao}` };
    }
    if (tx.direcao !== 'SAIDA') {
      throw new SaqueBloqueadoError(`tx=${tx.id} não é um saque (${tx.direcao})`);
    }

    // ── 3. Conta do lojista ───────────────────────────────────────────────
    if (tx.usuario.situacao !== SITUACAO_USUARIO.ATIVO || tx.usuario.contaBloqueada) {
      throw new SaqueBloqueadoError(
        `conta do lojista indisponível (situação ${tx.usuario.situacao}` +
          `${tx.usuario.contaBloqueada ? ', bloqueada' : ''}) — saque não enviado`,
      );
    }

    // ── 4. Provedor/conta ─────────────────────────────────────────────────
    if (
      !tx.contaProvedor ||
      tx.contaProvedor.situacao !== SITUACAO_PROVEDOR.ATIVO ||
      tx.contaProvedor.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO
    ) {
      throw new SaqueBloqueadoError('provedor/conta inativo — saque não enviado');
    }

    // ── 5. O dinheiro saiu mesmo do saldo? ────────────────────────────────
    // O débito acontece na criação do saque (é o que PROCESSANDO significa).
    // Sem as movimentações, enviar seria pagar sem ter cobrado.
    const debitos = await this.prisma.movimentacaoSaldo.aggregate({
      where: { transacaoId: tx.id, tipoMovimento: 'DEBITO' },
      _sum: { valor: true },
    });
    const debitado = money(debitos._sum.valor?.toString() ?? '0');
    const esperado = money(tx.valorBruto.toString()).plus(
      money(tx.valorTarifaPix.toString()),
    );
    if (debitado.lt(esperado)) {
      throw new SaqueBloqueadoError(
        `saldo não debitado integralmente (debitado ${debitado.toFixed(2)} de ` +
          `${esperado.toFixed(2)}) — saque não enviado`,
      );
    }

    // ── 6. Limites e permissão de saque ───────────────────────────────────
    const cfg = await this.configPix.resolverEfetiva(tx.usuarioId);
    const valor = money(tx.valorBruto.toString());
    if (valor.lt(cfg.ticketMinimoPixSaida)) {
      throw new SaqueBloqueadoError('valor abaixo do mínimo vigente');
    }
    if (cfg.ticketMaximoPixSaida && valor.gt(cfg.ticketMaximoPixSaida)) {
      throw new SaqueBloqueadoError('valor acima do máximo vigente');
    }

    // ── 7. Origem: API ou painel ──────────────────────────────────────────
    // A origem permitida é reconferida AGORA: o admin pode ter desligado o
    // saque via API (ou via painel) depois que o job entrou na fila.
    const viaApi = !!tx.credencialApiId;
    const origemLiberada =
      cfg.origemSaquePermitida === 'AMBOS' ||
      (viaApi ? cfg.origemSaquePermitida === 'API' : cfg.origemSaquePermitida === 'PAINEL');
    if (!origemLiberada) {
      throw new SaqueBloqueadoError(
        `saque por ${viaApi ? 'API' : 'painel'} desabilitado na conta — não enviado`,
      );
    }

    if (tx.credencialApiId) {
      // Saque pedido pela API: a credencial precisa continuar valendo.
      const cred = tx.credencialApi;
      const expirada = cred?.expiraEm ? cred.expiraEm.getTime() < Date.now() : false;
      if (!cred || !cred.ativo || cred.revogadoEm || expirada) {
        throw new SaqueBloqueadoError(
          'credencial de API revogada/expirada — saque não enviado',
        );
      }
      const escopos = (cred.escopos as string[] | null) ?? [];
      if (!escopos.includes(ESCOPOS_API.PIX_SAQUE_CRIAR)) {
        throw new SaqueBloqueadoError(
          'credencial sem escopo pix.saque.criar — saque não enviado',
        );
      }
      // Chave cadastrada também vale para a API quando a conta exige — mesma
      // regra da criação, reconferida aqui porque a aprovação pode ter caído.
      if (cfg.exigirChavePixCadastrada) {
        const chave = tx.pix?.chavePix;
        const cadastrada = chave
          ? await this.prisma.chavePixUsuario.findFirst({
              where: { usuarioId: tx.usuarioId, chave },
              select: { situacao: true },
            })
          : null;
        if (cadastrada?.situacao !== SITUACAO_CHAVE_PIX.APROVADA) {
          throw new SaqueBloqueadoError(
            'conta exige chave PIX cadastrada e aprovada — saque não enviado',
          );
        }
      }
    } else {
      // Saque pedido pelo painel: só sai para chave cadastrada E aprovada pelo
      // administrador, conferida agora — a aprovação pode ter sido revogada
      // entre a criação e o (re)processamento.
      const chave = tx.pix?.chavePix;
      if (!chave) {
        throw new SaqueBloqueadoError('saque sem chave PIX — não enviado');
      }
      const cadastrada = await this.prisma.chavePixUsuario.findFirst({
        where: { usuarioId: tx.usuarioId, chave },
        select: { situacao: true },
      });
      if (!cadastrada) {
        throw new SaqueBloqueadoError(
          'chave PIX não cadastrada nesta conta — saque não enviado',
        );
      }
      if (cadastrada.situacao !== SITUACAO_CHAVE_PIX.APROVADA) {
        throw new SaqueBloqueadoError(
          `chave PIX não aprovada (situação ${cadastrada.situacao}) — saque não enviado`,
        );
      }
    }

    // ── Envio ─────────────────────────────────────────────────────────────
    const provider = this.providers.get(tx.contaProvedor.provedor.codigo);
    let credenciais: Record<string, unknown>;
    try {
      credenciais = decryptCredentials(tx.contaProvedor.credenciaisCriptografadas);
    } catch {
      credenciais = JSON.parse(tx.contaProvedor.credenciaisCriptografadas);
    }

    const result = await provider.createCashOut({
      valor,
      idTransacaoPrivado: tx.idTransacaoPrivado,
      chavePix: tx.pix?.chavePix ?? '',
      tipoChavePix: tx.pix?.tipoChavePix ?? 'ALEATORIA',
      nomeBeneficiario: tx.pix?.nomeBeneficiario ?? undefined,
      documentoBeneficiario: tx.pix?.documentoBeneficiario ?? undefined,
      credenciais,
    });

    // `numeroTentativa` é único por transação: conta as anteriores para o
    // retry não colidir com a linha da tentativa que falhou.
    const anteriores = await this.prisma.tentativaTransacao.count({
      where: { transacaoId: tx.id },
    });

    await this.prisma.$transaction([
      this.prisma.tentativaTransacao.create({
        data: {
          transacaoId: tx.id,
          contaProvedorId: tx.contaProvedorId!,
          numeroTentativa: anteriores + 1,
          situacao: SITUACAO_TENTATIVA.SUCESSO,
          idTransacaoLiquidante: result.idTransacaoLiquidante,
          dadosResposta: result.raw as object,
          concluidoEm: new Date(),
        },
      }),
      this.prisma.transacao.update({
        where: { id: tx.id },
        data: { situacao: SITUACAO_TRANSACAO.PROCESSANDO },
      }),
    ]);

    return { ok: true, idTransacaoLiquidante: result.idTransacaoLiquidante };
  }
}
