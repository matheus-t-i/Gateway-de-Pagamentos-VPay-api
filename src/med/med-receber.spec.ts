import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { MedService } from './med.service';
import {
  MODO_TRATAMENTO_MED,
  SITUACAO_CASO_MED,
  SITUACAO_TRANSACAO,
} from '../shared';

/**
 * Os três furos de dinheiro do fluxo MED, fechados em ago/2026:
 *
 * 1. TETO por venda era read-then-write sem lock: dois avisos simultâneos com
 *    identificadores diferentes liam ambos "nada contestado" e debitavam a
 *    venda duas vezes. Agora dedupe + teto + criação ficam num único commit
 *    serializado por FOR UPDATE na transação da venda.
 * 2. DEBITAR_IMEDIATAMENTE debitava em commit próprio e marcava DEBITADO em
 *    outro: crash no meio deixava o caso RECEBIDO (decidível) e o ACEITO
 *    debitava DE NOVO com chave diferente. Agora débito + encerramento são o
 *    mesmo commit — ou o caso nasce encerrado, ou nada aconteceu.
 * 3. Reentrega do mesmo aviso devolve `duplicado: true`, nunca 400 — 4xx no
 *    webhook vira tempestade de retries da liquidante.
 */
describe('MedService.receber — teto por venda e débito imediato', () => {
  let prisma: PrismaService;
  let med: MedService;
  let usuarioId: bigint;
  let sufixo: string;

  async function criarVenda(valor: string) {
    return prisma.transacao.create({
      data: {
        usuarioId,
        direcao: 'ENTRADA',
        valorBruto: valor,
        valorLiquidacaoEmpresa: valor,
        situacao: SITUACAO_TRANSACAO.CONCLUIDA,
      },
    });
  }

  async function definirModo(modo: 'BLOQUEAR_SALDO' | 'DEBITAR_IMEDIATAMENTE') {
    await prisma.configuracaoPixUsuario.update({
      where: { usuarioId },
      data: { modoTratamentoMed: modo },
    });
  }

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService, LedgerService, ConfigPixService],
    }).compile();

    prisma = modulo.get(PrismaService);
    await prisma.$connect();

    med = new MedService(
      prisma,
      modulo.get(LedgerService),
      modulo.get(ConfigPixService),
      {} as never,
      {
        enqueueOutbox: async () => undefined,
        enqueueEmail: async () => undefined,
        enqueueDevolucaoPix: async () => undefined,
      } as never,
    );

    sufixo = `${Date.now()}`;

    const usuario = await prisma.usuario.upsert({
      where: { email: 'med-receber@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '11111111116',
        nomeRazaoSocial: 'Med Receber Test',
        email: 'med-receber@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO' },
    });
    usuarioId = usuario.id;

    const provedor = await prisma.provedorPagamento.upsert({
      where: { codigo: 'teste_med' },
      create: {
        codigo: 'teste_med',
        nome: 'Adquirente de teste (MED)',
        permitePixEntrada: true,
        permitePixSaida: true,
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO' },
    });
    const conta = await prisma.contaProvedor.upsert({
      where: { chaveUnicaConta: 'teste_med:conta-principal' },
      create: {
        provedorPagamentoId: provedor.id,
        nome: 'Conta teste MED',
        chaveUnicaConta: 'teste_med:conta-principal',
        credenciaisCriptografadas: '',
        pixEntradaHabilitado: true,
        pixSaidaHabilitado: true,
        situacao: 'ATIVO',
        ticketMaximoPixEntrada: '100000',
      },
      update: { situacao: 'ATIVO' },
    });

    await prisma.configuracaoPixUsuario.upsert({
      where: { usuarioId },
      create: {
        usuarioId,
        contaProvedorPixEntradaId: conta.id,
        contaProvedorPixSaidaId: conta.id,
        ticketMaximoPixEntrada: '100000',
        modoTratamentoMed: MODO_TRATAMENTO_MED.BLOQUEAR_SALDO,
      },
      update: { modoTratamentoMed: MODO_TRATAMENTO_MED.BLOQUEAR_SALDO },
    });

    await prisma.saldoUsuario.upsert({
      where: { usuarioId },
      create: { usuarioId, saldoDisponivel: '10000.00' },
      update: { saldoDisponivel: '10000.00' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('reentrega do MESMO aviso devolve duplicado, nunca erro', async () => {
    await definirModo(MODO_TRATAMENTO_MED.BLOQUEAR_SALDO);
    const venda = await criarVenda('100.00');

    const primeiro = await med.receber({
      idTransacaoPublico: venda.idTransacaoPublico,
      valorSolicitado: '100.00',
      identificadorMedProvedor: `med-dup-${sufixo}`,
      origem: 'WEBHOOK_PROVEDOR',
    });
    expect(primeiro.duplicado).toBe(false);

    const segundo = await med.receber({
      idTransacaoPublico: venda.idTransacaoPublico,
      valorSolicitado: '100.00',
      identificadorMedProvedor: `med-dup-${sufixo}`,
      origem: 'WEBHOOK_PROVEDOR',
    });
    expect(segundo.duplicado).toBe(true);
    expect(segundo.idPublico).toBe(primeiro.idPublico);
  });

  it('teto por venda: aviso com identificador DIFERENTE não fura o valor bruto', async () => {
    await definirModo(MODO_TRATAMENTO_MED.BLOQUEAR_SALDO);
    const venda = await criarVenda('100.00');

    await med.receber({
      idTransacaoPublico: venda.idTransacaoPublico,
      valorSolicitado: '60.00',
      identificadorMedProvedor: `med-teto-a-${sufixo}`,
      origem: 'WEBHOOK_PROVEDOR',
    });

    await expect(
      med.receber({
        idTransacaoPublico: venda.idTransacaoPublico,
        valorSolicitado: '60.00',
        identificadorMedProvedor: `med-teto-b-${sufixo}`,
        origem: 'WEBHOOK_PROVEDOR',
      }),
    ).rejects.toThrow('saldo contestável');
  });

  it('CORRIDA: dois avisos simultâneos nunca passam juntos do teto', async () => {
    await definirModo(MODO_TRATAMENTO_MED.BLOQUEAR_SALDO);
    const venda = await criarVenda('100.00');

    // Antes do FOR UPDATE, os dois liam "nada contestado" e os dois criavam:
    // 120 contestados numa venda de 100, com dois bloqueios de saldo.
    const resultados = await Promise.allSettled([
      med.receber({
        idTransacaoPublico: venda.idTransacaoPublico,
        valorSolicitado: '60.00',
        identificadorMedProvedor: `med-corrida-a-${sufixo}`,
        origem: 'WEBHOOK_PROVEDOR',
      }),
      med.receber({
        idTransacaoPublico: venda.idTransacaoPublico,
        valorSolicitado: '60.00',
        identificadorMedProvedor: `med-corrida-b-${sufixo}`,
        origem: 'WEBHOOK_PROVEDOR',
      }),
    ]);

    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const rejeitados = resultados.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(rejeitados).toHaveLength(1);

    const casos = await prisma.casoMed.findMany({
      where: { transacaoId: venda.id },
    });
    expect(casos).toHaveLength(1);
  });

  it('DEBITAR_IMEDIATAMENTE: caso nasce encerrado, débito único e sem segunda decisão', async () => {
    await definirModo(MODO_TRATAMENTO_MED.DEBITAR_IMEDIATAMENTE);
    const venda = await criarVenda('80.00');

    const r = await med.receber({
      idTransacaoPublico: venda.idTransacaoPublico,
      valorSolicitado: '80.00',
      identificadorMedProvedor: `med-deb-${sufixo}`,
      origem: 'WEBHOOK_PROVEDOR',
    });
    expect(r.situacao).toBe(SITUACAO_CASO_MED.DEBITADO);

    const caso = await prisma.casoMed.findFirstOrThrow({
      where: { transacaoId: venda.id },
    });
    // Encerrado no MESMO commit do débito: nunca existe janela em que o caso
    // fica decidível com o dinheiro já debitado.
    expect(caso.situacao).toBe(SITUACAO_CASO_MED.DEBITADO);
    expect(caso.encerradoEm).not.toBeNull();
    expect(caso.valorDebitado.toString()).toBe('80');

    const debitos = await prisma.movimentacaoSaldo.findMany({
      where: { casoMedId: caso.id },
    });
    expect(debitos).toHaveLength(1);
    expect(debitos[0].chaveIdempotencia).toBe(`med:deb:${caso.id}`);

    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: venda.id } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.MED);

    // "Aceitar" depois — que debitaria de novo com outra chave — é recusado.
    await expect(
      med.decidir({
        idPublico: caso.idPublico,
        decisao: 'ACEITO',
        usuarioAtorId: usuarioId,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
