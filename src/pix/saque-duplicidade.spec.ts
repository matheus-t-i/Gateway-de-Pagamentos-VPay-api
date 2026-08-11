import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { encryptCredentials } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { PixService } from './pix.service';
import { PixCashOutProcessor } from '../worker-processors/pix-cash-out.processor';
import {
  ErroAntesDoEnvioError,
  RecusaAdquirenteError,
} from '../providers/payment-provider.port';
import {
  SITUACAO_CHAVE_PIX,
  SITUACAO_PROVEDOR,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
} from '../shared';

/**
 * A trava contra PAGAR O SAQUE DUAS VEZES.
 *
 * A fila `4-pix-cash-out` roda com `attempts: 5`. Quando a liquidante não
 * responde (timeout, 5xx), o job era relançado e o BullMQ reagendava — e como
 * nenhuma tentativa era gravada, a checagem "já enviado?" não via nada e o
 * processor mandava um SEGUNDO PIX, com a liquidante possivelmente já tendo
 * aceitado o primeiro. Sem chave de idempotência na Valorion, são duas ordens.
 *
 * A correção é a tentativa nascer `ENVIANDO` ANTES do POST. Estes testes travam
 * os três desfechos, porque confundi-los custa dinheiro de verdade:
 *
 *  - ambíguo  → tentativa fica ENVIANDO, job NÃO retenta, reprocessar é no-op
 *  - recusa   → tentativa FALHA, transação FALHA, callback ao lojista
 *  - pré-envio→ tentativa some, retry é permitido (nada saiu)
 */
