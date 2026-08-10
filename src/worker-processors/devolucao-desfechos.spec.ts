import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { encryptCredentials } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { DevolucaoPixProcessor } from './devolucao-pix.processor';
import {
  ErroAntesDoEnvioError,
  RecusaAdquirenteError,
} from '../providers/payment-provider.port';
import {
  SITUACAO_DEVOLUCAO,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
} from '../shared';

/**
 * Os desfechos da devolução PIX — mesma doutrina do saque, porque o refund da
 * Valorion NÃO tem chave de idempotência: reenviar um POST que pode ter saído
 * devolveria o dinheiro duas vezes.
 *
 *  - pré-envio → volta a PENDENTE (retentável; a varredura da conciliação pega)
 *  - recusa    → FALHA definitiva
 *  - ambíguo   → AMBIGUA congelada
 *  - teto      → FALHA (sai da varredura, vira decisão humana)
 *
 * O claim PENDENTE→PROCESSANDO é o que garante que job duplicado (varredura +
 * retry do BullMQ) nunca gera dois POSTs.
 */
describe('DevolucaoPixProcessor — desfechos separados', () => {
  let prisma: PrismaService;
  let usuarioId: bigint;
  let contaId: bigint;
  let transacaoId: bigint;

  let comportamento: () => Promise<{
    identificadorDevolucaoProvedor: string;
    raw: unknown;
  }>;
  let chamadas = 0;
  const outboxEnfileirados: string[] = [];

  function processor(): DevolucaoPixProcessor {
    const registry = {
      get: () => ({
        createRefund: async () => {
          chamadas += 1;
          return comportamento();
        },
      }),
    };
    const queues = {
      enqueueOutbox: async (d: { eventoOutboxId: string }) => {
        outboxEnfileirados.push(d.eventoOutboxId);
      },
    };
    return new DevolucaoPixProcessor(prisma, registry as never, queues as never);
  }

  const job = (devolucaoId: bigint) =>
    ({
      data: {
        devolucaoId: devolucaoId.toString(),
        identificadorRastreio: 'spec-devolucao',
      },
    }) as never;

  async function criarDevolucao(valor = '10.00') {
    return prisma.devolucaoPix.create({
      data: {
        transacaoId,
        valor,
        motivo: 'spec',
        situacao: SITUACAO_DEVOLUCAO.PENDENTE,
      },
    });
  }

  const provedorSituacao = (situacao: 'ATIVO' | 'INATIVO') =>
    prisma.provedorPagamento.update({
      where: { codigo: 'teste_dev' },
      data: { situacao },
    });

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService],
    }).compile();
    prisma = modulo.get(PrismaService);
    await prisma.$connect();

    const usuario = await prisma.usuario.upsert({
      where: { email: 'devolucao-desfechos@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '11111111148',
        nomeRazaoSocial: 'Devolucao Test',
        email: 'devolucao-desfechos@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO' },
    });
    usuarioId = usuario.id;

    const provedor = await prisma.provedorPagamento.upsert({
      where: { codigo: 'teste_dev' },
      create: {
        codigo: 'teste_dev',
        nome: 'Adquirente de teste (devolução)',
        permitePixEntrada: true,
        permitePixSaida: true,
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
      update: { situacao: SITUACAO_PROVEDOR.ATIVO },
    });

    const conta = await prisma.contaProvedor.upsert({
      where: { chaveUnicaConta: 'teste_dev:conta-principal' },
      create: {
        provedorPagamentoId: provedor.id,
        nome: 'Conta teste devolução',
        chaveUnicaConta: 'teste_dev:conta-principal',
        credenciaisCriptografadas: encryptCredentials({}),
        pixEntradaHabilitado: true,
        pixSaidaHabilitado: true,
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
      update: {
        credenciaisCriptografadas: encryptCredentials({}),
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
    });
    contaId = conta.id;

    // Venda paga com id na liquidante — pré-requisito do refund.
    const tx = await prisma.transacao.create({
      data: {
        usuarioId,
        contaProvedorId: contaId,
        direcao: 'ENTRADA',
        situacao: SITUACAO_TRANSACAO.CONCLUIDA,
        valorBruto: '100.00',
        valorTarifaPix: '0',
        valorLiquidacaoEmpresa: '100.00',
        valorReserva: '0',
        idTransacaoPrivado: randomUUID(),
        tentativas: {
          create: {
            contaProvedorId: contaId,
            numeroTentativa: 1,
            situacao: SITUACAO_TENTATIVA.SUCESSO,
            idTransacaoLiquidante: `liq-dev-${Date.now()}`,
          },
        },
      },
    });
    transacaoId = tx.id;
  });

  afterAll(async () => {
    await provedorSituacao(SITUACAO_PROVEDOR.ATIVO);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    chamadas = 0;
    outboxEnfileirados.length = 0;
    comportamento = async () => ({
      identificadorDevolucaoProvedor: 'ref-ok',
      raw: { status: 'success' },
    });
    await provedorSituacao(SITUACAO_PROVEDOR.ATIVO);
  });

  it('pré-envio (provedor inativo): volta a PENDENTE e conta a tentativa — retry é seguro', async () => {
    const dev = await criarDevolucao();
    await provedorSituacao(SITUACAO_PROVEDOR.INATIVO);

    await expect(processor().process(job(dev.id))).rejects.toThrow('Provedor inativo');
    expect(chamadas).toBe(0);

    const atual = await prisma.devolucaoPix.findUniqueOrThrow({ where: { id: dev.id } });
    expect(atual.situacao).toBe(SITUACAO_DEVOLUCAO.PENDENTE);
    expect(atual.quantidadeTentativas).toBe(1);
    expect(atual.ultimoErro).toContain('Provedor inativo');
  });

  it('pré-envio no TETO: FALHA e sai da varredura — decisão humana', async () => {
    const dev = await criarDevolucao();
    await prisma.devolucaoPix.update({
      where: { id: dev.id },
      data: { quantidadeTentativas: DevolucaoPixProcessor.MAXIMO_TENTATIVAS - 1 },
    });
    await provedorSituacao(SITUACAO_PROVEDOR.INATIVO);

    await expect(processor().process(job(dev.id))).rejects.toThrow(UnrecoverableError);

    const atual = await prisma.devolucaoPix.findUniqueOrThrow({ where: { id: dev.id } });
    expect(atual.situacao).toBe(SITUACAO_DEVOLUCAO.FALHA);
    expect(atual.ultimoErro).toContain('TETO');
  });

  it('recusa explícita: FALHA definitiva — retry daria o mesmo não', async () => {
    const dev = await criarDevolucao();
    comportamento = async () => {
      throw new RecusaAdquirenteError('Valorion recusou a devolução: not found', {
        statusHttp: 200,
        dadosResposta: {},
      });
    };

    await expect(processor().process(job(dev.id))).rejects.toThrow(UnrecoverableError);
    expect(chamadas).toBe(1);

    const atual = await prisma.devolucaoPix.findUniqueOrThrow({ where: { id: dev.id } });
    expect(atual.situacao).toBe(SITUACAO_DEVOLUCAO.FALHA);
    expect(atual.ultimoErro).toContain('RECUSADA');
  });

  it('ambíguo (timeout pós-POST): congela em AMBIGUA — reenviar poderia devolver duas vezes', async () => {
    const dev = await criarDevolucao();
    comportamento = async () => {
      throw new Error('socket hang up');
    };

    await expect(processor().process(job(dev.id))).rejects.toThrow(UnrecoverableError);
    expect(chamadas).toBe(1);

    const atual = await prisma.devolucaoPix.findUniqueOrThrow({ where: { id: dev.id } });
    expect(atual.situacao).toBe(SITUACAO_DEVOLUCAO.AMBIGUA);
    expect(atual.ultimoErro).toContain('AMBÍGUA');

    // Job duplicado (varredura + retry) NÃO reexecuta: o claim exige PENDENTE.
    const r = (await processor().process(job(dev.id))) as { ignorado?: boolean };
    expect(r.ignorado).toBe(true);
    expect(chamadas).toBe(1);
  });

  it('pré-envio do CLIENT (ErroAntesDoEnvioError): também volta a PENDENTE', async () => {
    const dev = await criarDevolucao();
    comportamento = async () => {
      throw new ErroAntesDoEnvioError('sellerId ausente para devolução');
    };

    await expect(processor().process(job(dev.id))).rejects.toThrow('sellerId');
    expect(chamadas).toBe(1);

    const atual = await prisma.devolucaoPix.findUniqueOrThrow({ where: { id: dev.id } });
    expect(atual.situacao).toBe(SITUACAO_DEVOLUCAO.PENDENTE);
  });

  it('sucesso: CONCLUIDA + outbox — e reprocessar é no-op', async () => {
    const dev = await criarDevolucao('100.00');

    const r = (await processor().process(job(dev.id))) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(chamadas).toBe(1);
    expect(outboxEnfileirados.length).toBe(1);

    const atual = await prisma.devolucaoPix.findUniqueOrThrow({ where: { id: dev.id } });
    expect(atual.situacao).toBe(SITUACAO_DEVOLUCAO.CONCLUIDA);
    expect(atual.ultimoErro).toBeNull();

    // Devolução total: a venda vira MED.
    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.MED);

    const r2 = (await processor().process(job(dev.id))) as { jaConcluida?: boolean };
    expect(r2.jaConcluida).toBe(true);
    expect(chamadas).toBe(1);
  });
});
