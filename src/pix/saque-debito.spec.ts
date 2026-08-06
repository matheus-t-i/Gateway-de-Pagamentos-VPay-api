import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { PixService } from './pix.service';
import { money, SITUACAO_PROVEDOR, SITUACAO_TRANSACAO } from '../shared';

/**
 * O saque tem que sair com o débito AMARRADO à transação.
 *
 * `PixCashOutProcessor` revalida, antes de mandar dinheiro para a liquidante,
 * se `movimentacoes_saldo` daquela `transacao_id` soma valor + tarifa. As
 * movimentações do saque nasciam sem `transacao_id` (o débito acontece antes de
 * a transação existir), então a soma dava ZERO e todo saque morria na
 * revalidação — com o saldo do lojista já debitado e a transação presa em
 * PROCESSANDO. Este teste reproduz exatamente a conta que o processor faz.
 */
describe('PixService.criarSaque — débito amarrado à transação', () => {
  let prisma: PrismaService;
  let pix: PixService;
  let usuarioId: bigint;
  let sufixo: string;

  const enfileirados: unknown[] = [];

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService, LedgerService, ConfigPixService],
    }).compile();

    prisma = modulo.get(PrismaService);
    await prisma.$connect();

    // `criarSaque` só usa prisma, configPix, ledger e a fila; o resto das
    // dependências do PixService não é tocado neste caminho.
    pix = new PixService(
      prisma,
      modulo.get(ConfigPixService),
      modulo.get(LedgerService),
      {} as never,
      {
        enqueuePixCashOut: (job: unknown) => {
          enfileirados.push(job);
          return Promise.resolve();
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    sufixo = `${Date.now()}`;

    const usuario = await prisma.usuario.upsert({
      where: { email: 'saque-debito@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '11111111113',
        nomeRazaoSocial: 'Saque Debito Test',
        email: 'saque-debito@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO' },
    });
    usuarioId = usuario.id;

    const provedor = await prisma.provedorPagamento.upsert({
      where: { codigo: 'teste_saque' },
      create: {
        codigo: 'teste_saque',
        nome: 'Adquirente de teste (saque)',
        permitePixEntrada: true,
        permitePixSaida: true,
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
      update: { situacao: SITUACAO_PROVEDOR.ATIVO },
    });

    const contaExistente = await prisma.contaProvedor.findFirst({
      where: { provedorPagamentoId: provedor.id, usuarioId: null },
    });
    const conta =
      contaExistente ??
      (await prisma.contaProvedor.create({
        data: {
          provedorPagamentoId: provedor.id,
          nome: 'Conta teste saque',
          chaveUnicaConta: 'teste_saque:conta-principal',
          credenciaisCriptografadas: '{}',
          pixEntradaHabilitado: true,
          pixSaidaHabilitado: true,
          situacao: SITUACAO_PROVEDOR.ATIVO,
          ticketMaximoPixEntrada: '100000',
        },
      }));

    await prisma.configuracaoPixUsuario.upsert({
      where: { usuarioId },
      create: {
        usuarioId,
        contaProvedorPixEntradaId: conta.id,
        contaProvedorPixSaidaId: conta.id,
        ticketMaximoPixEntrada: '100000',
        ticketMinimoPixSaida: '0',
        taxaPixSaidaPercentual: '1',
        taxaPixSaidaFixa: '2',
        origemSaquePermitida: 'PAINEL',
        // O foco aqui é o vínculo do débito; a trava de chave PIX tem teste próprio.
        exigirChavePixCadastrada: false,
      },
      update: {
        contaProvedorPixSaidaId: conta.id,
        ticketMinimoPixSaida: '0',
        taxaPixSaidaPercentual: '1',
        taxaPixSaidaFixa: '2',
        origemSaquePermitida: 'PAINEL',
        exigirChavePixCadastrada: false,
      },
    });

    await prisma.saldoUsuario.upsert({
      where: { usuarioId },
      create: { usuarioId, saldoDisponivel: '1000.00' },
      update: { saldoDisponivel: '1000.00' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('as movimentações do saque carregam transacaoId e somam valor + tarifa', async () => {
    const referencia = `saque-teste-${sufixo}`;
    const resultado = await pix.criarSaque({
      usuarioId,
      input: {
        valor: '100.00',
        chavePix: 'chave-teste@vpay.local',
        tipoChavePix: 'EMAIL',
        nomeBeneficiario: 'Saque Debito Test',
        documentoBeneficiario: '11111111113',
        referenciaExterna: referencia,
      } as never,
    });

    const tx = await prisma.transacao.findUniqueOrThrow({
      where: { id: BigInt(resultado.idInterno) },
    });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.PROCESSANDO);

    // A MESMA conta do PixCashOutProcessor (item 5 da revalidação).
    const debitos = await prisma.movimentacaoSaldo.aggregate({
      where: { transacaoId: tx.id, tipoMovimento: 'DEBITO' },
      _sum: { valor: true },
    });
    const debitado = money(debitos._sum.valor?.toString() ?? '0');
    const esperado = money(tx.valorBruto.toString()).plus(
      money(tx.valorTarifaPix.toString()),
    );

    // taxa de 1% + R$ 2,00 sobre R$ 100 = R$ 3,00 de tarifa.
    expect(esperado.toFixed(2)).toBe('103.00');
    expect(debitado.toFixed(2)).toBe(esperado.toFixed(2));
    expect(debitado.lt(esperado)).toBe(false);
  });

  it('saque acima do saldo é recusado antes de criar a transação', async () => {
    const antes = await prisma.transacao.count({
      where: { usuarioId, direcao: 'SAIDA' },
    });
    await expect(
      pix.criarSaque({
        usuarioId,
        input: {
          valor: '999999.00',
          chavePix: 'chave-teste@vpay.local',
          tipoChavePix: 'EMAIL',
          nomeBeneficiario: 'Saque Debito Test',
          documentoBeneficiario: '11111111113',
          referenciaExterna: `saque-estouro-${sufixo}`,
        } as never,
      }),
    ).rejects.toThrow('Saldo disponível insuficiente');
    const depois = await prisma.transacao.count({
      where: { usuarioId, direcao: 'SAIDA' },
    });
    expect(depois).toBe(antes);
  });
});