describe('PixCashOutProcessor — nunca paga duas vezes', () => {
  let prisma: PrismaService;
  let pix: PixService;
  let usuarioId: bigint;
  let sufixo: string;

  /** Trocado por teste para simular o desfecho da liquidante. */
  let comportamento: () => Promise<{ idTransacaoLiquidante: string; raw: unknown }>;
  let chamadas = 0;

  /** Serviços reais: as revalidações e o estorno precisam ser os de verdade. */
  let configPix: ConfigPixService;
  let ledger: LedgerService;

  function processorCom(): PixCashOutProcessor {
    const registry = {
      get: () => ({
        createCashOut: async () => {
          chamadas += 1;
          return comportamento();
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
        chavePix: 'duplicidade@vpay.local',
        tipoChavePix: 'EMAIL',
        nomeBeneficiario: 'Duplicidade Test',
        documentoBeneficiario: '11111111114',
        referenciaExterna: referencia,
      } as never,
    });
    return BigInt(r.idInterno);
  }

  const job = (transacaoId: bigint) =>
    ({
      data: {
        provider: 'teste_dup',
        payload: {
          transacaoId: transacaoId.toString(),
          idTransacaoPrivado: 'x',
        },
      },
    }) as never;

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

    sufixo = `${Date.now()}`;

    const usuario = await prisma.usuario.upsert({
      where: { email: 'saque-duplicidade@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '11111111114',
        nomeRazaoSocial: 'Duplicidade Test',
        email: 'saque-duplicidade@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO', contaBloqueada: false },
    });
    usuarioId = usuario.id;

    const provedor = await prisma.provedorPagamento.upsert({
      where: { codigo: 'teste_dup' },
      create: {
        codigo: 'teste_dup',
        nome: 'Adquirente de teste (duplicidade)',
        permitePixEntrada: true,
        permitePixSaida: true,
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
      update: { situacao: SITUACAO_PROVEDOR.ATIVO },
    });

    /**
     * As credenciais precisam ser AES-GCM de verdade: o processor chama
     * `decryptCredentials` antes do envio e o JSON em claro deixou de ser aceito.
     * Com `'{}'` a suíte inteira morria em "Invalid initialization vector" ANTES
     * do POST — e um teste que nunca chega ao envio não prova nada sobre pagar
     * duas vezes. O upsert também reescreve conta de execução anterior.
     */
    const conta = await prisma.contaProvedor.upsert({
      where: { chaveUnicaConta: 'teste_dup:conta-principal' },
      create: {
        provedorPagamentoId: provedor.id,
        nome: 'Conta teste duplicidade',
        chaveUnicaConta: 'teste_dup:conta-principal',
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

    // Saque pelo painel só sai para chave cadastrada E aprovada — o processor
    // reconfere isso a cada (re)processamento.
    await prisma.chavePixUsuario.upsert({
      where: {
        usuarioId_chave: { usuarioId, chave: 'duplicidade@vpay.local' },
      },
      create: {
        usuarioId,
        chave: 'duplicidade@vpay.local',
        tipoChave: 'EMAIL',
        situacao: SITUACAO_CHAVE_PIX.APROVADA,
        nomeTitular: 'Duplicidade Test',
        documentoTitular: '11111111114',
      },
      update: { situacao: SITUACAO_CHAVE_PIX.APROVADA },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    chamadas = 0;
  });

  it('resposta AMBÍGUA congela: tentativa fica ENVIANDO e o reprocessamento não reenvia', async () => {
    const transacaoId = await criarSaque(`dup-ambiguo-${sufixo}`);
    const processor = processorCom();

    // 1ª passada: a liquidante não responde.
    comportamento = () => Promise.reject(new Error('socket hang up'));
    await expect(processor.process(job(transacaoId))).rejects.toThrow();
    expect(chamadas).toBe(1);

    const tentativa = await prisma.tentativaTransacao.findFirstOrThrow({
      where: { transacaoId },
    });
    // A ordem "em voo" precisa estar registrada — é ela que trava o reenvio.
    expect(tentativa.situacao).toBe(SITUACAO_TENTATIVA.ENVIANDO);

    // 2ª passada (o retry do BullMQ, ou um reprocessamento manual).
    comportamento = () =>
      Promise.resolve({ idTransacaoLiquidante: 'NAO-DEVERIA', raw: {} });
    const r = (await processor.process(job(transacaoId))) as { ignorado?: boolean };

    expect(r.ignorado).toBe(true);
    // O ponto do teste: a liquidante NÃO foi chamada de novo.
    expect(chamadas).toBe(1);

    const tentativas = await prisma.tentativaTransacao.count({ where: { transacaoId } });
    expect(tentativas).toBe(1);
  });

  it('SUCESSO não regride estado final: webhook que ganhou a corrida mantém CONCLUIDA', async () => {
    const transacaoId = await criarSaque(`dup-noregress-${sufixo}`);

    // Simula o webhook PAID chegando enquanto o createCashOut ainda está em voo:
    // no meio do envio, a transação já foi selada CONCLUIDA por outro caminho.
    comportamento = async () => {
      await prisma.transacao.update({
        where: { id: transacaoId },
        data: {
          situacao: SITUACAO_TRANSACAO.CONCLUIDA,
          concluidoEm: new Date(),
        },
      });
      return { idTransacaoLiquidante: 'LIQ-NOREGRESS', raw: { ok: true } };
    };

    await processorCom().process(job(transacaoId));

    // O bloco de sucesso NÃO pode ter rebaixado CONCLUIDA -> PROCESSANDO.
    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.CONCLUIDA);

    // Mas a tentativa ainda registra o SUCESSO + a resposta do banco (rastro).
    const tent = await prisma.tentativaTransacao.findFirstOrThrow({
      where: { transacaoId },
    });
    expect(tent.situacao).toBe(SITUACAO_TENTATIVA.SUCESSO);
    expect(tent.idTransacaoLiquidante).toBe('LIQ-NOREGRESS');
  });

  it('RECUSA encerra em FALHA, DEVOLVE o saldo e emite o callback ao lojista', async () => {
    const saldoAntes = await prisma.saldoUsuario.findUniqueOrThrow({
      where: { usuarioId },
    });
    const transacaoId = await criarSaque(`dup-recusa-${sufixo}`);

    // O saque já debitou: o disponível caiu.
    const saldoDebitado = await prisma.saldoUsuario.findUniqueOrThrow({
      where: { usuarioId },
    });
    expect(Number(saldoDebitado.saldoDisponivel)).toBeLessThan(
      Number(saldoAntes.saldoDisponivel),
    );

    const processor = processorCom();
    comportamento = () =>
      Promise.reject(
        new RecusaAdquirenteError('Valorion HTTP 400: chave inexistente', {
          statusHttp: 400,
        }),
      );

    const r = (await processor.process(job(transacaoId))) as { recusado?: boolean };
    expect(r.recusado).toBe(true);

    // A liquidante recusou: o dinheiro nunca saiu, então volta inteiro para o
    // lojista poder tentar de novo.
    const saldoDepois = await prisma.saldoUsuario.findUniqueOrThrow({
      where: { usuarioId },
    });
    expect(Number(saldoDepois.saldoDisponivel)).toBe(
      Number(saldoAntes.saldoDisponivel),
    );

    const estornos = await prisma.movimentacaoSaldo.findMany({
      where: { transacaoId, natureza: 'ESTORNO_SAQUE' },
    });
    expect(estornos.length).toBeGreaterThan(0);
    expect(estornos.every((e) => e.tipoMovimento === 'CREDITO')).toBe(true);

    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.FALHA);

    const tentativa = await prisma.tentativaTransacao.findFirstOrThrow({
      where: { transacaoId },
    });
    expect(tentativa.situacao).toBe(SITUACAO_TENTATIVA.FALHA);

    // O lojista precisa ser avisado — antes disso o saque morria em silêncio.
    const evento = await prisma.eventoOutbox.findFirst({
      where: {
        identificadorAgregado: tx.idTransacaoPublico,
        tipoEvento: 'pix.cashout.falhou',
      },
    });
    expect(evento).not.toBeNull();

    const historico = await prisma.historicoSituacaoTransacao.findFirst({
      where: { transacaoId, novaSituacao: SITUACAO_TRANSACAO.FALHA },
    });
    expect((historico?.metadados as { saldoDevolvido?: boolean })?.saldoDevolvido).toBe(
      true,
    );
  });

  it('recusa: estorno vem PRIMEIRO — falha na marcação nunca deixa FALHA sem devolução', async () => {
    const transacaoId = await criarSaque(`dup-estorno-ordem-${sufixo}`);

    // Estorno é a PRIMEIRA coisa a commitar (transação própria). Se o crédito
    // de volta falhar, registrarRecusa lança ANTES de marcar FALHA: a tx nunca
    // fica FALHA sem o estorno correspondente.
    const ledgerQuebrado = {
      aplicarMovimentacoes: () => Promise.reject(new Error('deadlock no estorno')),
    };
    const registry = {
      get: () => ({
        createCashOut: () =>
          Promise.reject(new RecusaAdquirenteError('Valorion HTTP 400: recusado')),
      }),
    };
    const processor = new PixCashOutProcessor(
      prisma,
      registry as never,
      configPix,
      ledgerQuebrado as never,
      {
        assertSaquePermitido: async () => undefined,
        registrarRecusaSaque: async () => undefined,
      } as never,
    );

    await expect(processor.process(job(transacaoId))).rejects.toThrow();

    // O estorno falhou -> a tx NÃO foi marcada FALHA (a marcação vem DEPOIS do
    // estorno). O invariante que importa: nunca existe FALHA sem devolução —
    // o dinheiro jamais fica preso numa transação FALHA sem crédito de volta.
    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.PROCESSANDO);
    const historicoFalha = await prisma.historicoSituacaoTransacao.findFirst({
      where: { transacaoId, novaSituacao: SITUACAO_TRANSACAO.FALHA },
    });
    expect(historicoFalha).toBeNull();
    const estorno = await prisma.movimentacaoSaldo.findUnique({
      where: { chaveIdempotencia: `saque:estorno:${transacaoId}` },
    });
    expect(estorno).toBeNull();

    // A tx fica em PROCESSANDO com a tentativa ENVIANDO (ordem cuja resposta
    // ficou desconhecida): estado AMBÍGUO por definição — pode ter saído ou
    // não. Por isso NÃO há auto-estorno (a conciliação só sinaliza "conferir
    // manualmente" para SAIDA sem idTransacaoLiquidante). O caso feliz (estorno
    // OK -> FALHA + callback) está no teste de recusa acima.
    const tentativa = await prisma.tentativaTransacao.findFirstOrThrow({
      where: { transacaoId },
    });
    expect(tentativa.situacao).toBe(SITUACAO_TENTATIVA.ENVIANDO);
  });

  it('recusa TARDIA não rebaixa CONCLUIDA nem estorna PIX pago', async () => {
    const transacaoId = await criarSaque(`dup-recusa-tardia-${sufixo}`);
    const saldoDebitado = await prisma.saldoUsuario.findUniqueOrThrow({
      where: { usuarioId },
    });

    // Webhook PAID contraditório sela CONCLUIDA enquanto o POST está em voo;
    // em seguida o POST volta 4xx. Sem a guarda, a recusa estornava o saldo E
    // rebaixava CONCLUIDA -> FALHA: o beneficiário ficava com o PIX e o
    // lojista com o dinheiro de volta — perda dupla da VPay.
    comportamento = async () => {
      await prisma.transacao.update({
        where: { id: transacaoId },
        data: { situacao: SITUACAO_TRANSACAO.CONCLUIDA, concluidoEm: new Date() },
      });
      throw new RecusaAdquirenteError('Valorion HTTP 400: contraditório', {
        statusHttp: 400,
      });
    };

    const r = (await processorCom().process(job(transacaoId))) as {
      recusado?: boolean;
    };
    expect(r.recusado).toBe(true);

    // Nada foi estornado e o estado final não regrediu.
    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.CONCLUIDA);
    const estorno = await prisma.movimentacaoSaldo.findUnique({
      where: { chaveIdempotencia: `saque:estorno:${transacaoId}` },
    });
    expect(estorno).toBeNull();
    const saldoDepois = await prisma.saldoUsuario.findUniqueOrThrow({
      where: { usuarioId },
    });
    expect(Number(saldoDepois.saldoDisponivel)).toBe(
      Number(saldoDebitado.saldoDisponivel),
    );

    // E o lojista NÃO recebe callback de falha de um saque pago.
    const evento = await prisma.eventoOutbox.findFirst({
      where: {
        identificadorAgregado: tx.idTransacaoPublico,
        tipoEvento: 'pix.cashout.falhou',
      },
    });
    expect(evento).toBeNull();
  });

  it('estorno é idempotente: reprocessar não credita duas vezes', async () => {
    const transacaoId = await criarSaque(`dup-estorno-idem-${sufixo}`);
    const processor = processorCom();
    comportamento = () =>
      Promise.reject(new RecusaAdquirenteError('Valorion HTTP 400: recusado'));

    await processor.process(job(transacaoId));
    const saldoUmaVez = await prisma.saldoUsuario.findUniqueOrThrow({
      where: { usuarioId },
    });

    // Chama o estorno de novo pelo mesmo caminho (como faria o webhook de
    // falha chegando depois da recusa síncrona).
    await (
      processor as unknown as {
        estornarSaque: (tx: unknown, m: string) => Promise<void>;
      }
    ).estornarSaque(
      await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } }),
      'segunda chamada',
    );

    const saldoDuasVezes = await prisma.saldoUsuario.findUniqueOrThrow({
      where: { usuarioId },
    });
    expect(Number(saldoDuasVezes.saldoDisponivel)).toBe(
      Number(saldoUmaVez.saldoDisponivel),
    );
  });

  it('falha ANTES do envio não deixa rastro: o retry continua permitido', async () => {
    const transacaoId = await criarSaque(`dup-preenvio-${sufixo}`);
    const processor = processorCom();

    comportamento = () =>
      Promise.reject(new ErroAntesDoEnvioError('falha ao autenticar (401)'));

    await expect(processor.process(job(transacaoId))).rejects.toThrow(
      ErroAntesDoEnvioError,
    );

    // Nada saiu, então nenhuma tentativa pode ficar bloqueando o reenvio —
    // senão um erro de credencial NOSSO prenderia o saque para sempre.
    const tentativas = await prisma.tentativaTransacao.count({ where: { transacaoId } });
    expect(tentativas).toBe(0);

    const tx = await prisma.transacao.findUniqueOrThrow({ where: { id: transacaoId } });
    expect(tx.situacao).toBe(SITUACAO_TRANSACAO.PROCESSANDO);

    // E o reprocessamento realmente tenta de novo.
    comportamento = () =>
      Promise.resolve({ idTransacaoLiquidante: 'LIQ-OK', raw: { ok: true } });
    await processor.process(job(transacaoId));
    expect(chamadas).toBe(2);

    const tentativa = await prisma.tentativaTransacao.findFirstOrThrow({
      where: { transacaoId },
    });
    expect(tentativa.situacao).toBe(SITUACAO_TENTATIVA.SUCESSO);
    expect(tentativa.idTransacaoLiquidante).toBe('LIQ-OK');
  });
});
