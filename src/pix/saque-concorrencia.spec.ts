import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { encryptCredentials } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { PixService } from './pix.service';
import { money, SITUACAO_CHAVE_PIX, SITUACAO_PROVEDOR } from '../shared';

/**
 * Saques DISPARADOS NO MESMO INSTANTE (bot de saques).
 *
 * Duas perguntas diferentes, com respostas diferentes:
 *
 * 1. Dois saques concorrentes conseguem gastar o MESMO saldo duas vezes?
 *    Não — `SELECT FOR UPDATE` em `saldos_usuarios` serializa, e o segundo lê o
 *    saldo já debitado.
 * 2. A MESMA ordem de saque (mesma `referenciaExterna`) enviada duas vezes no
 *    mesmo instante vira DOIS pagamentos? O pre-check em `criarSaque` é um
 *    read-then-write e, sozinho, não resolve a corrida: as duas chamadas leem
 *    "não existe" antes de qualquer uma gravar. Quem tem que barrar é o banco.
 */
describe('PixService.criarSaque — dois saques no mesmo instante', () => {
  let prisma: PrismaService;
  let pix: PixService;
  let usuarioId: bigint;
  let sufixo: string;

  const entrada = {
    chavePix: 'chave-conc@vpay.local',
    tipoChavePix: 'EMAIL',
    nomeBeneficiario: 'Saque Concorrencia Test',
    documentoBeneficiario: '99988877766',
  };

  const saldoDisponivel = async () => {
    const s = await prisma.saldoUsuario.findUniqueOrThrow({ where: { usuarioId } });
    return money(s.saldoDisponivel.toString());
  };

  const definirSaldo = async (valor: string) => {
    await prisma.saldoUsuario.upsert({
      where: { usuarioId },
      create: { usuarioId, saldoDisponivel: valor },
      update: { saldoDisponivel: valor },
    });
  };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService, LedgerService, ConfigPixService],
    }).compile();

    prisma = modulo.get(PrismaService);
    await prisma.$connect();

    pix = new PixService(
      prisma,
      modulo.get(ConfigPixService),
      modulo.get(LedgerService),
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
      where: { email: 'saque-concorrencia@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '99988877766',
        nomeRazaoSocial: 'Saque Concorrencia Test',
        email: 'saque-concorrencia@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO' },
    });
    usuarioId = usuario.id;

    const provedor = await prisma.provedorPagamento.upsert({
      where: { codigo: 'teste_conc' },
      create: {
        codigo: 'teste_conc',
        nome: 'Adquirente de teste (concorrência)',
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
          nome: 'Conta teste concorrência',
          chaveUnicaConta: 'teste_conc:conta-principal',
          // AES-GCM: JSON em claro não é mais aceito por `decryptCredentials`.
          credenciaisCriptografadas: encryptCredentials({}),
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
        // Sem tarifa: simplifica a aritmética do teste de saldo.
        taxaPixSaidaPercentual: '0',
        taxaPixSaidaFixa: '0',
        origemSaquePermitida: 'PAINEL',
      },
      update: {
        contaProvedorPixSaidaId: conta.id,
        ticketMinimoPixSaida: '0',
        taxaPixSaidaPercentual: '0',
        taxaPixSaidaFixa: '0',
        origemSaquePermitida: 'PAINEL',
      },
    });

    await prisma.chavePixUsuario.upsert({
      where: {
        usuarioId_chave: { usuarioId, chave: entrada.chavePix },
      },
      create: {
        usuarioId,
        chave: entrada.chavePix,
        tipoChave: 'EMAIL',
        situacao: SITUACAO_CHAVE_PIX.APROVADA,
        nomeTitular: 'Concorrencia Test',
        documentoTitular: '11111111114',
      },
      update: { situacao: SITUACAO_CHAVE_PIX.APROVADA },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * A trava de saldo: dois saques de 60 numa conta com 100 não podem passar os
   * dois. Isso é o `SELECT FOR UPDATE` fazendo o trabalho dele.
   */
  it('dois saques simultâneos NÃO gastam o mesmo saldo duas vezes', async () => {
    await definirSaldo('100.00');

    const resultados = await Promise.allSettled([
      pix.criarSaque({
        usuarioId,
        input: { ...entrada, valor: '60.00', referenciaExterna: `conc-a-${sufixo}` } as never,
      }),
      pix.criarSaque({
        usuarioId,
        input: { ...entrada, valor: '60.00', referenciaExterna: `conc-b-${sufixo}` } as never,
      }),
    ]);

    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const erro = resultados.filter((r) => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(erro).toHaveLength(1);
    expect((erro[0] as PromiseRejectedResult).reason.message).toContain(
      'Saldo disponível insuficiente',
    );
    // Sobrou exatamente o que não foi sacado — nada de saldo negativo.
    expect((await saldoDisponivel()).toFixed(2)).toBe('40.00');
  });

  /**
   * A trava de DUPLICIDADE: a mesma ordem enviada duas vezes no mesmo instante
   * (bot que reenvia) não pode virar dois pagamentos. O pre-check sozinho é
   * read-then-write e perde a corrida; quem decide é a unique do banco.
   */
  it('a MESMA referenciaExterna enviada 2x no mesmo instante gera UM saque só', async () => {
    await definirSaldo('1000.00');
    const referencia = `conc-dup-${sufixo}`;

    const resultados = await Promise.allSettled([
      pix.criarSaque({
        usuarioId,
        input: { ...entrada, valor: '30.00', referenciaExterna: referencia } as never,
      }),
      pix.criarSaque({
        usuarioId,
        input: { ...entrada, valor: '30.00', referenciaExterna: referencia } as never,
      }),
    ]);

    const criadas = await prisma.transacao.findMany({
      where: { usuarioId, direcao: 'SAIDA', referenciaExterna: referencia },
      include: { movimentacoes: true },
    });

    // UMA transação de saque, não duas.
    expect(criadas).toHaveLength(1);

    // E o dinheiro saiu UMA vez só.
    expect((await saldoDisponivel()).toFixed(2)).toBe('970.00');

    // A perdedora da corrida não pode ter virado sucesso silencioso.
    const sucessos = resultados.filter((r) => r.status === 'fulfilled');
    expect(sucessos.length).toBeGreaterThanOrEqual(1);
    for (const s of sucessos) {
      const valor = (s as PromiseFulfilledResult<{ idTransacao: string }>).value;
      expect(valor.idTransacao).toBe(criadas[0].idTransacaoPublico);
    }
  });
});
