import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';
import { money } from '../shared';

/**
 * Trava de saldo negativo do ledger.
 *
 * A conta FICA negativa quando um MED é debitado direto (modo
 * `DEBITAR_IMEDIATAMENTE`) — a adquirente já levou o dinheiro. O que estes
 * testes fixam é o que pode e o que não pode acontecer DEPOIS disso:
 *
 * - saque (débito do disponível) continua recusado, mesmo na conta que permite
 *   ficar negativa por MED — senão a VPay pagaria dinheiro que o lojista não tem;
 * - crédito e liberação D+/reserva PASSAM na conta negativa — é justamente a
 *   receita futura quitando a dívida. Enquanto a trava olhava o estado da conta
 *   (e não a movimentação), a liberação morria em FALHA e o dinheiro do lojista
 *   ficava congelado em `PENDENTE_LIBERACAO` para sempre.
 */
describe('LedgerService — saldo negativo', () => {
  let prisma: PrismaService;
  let ledger: LedgerService;
  let usuarioId: bigint;
  const chave = (nome: string) => `test:neg:${nome}:${sufixo}`;
  let sufixo: number;

  const saldoDisponivel = async () => {
    const s = await prisma.saldoUsuario.findUniqueOrThrow({ where: { usuarioId } });
    return money(s.saldoDisponivel.toString()).toFixed(2);
  };

  beforeAll(async () => {
    sufixo = Number(process.env.JEST_WORKER_ID ?? 1) * 1_000_000 + Math.trunc(Date.now() % 1_000_000);
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService, LedgerService],
    }).compile();
    prisma = module.get(PrismaService);
    ledger = module.get(LedgerService);
    await prisma.$connect();

    const user = await prisma.usuario.upsert({
      where: { email: 'ledger-negativo@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '11111111112',
        nomeRazaoSocial: 'Ledger Negativo Test',
        email: 'ledger-negativo@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO' },
    });
    usuarioId = user.id;
    const zerado = {
      saldoDisponivel: '0',
      saldoPendenteLiberacao: '0',
      saldoReservado: '0',
      saldoBloqueadoMed: '0',
      saldoBloqueadoManual: '0',
    };
    await prisma.saldoUsuario.upsert({
      where: { usuarioId },
      create: { usuarioId, ...zerado },
      update: zerado,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('recusa débito do disponível que deixaria a conta negativa', async () => {
    await expect(
      ledger.aplicarMovimentacoes({
        usuarioId,
        entries: [
          {
            tipoSaldo: 'DISPONIVEL',
            tipoMovimento: 'DEBITO',
            natureza: 'SAIDA',
            valor: money('100.00'),
            chaveIdempotencia: chave('saque-sem-saldo'),
          },
        ],
      }),
    ).rejects.toThrow('Saldo disponível insuficiente');
    expect(await saldoDisponivel()).toBe('0.00');
  });

  it('MED com débito direto leva a conta a negativo', async () => {
    await ledger.aplicarMovimentacoes({
      usuarioId,
      permiteSaldoNegativo: true,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'DEBITO',
          natureza: 'DEBITO_MED',
          valor: money('100.00'),
          chaveIdempotencia: chave('med-direto'),
        },
      ],
    });
    expect(await saldoDisponivel()).toBe('-100.00');
  });

  it('conta negativa continua recebendo crédito de venda', async () => {
    await ledger.aplicarMovimentacoes({
      usuarioId,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'CREDITO',
          natureza: 'RECEBIMENTO',
          valor: money('30.00'),
          chaveIdempotencia: chave('cashin'),
        },
      ],
    });
    expect(await saldoDisponivel()).toBe('-70.00');
  });

  it('liberação D+ conclui na conta negativa e abate a dívida', async () => {
    await ledger.aplicarMovimentacoes({
      usuarioId,
      entries: [
        {
          tipoSaldo: 'PENDENTE_LIBERACAO',
          tipoMovimento: 'CREDITO',
          natureza: 'RECEBIMENTO',
          valor: money('200.00'),
          chaveIdempotencia: chave('pendente'),
        },
      ],
    });

    // O par exato da fila 6: sai do pendente, entra no disponível. Nenhuma das
    // duas entries passa `permiteSaldoNegativo` — e as duas têm que passar.
    await ledger.aplicarMovimentacoes({
      usuarioId,
      entries: [
        {
          tipoSaldo: 'PENDENTE_LIBERACAO',
          tipoMovimento: 'DEBITO',
          natureza: 'LIBERACAO',
          valor: money('200.00'),
          chaveIdempotencia: chave('lib-deb'),
        },
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'CREDITO',
          natureza: 'LIBERACAO',
          valor: money('200.00'),
          chaveIdempotencia: chave('lib-cred'),
        },
      ],
    });

    expect(await saldoDisponivel()).toBe('130.00');
    const s = await prisma.saldoUsuario.findUniqueOrThrow({ where: { usuarioId } });
    expect(money(s.saldoPendenteLiberacao.toString()).toFixed(2)).toBe('0.00');
  });

  it('saque continua limitado ao saldo mesmo depois de a conta ter ficado negativa', async () => {
    await expect(
      ledger.aplicarMovimentacoes({
        usuarioId,
        entries: [
          {
            tipoSaldo: 'DISPONIVEL',
            tipoMovimento: 'DEBITO',
            natureza: 'SAIDA',
            valor: money('200.00'),
            chaveIdempotencia: chave('saque-acima'),
          },
        ],
      }),
    ).rejects.toThrow('Saldo disponível insuficiente');
    expect(await saldoDisponivel()).toBe('130.00');
  });

  /**
   * Dedupe idempotente: a MESMA chave tem que significar a MESMA movimentação.
   *
   * Toda chave de dinheiro deriva de id NOSSO (`saque:hold:<idTransacaoPrivado>`,
   * `saque:estorno:<txId>`, `cashin:*:<txId>`), então uma chave reaproveitada
   * com valor diferente significa bug ou corrupção — nunca fluxo normal. Vale
   * como invariante de defesa: recusa e deixa para reconciliação humana, em vez
   * de devolver a movimentação antiga e deixar o débito descasado.
   */
  it('reusar a chave com o MESMO valor é idempotente (não debita de novo)', async () => {
    const c = chave('idem-igual');
    const antes = await saldoDisponivel();
    await ledger.aplicarMovimentacoes({
      usuarioId,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'CREDITO',
          natureza: 'RECEBIMENTO',
          valor: money('10.00'),
          chaveIdempotencia: c,
        },
      ],
    });
    const depoisPrimeira = await saldoDisponivel();
    // Segunda chamada, MESMA chave, MESMO valor: não credita de novo.
    await ledger.aplicarMovimentacoes({
      usuarioId,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'CREDITO',
          natureza: 'RECEBIMENTO',
          valor: money('10.00'),
          chaveIdempotencia: c,
        },
      ],
    });
    expect(money(antes).plus(money('10.00')).toFixed(2)).toBe(depoisPrimeira);
    expect(await saldoDisponivel()).toBe(depoisPrimeira);
  });

  it('reusar a chave com OUTRO valor é recusado (fecha o vazamento do saque)', async () => {
    const c = chave('idem-divergente');
    await ledger.aplicarMovimentacoes({
      usuarioId,
      entries: [
        {
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'CREDITO',
          natureza: 'RECEBIMENTO',
          valor: money('10.00'),
          chaveIdempotencia: c,
        },
      ],
    });
    const saldo = await saldoDisponivel();
    await expect(
      ledger.aplicarMovimentacoes({
        usuarioId,
        entries: [
          {
            tipoSaldo: 'DISPONIVEL',
            tipoMovimento: 'CREDITO',
            natureza: 'RECEBIMENTO',
            valor: money('999.00'),
            chaveIdempotencia: c,
          },
        ],
      }),
    ).rejects.toThrow('já usada com outro');
    // Nada mudou: a divergência falha fechada.
    expect(await saldoDisponivel()).toBe(saldo);
  });
});
