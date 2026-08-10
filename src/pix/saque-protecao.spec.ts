import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { encryptCredentials } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { PixService } from './pix.service';
import { SaqueProtecaoService } from './saque-protecao.service';
import { PixCashOutProcessor } from '../worker-processors/pix-cash-out.processor';
import {
  money,
  SITUACAO_CHAVE_PIX,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
} from '../shared';

/**
 * O limite diário/velocity NÃO pode contar o próprio saque em revalidação.
 *
 * O débito acontece na criação — quando o worker revalida, a transação JÁ
 * existe como SAIDA de hoje e entrava no próprio `aggregate`/`count`: qualquer
 * saque acima de metade do limite diário (ou o N-ésimo com
 * `maxSaquesPorHora = N`) era recusado deterministicamente no worker, com o
 * saldo debitado, sem estorno e sem rede de recuperação. `ignorarTransacaoId`
 * exclui o saque em curso da conta (filtro de leitura — nada é apagado).
 *
 * Os limites dos testes são calculados RELATIVOS ao uso já existente do dia:
 * nada é deletado (transação nunca é excluída no sistema, nem em teste) e o
 * spec não depende de base limpa.
 */
describe('SaqueProtecaoService — o saque em curso não conta contra si mesmo', () => {
  let prisma: PrismaService;
  let pix: PixService;
  let protecao: SaqueProtecaoService;
  let configPix: ConfigPixService;
  let ledger: LedgerService;
  let usuarioId: bigint;
  let sufixo: string;

  async function criarSaque(referencia: string, valor: string) {
    const r = await pix.criarSaque({
      usuarioId,
      input: {
        valor,
        chavePix: 'protecao@vpay.local',
        tipoChavePix: 'EMAIL',
        nomeBeneficiario: 'Protecao Test',
        documentoBeneficiario: '11111111115',
        referenciaExterna: referencia,
      } as never,
    });
    return BigInt(r.idInterno);
  }

  /** A mesma soma do dia que o serviço faz (sem excluir ninguém). */
  async function usadoHoje() {
    const agg = await prisma.transacao.aggregate({
      where: {
        usuarioId,
        direcao: 'SAIDA',
        criadoEm: { gte: protecao.inicioDoDiaBrasilia() },
        situacao: { not: SITUACAO_TRANSACAO.CANCELADA },
      },
      _sum: { valorBruto: true },
    });
    return money(agg._sum.valorBruto?.toString() ?? '0');
  }

  async function saquesUltimaHora() {
    return prisma.transacao.count({
      where: {
        usuarioId,
        direcao: 'SAIDA',
        criadoEm: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        situacao: { not: SITUACAO_TRANSACAO.CANCELADA },
      },
    });
  }

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService, LedgerService, ConfigPixService],
    }).compile();

    prisma = modulo.get(PrismaService);
    await prisma.$connect();
    configPix = modulo.get(ConfigPixService);
    ledger = modulo.get(LedgerService);
    protecao = new SaqueProtecaoService(prisma);

    // A criação usa a proteção stubada: o alvo do spec é a REVALIDAÇÃO.
    pix = new PixService(
      prisma,
      configPix,
      ledger,
      {} as never,
      { enqueuePixCashOut: () => Promise.resolve() } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        assertSaquePermitido: async () => undefined,
        registrarRecusaSaque: async () => undefined,
      } as never,
    );

    sufixo = `${Date.now()}`;

    const usuario = await prisma.usuario.upsert({
      where: { email: 'saque-protecao@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '11111111115',
        nomeRazaoSocial: 'Protecao Test',
        email: 'saque-protecao@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      // A carência pós-troca de senha não é o alvo deste spec.
      update: { situacao: 'ATIVO', contaBloqueada: false, senhaAlteradaEm: null },
    });
    usuarioId = usuario.id;

    const provedor = await prisma.provedorPagamento.upsert({
      where: { codigo: 'teste_protecao' },
      create: {
        codigo: 'teste_protecao',
        nome: 'Adquirente de teste (proteção)',
        permitePixEntrada: true,
        permitePixSaida: true,
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
      update: { situacao: SITUACAO_PROVEDOR.ATIVO },
    });

    const conta = await prisma.contaProvedor.upsert({
      where: { chaveUnicaConta: 'teste_protecao:conta-principal' },
      create: {
        provedorPagamentoId: provedor.id,
        nome: 'Conta teste proteção',
        chaveUnicaConta: 'teste_protecao:conta-principal',
        credenciaisCriptografadas: encryptCredentials({}),
        pixEntradaHabilitado: true,
        pixSaidaHabilitado: true,
        situacao: SITUACAO_PROVEDOR.ATIVO,
        ticketMaximoPixEntrada: '100000',
      },
      update: {
        credenciaisCriptografadas: encryptCredentials({}),
        situacao: SITUACAO_PROVEDOR.ATIVO,
        pixSaidaHabilitado: true,
      },
    });

    await prisma.configuracaoPixUsuario.upsert({
      where: { usuarioId },
      create: {
        usuarioId,
        contaProvedorPixEntradaId: conta.id,
        contaProvedorPixSaidaId: conta.id,
        ticketMaximoPixEntrada: '100000',
        ticketMinimoPixSaida: '0',
        taxaPixSaidaPercentual: '0',
        taxaPixSaidaFixa: '0',
        origemSaquePermitida: 'PAINEL',
        exigirChavePixCadastrada: false,
      },
      update: {
        contaProvedorPixSaidaId: conta.id,
        ticketMinimoPixSaida: '0',
        taxaPixSaidaPercentual: '0',
        taxaPixSaidaFixa: '0',
        origemSaquePermitida: 'PAINEL',
        exigirChavePixCadastrada: false,
        limiteDiarioPixSaida: null,
        maxSaquesPorHora: null,
        saqueBloqueadoPorAbuso: false,
        saqueBloqueadoPorAbusoMotivo: null,
      },
    });

    await prisma.saldoUsuario.upsert({
      where: { usuarioId },
      create: { usuarioId, saldoDisponivel: '5000.00' },
      update: { saldoDisponivel: '5000.00' },
    });

    await prisma.chavePixUsuario.upsert({
      where: { usuarioId_chave: { usuarioId, chave: 'protecao@vpay.local' } },
      create: {
        usuarioId,
        chave: 'protecao@vpay.local',
        tipoChave: 'EMAIL',
        situacao: SITUACAO_CHAVE_PIX.APROVADA,
        nomeTitular: 'Protecao Test',
        documentoTitular: '11111111115',
      },
      update: { situacao: SITUACAO_CHAVE_PIX.APROVADA },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('limite diário: o saque em curso é excluído da soma (senão conta duas vezes)', async () => {
    // Limite relativo ao uso do dia: cabe R$ 900 a mais; o saque é de R$ 600.
    const antes = await usadoHoje();
    const limite = antes.plus(900);
    const transacaoId = await criarSaque(`prot-diario-${sufixo}`, '600.00');
    const cfg = { limiteDiarioPixSaida: limite, maxSaquesPorHora: null } as never;

    // A conta do worker SEM excluir o próprio saque: ele soma no "já usado" E
    // no valor — 600 contados duas vezes estouram os 900 que cabiam. Era
    // exatamente o bug que congelava o saque com o saldo já debitado.
    await expect(
      protecao.assertSaquePermitido({ usuarioId, valor: money('600'), cfg }),
    ).rejects.toThrow('Limite diário');

    // Excluindo o saque em curso, a revalidação enxerga o mesmo cenário da
    // criação e deixa o envio seguir.
    await expect(
      protecao.assertSaquePermitido({
        usuarioId,
        valor: money('600'),
        cfg,
        ignorarTransacaoId: transacaoId,
      }),
    ).resolves.toBeUndefined();
  });

  it('velocity: o saque em curso é excluído da contagem', async () => {
    const transacaoId = await criarSaque(`prot-velocity-${sufixo}`, '10.00');
    // Teto = contagem atual (já incluindo o saque em curso): sem a exclusão a
    // revalidação vê `qtd >= max` e bloqueia; excluindo, sobra exatamente a
    // vaga que o próprio saque ocupou.
    const max = await saquesUltimaHora();
    const cfg = { limiteDiarioPixSaida: null, maxSaquesPorHora: max } as never;

    await expect(
      protecao.assertSaquePermitido({ usuarioId, valor: money('10'), cfg }),
    ).rejects.toThrow('velocity');

    await expect(
      protecao.assertSaquePermitido({
        usuarioId,
        valor: money('10'),
        cfg,
        ignorarTransacaoId: transacaoId,
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * A prova de ponta a ponta: o processor com a proteção REAL envia um saque
   * acima de metade da folga do limite diário. Antes da correção, este teste
   * morria em `SaqueBloqueadoError` com o débito preso — o PIX nunca saía.
   */
  it('processor com proteção real envia saque acima de metade da folga do limite', async () => {
    // Folga de R$ 450 sobre o uso atual do dia; saque de R$ 300 (> metade).
    const limite = (await usadoHoje()).plus(450);
    await prisma.configuracaoPixUsuario.update({
      where: { usuarioId },
      data: { limiteDiarioPixSaida: limite.toFixed(2) },
    });
    const transacaoId = await criarSaque(`prot-processor-${sufixo}`, '300.00');

    let chamadas = 0;
    const registry = {
      get: () => ({
        createCashOut: async () => {
          chamadas += 1;
          return { idTransacaoLiquidante: `LIQ-PROT-${sufixo}`, raw: { ok: true } };
        },
      }),
    };
    const processor = new PixCashOutProcessor(
      prisma,
      registry as never,
      configPix,
      ledger,
      protecao,
    );

    await processor.process({
      data: {
        provider: 'teste_protecao',
        payload: { transacaoId: transacaoId.toString(), idTransacaoPrivado: 'x' },
      },
    } as never);

    expect(chamadas).toBe(1);
    const tentativa = await prisma.tentativaTransacao.findFirstOrThrow({
      where: { transacaoId },
    });
    expect(tentativa.situacao).toBe(SITUACAO_TENTATIVA.SUCESSO);

    // Limpa o limite para não afetar outras suítes que usam o mesmo usuário.
    await prisma.configuracaoPixUsuario.update({
      where: { usuarioId },
      data: { limiteDiarioPixSaida: null },
    });
  });
});
