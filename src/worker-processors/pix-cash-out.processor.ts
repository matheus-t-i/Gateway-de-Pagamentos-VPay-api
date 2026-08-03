import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { decryptCredentials } from '../common/crypto.util';
import { money } from '../shared';

@Processor(QUEUE_NAMES.PIX_CASH_OUT)
@Injectable()
export class PixCashOutProcessor extends WorkerHost {
  private readonly logger = new Logger(PixCashOutProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
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
      },
    });

    if (
      !tx.contaProvedor ||
      tx.contaProvedor.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO
    ) {
      throw new Error('Provedor inativo — abort saque');
    }

    const provider = this.providers.get(tx.contaProvedor.provedor.codigo);
    let credenciais: Record<string, unknown>;
    try {
      credenciais = decryptCredentials(tx.contaProvedor.credenciaisCriptografadas);
    } catch {
      credenciais = JSON.parse(tx.contaProvedor.credenciaisCriptografadas);
    }

    const result = await provider.createCashOut({
      valor: money(tx.valorBruto.toString()),
      idTransacaoPrivado: tx.idTransacaoPrivado,
      chavePix: tx.pix?.chavePix ?? '',
      tipoChavePix: tx.pix?.tipoChavePix ?? 'ALEATORIA',
      nomeBeneficiario: tx.pix?.nomeBeneficiario ?? undefined,
      documentoBeneficiario: tx.pix?.documentoBeneficiario ?? undefined,
      credenciais,
    });

    await this.prisma.$transaction([
      this.prisma.tentativaTransacao.create({
        data: {
          transacaoId: tx.id,
          contaProvedorId: tx.contaProvedorId!,
          numeroTentativa: 1,
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
