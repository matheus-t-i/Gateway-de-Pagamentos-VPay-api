import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import {
  money,
  ORIGEM_EXECUCAO_SAQUE,
  SITUACAO_EXECUCAO_SAQUE,
  SITUACAO_PROVEDOR,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { decryptCredentials } from '../common/crypto.util';

/** Prisma joga P2002 quando a chave de idempotência já foi gravada. */
function ehConflitoUnico(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}

/**
 * Tesouraria: saldo da NOSSA conta em cada adquirente e o saque automático
 * desse saldo para uma chave PIX nossa.
 *
 * Nada aqui toca o ledger do lojista (`saldos_empresas`/`movimentacoes_saldo`):
 * é dinheiro do gateway parado na adquirente, não saldo de cliente. Por isso o
 * disparo grava `ExecucaoGatilhoSaque` e NÃO uma `Transacao`, que é sempre
 * dinheiro de uma empresa.
 */
@Injectable()
export class TesourariaService {
  private readonly logger = new Logger(TesourariaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
  ) {}

  private credenciaisDaConta(criptografadas: string): Record<string, unknown> {
    try {
      return decryptCredentials(criptografadas);
    } catch {
      return JSON.parse(criptografadas) as Record<string, unknown>;
    }
  }

  /**
   * Consulta o saldo na adquirente e persiste o snapshot. A adquirente é a
   * fonte de verdade; `saldos_adquirentes` é só o último valor conhecido, para
   * a tela não depender da API estar de pé a cada render.
   */
  async atualizarSaldo(contaProvedorId: bigint) {
    const conta = await this.prisma.contaProvedor.findUnique({
      where: { id: contaProvedorId },
      include: { provedor: true },
    });
    if (!conta) throw new BadRequestException('Conta da adquirente não encontrada');

    try {
      const saldo = await this.providers.get(conta.provedor.codigo).getBalance({
        contaProvedorId: conta.id.toString(),
        credenciais: this.credenciaisDaConta(conta.credenciaisCriptografadas),
      });
      const dados = {
        moeda: saldo.moeda,
        saldoDisponivel: saldo.disponivel.toFixed(2),
        saldoBloqueado: saldo.bloqueado.toFixed(2),
        consultadoEm: new Date(),
        erroUltimaConsulta: null,
      };
      await this.prisma.saldoAdquirente.upsert({
        where: { contaProvedorId: conta.id },
        create: { contaProvedorId: conta.id, ...dados },
        update: dados,
      });
      return { ok: true as const, disponivel: saldo.disponivel, bloqueado: saldo.bloqueado };
    } catch (e) {
      // Adquirente fora do ar não pode derrubar o tick nem apagar o último
      // saldo conhecido — registra o erro e mantém o snapshot anterior.
      const mensagem = e instanceof Error ? e.message : String(e);
      await this.prisma.saldoAdquirente.upsert({
        where: { contaProvedorId: conta.id },
        create: {
          contaProvedorId: conta.id,
          saldoDisponivel: '0',
          saldoBloqueado: '0',
          erroUltimaConsulta: mensagem,
        },
        update: { erroUltimaConsulta: mensagem },
      });
      this.logger.warn(`falha ao consultar saldo conta=${conta.id}: ${mensagem}`);
      return { ok: false as const, erro: mensagem };
    }
  }

  /** Atualiza o saldo de todas as contas de adquirente ativas. */
  async atualizarTodosSaldos() {
    const contas = await this.prisma.contaProvedor.findMany({
      where: {
        situacao: SITUACAO_PROVEDOR.ATIVO,
        provedor: { situacao: SITUACAO_PROVEDOR.ATIVO },
      },
      select: { id: true },
    });
    for (const c of contas) {
      await this.atualizarSaldo(c.id);
    }
    return contas.length;
  }

  /**
   * Quanto sacar deste gatilho, dado o saldo disponível. `null` = não elegível.
   *
   * Ordem das regras: nunca encostar na reserva, respeitar o teto e só então
   * conferir o piso — inverter isso sacaria menos que o mínimo configurado.
   */
  calcularPayout(
    saldoDisponivel: Decimal,
    gatilho: {
      valorGatilho: Decimal | string;
      valorReserva: Decimal | string;
      valorMinimoPayout: Decimal | string;
      valorMaximoPayout: Decimal | string | null;
    },
  ): Decimal | null {
    const gatilhoValor = money(gatilho.valorGatilho.toString());
    if (saldoDisponivel.lt(gatilhoValor)) return null;

    let payout = saldoDisponivel.minus(money(gatilho.valorReserva.toString()));
    const maximo = gatilho.valorMaximoPayout
      ? money(gatilho.valorMaximoPayout.toString())
      : null;
    if (maximo && payout.gt(maximo)) payout = maximo;
    payout = payout.toDecimalPlaces(2);

    if (payout.lte(0)) return null;
    if (payout.lt(money(gatilho.valorMinimoPayout.toString()))) return null;
    return payout;
  }

  /** Já passou a janela mínima desde o último disparo deste gatilho? */
  private janelaLiberada(
    ultimaExecucaoEm: Date | null,
    intervaloMinimoMinutos: number,
    agora: Date,
  ): boolean {
    if (!ultimaExecucaoEm) return true;
    const decorridoMs = agora.getTime() - ultimaExecucaoEm.getTime();
    return decorridoMs >= intervaloMinimoMinutos * 60_000;
  }

  /**
   * Avalia os gatilhos ativos de todas as contas e cria as execuções elegíveis.
   * Só o PRIMEIRO gatilho elegível de cada conta dispara na rodada — dois
   * gatilhos na mesma conta veriam o mesmo saldo e sacariam em duplicidade.
   */
  async avaliarGatilhos(): Promise<string[]> {
    const agora = new Date();
    const contas = await this.prisma.contaProvedor.findMany({
      where: {
        situacao: SITUACAO_PROVEDOR.ATIVO,
        provedor: { situacao: SITUACAO_PROVEDOR.ATIVO },
        gatilhosSaque: { some: { ativo: true } },
      },
      include: {
        saldo: true,
        gatilhosSaque: {
          where: { ativo: true },
          orderBy: [{ ordem: 'asc' }, { id: 'asc' }],
        },
      },
    });

    const criadas: string[] = [];
    for (const conta of contas) {
      const disponivel = money(conta.saldo?.saldoDisponivel?.toString() ?? '0');
      for (const gatilho of conta.gatilhosSaque) {
        if (
          !this.janelaLiberada(
            gatilho.ultimaExecucaoEm,
            gatilho.intervaloMinimoMinutos,
            agora,
          )
        ) {
          continue;
        }
        const payout = this.calcularPayout(disponivel, gatilho);
        if (!payout) continue;

        const execucaoId = await this.criarExecucao({
          gatilhoId: gatilho.id,
          contaProvedorId: conta.id,
          saldoObservado: disponivel,
          valorSolicitado: payout,
          origem: ORIGEM_EXECUCAO_SAQUE.AUTOMATICO,
          ultimaExecucaoEm: gatilho.ultimaExecucaoEm,
          agora,
        });
        if (execucaoId) {
          criadas.push(execucaoId);
          // Um disparo por conta por rodada: o próximo gatilho só faz sentido
          // depois que o saldo for reconsultado.
          break;
        }
      }
    }
    return criadas;
  }

  /**
   * Reserva o disparo. A chave de idempotência inclui o `ultimaExecucaoEm` que
   * o chamador leu: dois ticks concorrentes leem o mesmo valor, montam a mesma
   * chave e o índice único deixa só um passar. O update de `ultimaExecucaoEm`
   * na mesma transação fecha a janela para a rodada seguinte.
   */
  private async criarExecucao(params: {
    gatilhoId: bigint;
    contaProvedorId: bigint;
    saldoObservado: Decimal;
    valorSolicitado: Decimal;
    origem: string;
    ultimaExecucaoEm: Date | null;
    agora: Date;
    solicitadoPorUsuarioId?: bigint;
  }): Promise<string | null> {
    const marca = params.ultimaExecucaoEm?.getTime() ?? 0;
    const chave = `gatilho:${params.gatilhoId}:${params.origem}:${marca}`;
    try {
      const execucao = await this.prisma.$transaction(async (tx) => {
        const criada = await tx.execucaoGatilhoSaque.create({
          data: {
            gatilhoId: params.gatilhoId,
            contaProvedorId: params.contaProvedorId,
            chaveIdempotencia: chave,
            origem: params.origem,
            saldoObservado: params.saldoObservado.toFixed(2),
            valorSolicitado: params.valorSolicitado.toFixed(2),
            situacao: SITUACAO_EXECUCAO_SAQUE.PENDENTE,
            solicitadoPorUsuarioId: params.solicitadoPorUsuarioId,
          },
        });
        await tx.gatilhoSaqueAdquirente.update({
          where: { id: params.gatilhoId },
          data: { ultimaExecucaoEm: params.agora },
        });
        return criada;
      });
      return execucao.id.toString();
    } catch (e) {
      if (ehConflitoUnico(e)) {
        this.logger.log(`disparo já reservado por outro tick (${chave})`);
        return null;
      }
      throw e;
    }
  }

  /** Disparo manual pelo painel — mesmas regras de valor do automático. */
  async dispararManual(gatilhoId: bigint, usuarioId: bigint) {
    const gatilho = await this.prisma.gatilhoSaqueAdquirente.findUnique({
      where: { id: gatilhoId },
      include: { contaProvedor: { include: { provedor: true } } },
    });
    if (!gatilho) throw new BadRequestException('Gatilho não encontrado');
    if (!gatilho.ativo) throw new BadRequestException('Gatilho inativo');
    if (
      gatilho.contaProvedor.situacao !== SITUACAO_PROVEDOR.ATIVO ||
      gatilho.contaProvedor.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO
    ) {
      throw new BadRequestException('Adquirente indisponível');
    }

    const saldo = await this.atualizarSaldo(gatilho.contaProvedorId);
    if (!saldo.ok) {
      throw new BadRequestException(`Não foi possível consultar o saldo: ${saldo.erro}`);
    }
    const payout = this.calcularPayout(saldo.disponivel, gatilho);
    if (!payout) {
      throw new BadRequestException(
        'Saldo disponível não atende às regras do gatilho (valor de disparo, reserva, mínimo/máximo).',
      );
    }

    const agora = new Date();
    const execucaoId = await this.criarExecucao({
      gatilhoId: gatilho.id,
      contaProvedorId: gatilho.contaProvedorId,
      saldoObservado: saldo.disponivel,
      valorSolicitado: payout,
      origem: ORIGEM_EXECUCAO_SAQUE.MANUAL,
      ultimaExecucaoEm: gatilho.ultimaExecucaoEm,
      agora,
      solicitadoPorUsuarioId: usuarioId,
    });
    if (!execucaoId) {
      throw new BadRequestException('Já existe um disparo em andamento para este gatilho.');
    }
    return { execucaoId, valorSolicitado: payout.toFixed(2) };
  }

  /**
   * Envia o saque à adquirente. Idempotente por execução: `idPublico` é a
   * referência na liquidante, então retentativa não paga duas vezes.
   */
  async processarExecucao(execucaoId: bigint) {
    const execucao = await this.prisma.execucaoGatilhoSaque.findUnique({
      where: { id: execucaoId },
      include: {
        gatilho: true,
        contaProvedor: { include: { provedor: true } },
      },
    });
    if (!execucao) throw new Error(`Execução ${execucaoId} não encontrada`);
    if (execucao.situacao !== SITUACAO_EXECUCAO_SAQUE.PENDENTE) {
      return { ok: true, jaProcessada: true, situacao: execucao.situacao };
    }

    const conta = execucao.contaProvedor;
    if (conta.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO) {
      throw new Error('Provedor inativo — abort saque de tesouraria');
    }

    try {
      const provider = this.providers.get(conta.provedor.codigo);
      const resultado = await provider.createCashOut({
        valor: money(execucao.valorSolicitado.toString()),
        idTransacaoPrivado: execucao.idPublico,
        chavePix: execucao.gatilho.chavePix,
        tipoChavePix: execucao.gatilho.tipoChavePix,
        nomeBeneficiario: execucao.gatilho.nomeTitular ?? undefined,
        documentoBeneficiario: execucao.gatilho.documentoTitular ?? undefined,
        credenciais: this.credenciaisDaConta(conta.credenciaisCriptografadas),
      });

      await this.prisma.execucaoGatilhoSaque.update({
        where: { id: execucao.id },
        data: {
          situacao: SITUACAO_EXECUCAO_SAQUE.ENVIADA,
          idTransacaoLiquidante: resultado.idTransacaoLiquidante,
          metadados: { resposta: resultado.raw } as never,
        },
      });

      // O saldo caiu na adquirente — refletir já evita que o próximo tick veja
      // o valor velho e dispare outro saque.
      await this.atualizarSaldo(conta.id);
      await this.reconciliarExecucao(execucao.id);
      return { ok: true, idTransacaoLiquidante: resultado.idTransacaoLiquidante };
    } catch (e) {
      const mensagem = e instanceof Error ? e.message : String(e);
      await this.prisma.execucaoGatilhoSaque.update({
        where: { id: execucao.id },
        data: { situacao: SITUACAO_EXECUCAO_SAQUE.FALHA, mensagemErro: mensagem },
      });
      throw e;
    }
  }

  /** Consulta na adquirente se um saque já enviado foi concluído. */
  async reconciliarExecucao(execucaoId: bigint) {
    const execucao = await this.prisma.execucaoGatilhoSaque.findUnique({
      where: { id: execucaoId },
      include: { contaProvedor: { include: { provedor: true } } },
    });
    if (!execucao || execucao.situacao !== SITUACAO_EXECUCAO_SAQUE.ENVIADA) return;

    const conta = execucao.contaProvedor;
    try {
      const status = await this.providers.get(conta.provedor.codigo).getStatus({
        idTransacaoLiquidante: execucao.idTransacaoLiquidante ?? undefined,
        idTransacaoPrivado: execucao.idPublico,
        credenciais: this.credenciaisDaConta(conta.credenciaisCriptografadas),
      });
      if (status.status === 'COMPLETED' || status.status === 'PAID') {
        await this.prisma.execucaoGatilhoSaque.update({
          where: { id: execucao.id },
          data: {
            situacao: SITUACAO_EXECUCAO_SAQUE.CONCLUIDA,
            concluidoEm: status.paidAt ?? new Date(),
          },
        });
      } else if (status.status === 'FAILED' || status.status === 'CANCELLED') {
        await this.prisma.execucaoGatilhoSaque.update({
          where: { id: execucao.id },
          data: {
            situacao: SITUACAO_EXECUCAO_SAQUE.FALHA,
            mensagemErro: `Adquirente devolveu status ${status.status}`,
          },
        });
      }
    } catch (e) {
      // Reconciliação é best-effort: a execução continua ENVIADA e o próximo
      // tick tenta de novo. Nunca marcar FALHA por indisponibilidade da API.
      this.logger.warn(
        `falha ao reconciliar execução ${execucao.id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /** Reconcilia todas as execuções ainda ENVIADA (chamado pelo tick). */
  async reconciliarPendentes() {
    const pendentes = await this.prisma.execucaoGatilhoSaque.findMany({
      where: { situacao: SITUACAO_EXECUCAO_SAQUE.ENVIADA },
      select: { id: true },
      take: 200,
    });
    for (const p of pendentes) {
      await this.reconciliarExecucao(p.id);
    }
    return pendentes.length;
  }
}
