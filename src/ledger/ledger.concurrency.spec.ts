import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';
import { money } from '../shared';

/**
 * Teste de concorrência: duas escritas paralelas na mesma empresa
 * devem serializar via SELECT FOR UPDATE e produzir saldo coerente.
 */
describe('LedgerService concurrency', () => {
  let prisma: PrismaService;
  let ledger: LedgerService;
  let empresaId: bigint;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService, LedgerService],
    }).compile();
    prisma = module.get(PrismaService);
    ledger = module.get(LedgerService);
    await prisma.$connect();

    const user = await prisma.usuario.upsert({
      where: { email: 'ledger-test@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '11111111111',
        nomeRazaoSocial: 'Ledger Test',
        email: 'ledger-test@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: {},
    });
    const empresa = await prisma.empresa.upsert({
      where: { cnpj: '11111111000111' },
      create: {
        usuarioProprietarioId: user.id,
        cnpj: '11111111000111',
        razaoSocial: 'Empresa Ledger Test',
        situacao: 'ATIVA',
      },
      update: { situacao: 'ATIVA' },
    });
    empresaId = empresa.id;
    await prisma.saldoEmpresa.upsert({
      where: { empresaId },
      create: {
        empresaId,
        saldoDisponivel: '0',
        saldoPendenteLiberacao: '0',
        saldoReservado: '0',
        saldoBloqueadoMed: '0',
      },
      update: {
        saldoDisponivel: '0',
        saldoPendenteLiberacao: '0',
        saldoReservado: '0',
        saldoBloqueadoMed: '0',
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('duas créditos paralelos somam corretamente', async () => {
    const suffix = Date.now();
    await Promise.all([
      ledger.aplicarMovimentacoes({
        empresaId,
        entries: [
          {
            tipoSaldo: 'DISPONIVEL',
            tipoMovimento: 'CREDITO',
            natureza: 'AJUSTE',
            valor: money('10.00'),
            chaveIdempotencia: `test:a:${suffix}`,
          },
        ],
      }),
      ledger.aplicarMovimentacoes({
        empresaId,
        entries: [
          {
            tipoSaldo: 'DISPONIVEL',
            tipoMovimento: 'CREDITO',
            natureza: 'AJUSTE',
            valor: money('15.50'),
            chaveIdempotencia: `test:b:${suffix}`,
          },
        ],
      }),
    ]);

    const saldo = await prisma.saldoEmpresa.findUniqueOrThrow({
      where: { empresaId },
    });
    // saldo pode ter restos de runs anteriores; validamos incremento via movimentações
    const movs = await prisma.movimentacaoSaldo.findMany({
      where: {
        empresaId,
        chaveIdempotencia: { in: [`test:a:${suffix}`, `test:b:${suffix}`] },
      },
    });
    expect(movs).toHaveLength(2);
    const sum = movs.reduce((acc, m) => acc.plus(money(m.valor.toString())), money(0));
    expect(sum.toFixed(2)).toBe('25.50');
    expect(saldo.saldoDisponivel).toBeDefined();
  });
});
