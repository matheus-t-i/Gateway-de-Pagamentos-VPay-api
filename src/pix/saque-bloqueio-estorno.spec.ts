import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { encryptCredentials } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { PixService } from './pix.service';
import { PixCashOutProcessor } from '../worker-processors/pix-cash-out.processor';
import {
  EVENTOS_LOJISTA,
  money,
  SITUACAO_CHAVE_PIX,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
} from '../shared';

/**
 * Saque BLOQUEADO na revalidação encerra em FALHA + estorno — nunca em loop.
 *
 * Antes: chave reprovada/conta bloqueada no worker lançava erro cru, a tx
 * ficava PROCESSANDO com o saldo debitado e o recovery de órfãos da conciliação
 * reenfileirava o MESMO bloqueio a cada 5 minutos, para sempre — dinheiro preso
 * sem motivo visível ao lojista e ALERTA_FILA se acumulando.
 *
 * O caso de EM VOO é o que separa esta correção de um estorno ingênuo: um retry
 * manual de saque JÁ ENVIADO também cai na revalidação (ex.: admin bloqueou a
 * conta com a ordem esperando webhook) — estornar ali devolveria o saldo de um
 * PIX pago. Perda dupla. Esse caminho NÃO pode tocar em nada.
 */
describe('PixCashOutProcessor — bloqueio encerra com estorno', () => {
  let prisma: PrismaService;
  let pix: PixService;
  let usuarioId: bigint;
  let chamadas = 0;

  let configPix: ConfigPixService;
  let ledger: LedgerService;

  const CHAVE = 'bloqueio@vpay.local';

  function processor(): PixCashOutProcessor {
    const registry = {
      get: () => ({
        createCashOut: async () => {
          chamadas += 1;
          return { idTransacaoLiquidante: `liq-bloq-${Date.now()}`, raw: {} };
        },
      }),
    };
    return new PixCashOutProcessor(
      prisma,
      registry as never,
      configPix,
      ledger,
      {
        assertSaquePermitido: async () => undefined,
        registrarRecusaSaque: async () => undefined,
      } as never,
    );
  }

  async function criarSaque(referencia: string) {
    const r = await pix.criarSaque({
      usuarioId,
      input: {
        valor: '50.00',
        chavePix: CHAVE,
        tipoChavePix: 'EMAIL',
        nomeBeneficiario: 'Bloqueio Test',
        documentoBeneficiario: '11111111130',
        referenciaExterna: referencia,
      } as never,
    });
    return BigInt(r.idInterno);
  }

  const job = (transacaoId: bigint) =>
    ({
      data: {
        provider: 'teste_bloq',
        payload: { transacaoId: transacaoId.toString(), idTransacaoPrivado: 'x' },
      },
    }) as never;

  const saldoDisponivel = async () => {
    const s = await prisma.saldoUsuario.findUniqueOrThrow({
      where: { usuarioId },
    });
    return money(s.saldoDisponivel.toString());
  };

  const aprovarChave = () =>
    prisma.chavePixUsuario.update({
      where: { usuarioId_chave: { usuarioId, chave: CHAVE } },
      data: { situacao: SITUACAO_CHAVE_PIX.APROVADA },
    });

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService, LedgerService, ConfigPixService],
    }).compile();

    prisma = modulo.get(PrismaService);
    await prisma.$connect();
    configPix = modulo.get(ConfigPixService);
    ledger = modulo.get(LedgerService);

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

    const usuario = await prisma.usuario.upsert({
      where: { email: 'saque-bloqueio@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '11111111130',
        nomeRazaoSocial: 'Bloqueio Test',
        email: 'saque-bloqueio@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO', contaBloqueada: false },
    });
    usuarioId = usuario.id;

    const provedor = await prisma.provedorPagamento.upsert({
      where: { codigo: 'teste_bloq' },
      create: {
        codigo: 'teste_bloq',
        nome: 'Adquirente de teste (bloqueio)',
        permitePixEntrada: true,
        permitePixSaida: true,
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
      update: { situacao: SITUACAO_PROVEDOR.ATIVO },
    });

    const conta = await prisma.contaProvedor.upsert({
      where: { chaveUnicaConta: 'teste_bloq:conta-principal' },
      create: {
        provedorPagamentoId: provedor.id,
        nome: 'Conta teste bloqueio',
        chaveUnicaConta: 'teste_bloq:conta-principal',
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
      },
      update: {
        contaProvedorPixSaidaId: conta.id,
        ticketMinimoPixSaida: '0',
        taxaPixSaidaPercentual: '0',
        taxaPixSaidaFixa: '0',
        origemSaquePermitida: 'PAINEL',
      },
    });

    await prisma.saldoUsuario.upsert({
      where: { usuarioId },
      create: { usuarioId, saldoDisponivel: '5000.00' },
      update: { saldoDisponivel: '5000.00' },
    });

    await prisma.chavePixUsuario.upsert({
      where: { usuarioId_chave: { usuarioId, chave: CHAVE } },
      create: {
        usuarioId,
        chave: CHAVE,
        tipoChave: 'EMAIL',
        situacao: SITUACAO_CHAVE_PIX.APROVADA,
        nomeTitular: 'Bloqueio Test',
        documentoTitular: '11111111130',
      },
      update: { situacao: SITUACAO_CHAVE_PIX.APROVADA },
    });
  });

  afterAll(async () => {
    // Estado limpo para as outras suítes que compartilham o banco.
    await prisma.usuario.update({
      where: { id: usuarioId },
      data: { contaBloqueada: false },
    });
    await aprovarChave();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    chamadas = 0;
    await prisma.usuario.update({
      where: { id: usuarioId },
      data: { contaBloqueada: false },
    });
    await aprovarChave();
  });

  it('chave revogada: FALHA + estorno + callback, sem chamar a liquidante', async () => {
    const transacaoId = await criarSaque(`bloq-revogada-${Date.now()}`);
    const aposDebito = await saldoDisponivel();

    await prisma.chavePixUsuario.update({
      where: { usuarioId_chave: { usuarioId, chave: CHAVE } },
      data: { situacao: SITUACAO_CHAVE_PIX.REVOGADA },
    });

    const r = (await processor().process(job(transacaoId))) as {
      ok: boolean;
      bloqueado?: boolean;
      desfecho?: string;
    };
    expect(r.bloqueado).toBe(true);
    expect(r.desfecho).toBe('estornado');
    // A liquidante NUNCA foi chamada — o bloqueio é pré-envio por definição.
    expect(chamadas).toBe(0);

    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.FALHA);

    // O dinheiro voltou: estorno do valor (tarifa 0 não gera lançamento).
    const aposEstorno = await saldoDisponivel();
    expect(aposEstorno.minus(aposDebito).toFixed(2)).toBe('50.00');

    // Lojista sabe o motivo pelo callback.
    const evento = await prisma.eventoOutbox.findFirst({
      where: {
        identificadorAgregado: tx.idTransacaoPublico,
        tipoEvento: EVENTOS_LOJISTA.PIX_CASHOUT_FALHOU,
      },
      orderBy: { id: 'desc' },
    });
    expect(evento).not.toBeNull();
    expect(JSON.stringify(evento!.conteudo)).toContain('chave PIX não aprovada');

    // Reprocessar é no-op: FALHA não é estado enviável — o loop morreu aqui.
    const r2 = (await processor().process(job(transacaoId))) as { ignorado?: boolean };
    expect(r2.ignorado).toBe(true);
    const saldoFinal = await saldoDisponivel();
    expect(saldoFinal.toFixed(2)).toBe(aposEstorno.toFixed(2));
  });

  it('conta bloqueada com ordem JÁ ENVIADA: não estorna nem rebaixa — quem decide é o webhook', async () => {
    const transacaoId = await criarSaque(`bloq-emvoo-${Date.now()}`);
    const conta = await prisma.contaProvedor.findFirstOrThrow({
      where: { chaveUnicaConta: 'teste_bloq:conta-principal' },
    });
    // Ordem já saiu numa execução anterior (tentativa SUCESSO aguardando webhook).
    await prisma.tentativaTransacao.create({
      data: {
        transacaoId,
        contaProvedorId: conta.id,
        numeroTentativa: 1,
        situacao: SITUACAO_TENTATIVA.SUCESSO,
        idTransacaoLiquidante: `liq-emvoo-${transacaoId}`,
      },
    });
    const antes = await saldoDisponivel();

    await prisma.usuario.update({
      where: { id: usuarioId },
      data: { contaBloqueada: true },
    });

    const r = (await processor().process(job(transacaoId))) as {
      bloqueado?: boolean;
      desfecho?: string;
    };
    expect(r.bloqueado).toBe(true);
    expect(r.desfecho).toBe('em-voo');
    expect(chamadas).toBe(0);

    // NADA mudou: sem estorno (o PIX pode ter sido pago) e situação preservada.
    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.PROCESSANDO);
    const depois = await saldoDisponivel();
    expect(depois.toFixed(2)).toBe(antes.toFixed(2));
    const estornos = await prisma.movimentacaoSaldo.count({
      where: { transacaoId, natureza: 'ESTORNO_SAQUE' },
    });
    expect(estornos).toBe(0);
  });

  it('desfecho já selado (CONCLUIDA): bloqueio não toca em nada', async () => {
    const transacaoId = await criarSaque(`bloq-selado-${Date.now()}`);
    await prisma.transacao.update({
      where: { id: transacaoId },
      data: { situacao: SITUACAO_TRANSACAO.CONCLUIDA },
    });
    const antes = await saldoDisponivel();

    await prisma.usuario.update({
      where: { id: usuarioId },
      data: { contaBloqueada: true },
    });

    // CONCLUIDA nem chega à revalidação: barra no "não é estado enviável".
    const r = (await processor().process(job(transacaoId))) as { ignorado?: boolean };
    expect(r.ignorado).toBe(true);

    const depois = await saldoDisponivel();
    expect(depois.toFixed(2)).toBe(antes.toFixed(2));
    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.CONCLUIDA);
  });
});
