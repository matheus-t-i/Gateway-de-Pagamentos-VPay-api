import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';
import { money } from '../shared';

/**
 * Conta ATIVA sem linha em `saldos_usuarios` (admin de seed, ativação antiga).
 * O crédito de um PIX pago não pode morrer em "carteira não encontrada".
 */
describe('LedgerService — carteira ausente', () => {
  let prisma: PrismaService;
  let ledger: LedgerService;
  let usuarioId: bigint;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService, LedgerService],
    }).compile();
    prisma = module.get(PrismaService);
    ledger = module.get(LedgerService);
    await prisma.$connect();

    const user = await prisma.usuario.upsert({
      where: { email: 'ledger-sem-carteira@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: `9${String(Date.now()).slice(-10)}`,
        nomeRazaoSocial: 'Ledger Sem Carteira',
        email: 'ledger-sem-carteira@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO' },
    });
    usuarioId = user.id;
    await prisma.movimentacaoSaldo.deleteMany({ where: { usuarioId } });
    await prisma.saldoUsuario.deleteMany({ where: { usuarioId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('crédito abre a carteira zerada e aplica o valor', async () => {
    expect(
      await prisma.saldoUsuario.findUnique({ where: { usuarioId } }),
    ).toBeNull();

    const chave = `test:carteira:${Date.now()}`;
    await ledger.aplicarMovimentacoes({
      usuarioId,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'CREDITO',
          natureza: 'RECEBIMENTO',
          valor: money('25.50'),
          chaveIdempotencia: chave,
        },
      ],
    });

    const saldo = await prisma.saldoUsuario.findUniqueOrThrow({
      where: { usuarioId },
    });
    expect(money(saldo.saldoDisponivel.toString()).toFixed(2)).toBe('25.50');
  });
});
