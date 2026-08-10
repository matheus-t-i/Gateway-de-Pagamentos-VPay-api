import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { Prisma } from '@prisma/client';
import {
  ESCOPOS_API,
  PixJobPayload,
  QUEUE_NAMES,
  SITUACAO_CHAVE_PIX,
  SITUACAO_PROVEDOR,
  EVENTOS_LOJISTA,
  SITUACAO_TENTATIVA,
  SITUACAO_TRANSACAO,
  SITUACAO_USUARIO,
  money,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  ErroAntesDoEnvioError,
  RecusaAdquirenteError,
} from '../providers/payment-provider.port';
import { ProviderRegistry } from '../providers/provider.registry';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { decryptCredentials } from '../common/crypto.util';
import { SaqueProtecaoService } from '../pix/saque-protecao.service';

/**
 * Erro de regra de negócio na revalidação: o saque NÃO pode ser enviado.
 * Sobe como falha do job para ficar visível no Bull Board e ser analisado —
 * nunca "conserta" sozinho mexendo em saldo.
 */
class SaqueBloqueadoError extends Error {}

/** Claim ENVIANDO perdeu para tentativa já existente (mesmo processo ou outro). */
class SaqueJaEnviadoError extends Error {
  constructor(
    message: string,
    readonly idTransacaoLiquidante: string | null,
    readonly emVoo: boolean,
  ) {
    super(message);
  }
}

/**
 * Envia o saque à liquidante.
 *
 * `concurrency: 1` — um saque por vez. Dois jobs do mesmo lojista processando
 * em paralelo poderiam passar juntos pelas checagens de saldo e pagar duas
 * vezes; serializando, cada um revalida já enxergando o efeito do anterior.
 *
 * O job NUNCA confia no que foi validado na criação. Ele pode ser reprocessado
 * manualmente (retry no Bull Board / Redis) horas depois, quando a chave PIX já
 * foi reprovada, a conta foi bloqueada ou o saldo mudou — então TODAS as regras
 * são conferidas de novo aqui, imediatamente antes de mover dinheiro.
 */
@Processor(QUEUE_NAMES.PIX_CASH_OUT, { concurrency: 1 })
@Injectable()
export class PixCashOutProcessor extends WorkerHost {
  private readonly logger = new Logger(PixCashOutProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
    private readonly configPix: ConfigPixService,
    private readonly ledger: LedgerService,
    private readonly saqueProtecao: SaqueProtecaoService,
  ) {
    super();
  }

  async process(job: Job<PixJobPayload>) {
    const body = job.data.payload as {
      transacaoId: string;
      idTransacaoPrivado: string;
    };
    this.logger.log(`processando saque tx=${body.transacaoId}`);

    const tx = await this.prisma.transacao.findUniqueOrThrow({
      where: { id: BigInt(body.transacaoId) },
      include: {
        pix: true,
        contaProvedor: { include: { provedor: true } },
        usuario: { select: { situacao: true, contaBloqueada: true } },
        credencialApi: {
          select: { ativo: true, revogadoEm: true, expiraEm: true, escopos: true },
        },
      },
    });

    // ── 1–2. Estado + claim atômico ENVIANDO ──────────────────────────────
    // Check-then-create fora de lock era o buraco multi-worker: dois processos
    // viam `jaEnviado = null`, criavam ENVIANDO (numero 1 e 2) e mandavam DOIS
    // PIX com um débito. FOR UPDATE na transação + unique parcial
    // `tentativas_transacao_ativa_key` fecham a corrida.
    const enviaveis: string[] = [
      SITUACAO_TRANSACAO.PENDENTE,
      SITUACAO_TRANSACAO.PROCESSANDO,
    ];
    if (!enviaveis.includes(tx.situacao)) {
      this.logger.warn(
        `saque tx=${tx.id} em ${tx.situacao} — não é estado enviável, ignorado`,
      );
      return { ok: true, ignorado: true, motivo: `situação ${tx.situacao}` };
    }
    if (tx.direcao !== 'SAIDA') {
      throw new SaqueBloqueadoError(`tx=${tx.id} não é um saque (${tx.direcao})`);
    }

    // ── 3. Conta do lojista ───────────────────────────────────────────────
    if (tx.usuario.situacao !== SITUACAO_USUARIO.ATIVO || tx.usuario.contaBloqueada) {
      throw new SaqueBloqueadoError(
        `conta do lojista indisponível (situação ${tx.usuario.situacao}` +
          `${tx.usuario.contaBloqueada ? ', bloqueada' : ''}) — saque não enviado`,
      );
    }

    // ── 4. Provedor/conta ─────────────────────────────────────────────────
    if (
      !tx.contaProvedor ||
      tx.contaProvedor.situacao !== SITUACAO_PROVEDOR.ATIVO ||
      tx.contaProvedor.provedor.situacao !== SITUACAO_PROVEDOR.ATIVO
    ) {
      throw new SaqueBloqueadoError('provedor/conta inativo — saque não enviado');
    }

    // ── 5. O dinheiro saiu mesmo do saldo? ────────────────────────────────
    // O débito acontece na criação do saque (é o que PROCESSANDO significa).
    // Sem as movimentações, enviar seria pagar sem ter cobrado.
    const debitos = await this.prisma.movimentacaoSaldo.aggregate({
      where: { transacaoId: tx.id, tipoMovimento: 'DEBITO' },
      _sum: { valor: true },
    });
    const debitado = money(debitos._sum.valor?.toString() ?? '0');
    const esperado = money(tx.valorBruto.toString()).plus(
      money(tx.valorTarifaPix.toString()),
    );
    if (debitado.lt(esperado)) {
      throw new SaqueBloqueadoError(
        `saldo não debitado integralmente (debitado ${debitado.toFixed(2)} de ` +
          `${esperado.toFixed(2)}) — saque não enviado`,
      );
    }

    // ── 6. Limites e permissão de saque ───────────────────────────────────
    const cfg = await this.configPix.resolverEfetiva(tx.usuarioId);
    const valor = money(tx.valorBruto.toString());
    if (valor.lt(cfg.ticketMinimoPixSaida)) {
      throw new SaqueBloqueadoError('valor abaixo do mínimo vigente');
    }
    if (cfg.ticketMaximoPixSaida && valor.gt(cfg.ticketMaximoPixSaida)) {
      throw new SaqueBloqueadoError('valor acima do máximo vigente');
    }
    try {
      await this.saqueProtecao.assertSaquePermitido({
        usuarioId: tx.usuarioId,
        valor,
        cfg,
        soLeitura: true,
      });
    } catch (e) {
      throw new SaqueBloqueadoError(
        e instanceof Error ? e.message : 'saque bloqueado por proteção',
      );
    }

    // ── 7. Origem: API ou painel ──────────────────────────────────────────
    // A origem permitida é reconferida AGORA: o admin pode ter desligado o
    // saque via API (ou via painel) depois que o job entrou na fila.
    const viaApi = !!tx.credencialApiId;
    const origemLiberada =
      cfg.origemSaquePermitida === 'AMBOS' ||
      (viaApi ? cfg.origemSaquePermitida === 'API' : cfg.origemSaquePermitida === 'PAINEL');
    if (!origemLiberada) {
      throw new SaqueBloqueadoError(
        `saque por ${viaApi ? 'API' : 'painel'} desabilitado na conta — não enviado`,
      );
    }

    if (tx.credencialApiId) {
      // Saque pedido pela API: a credencial precisa continuar valendo.
      const cred = tx.credencialApi;
      const expirada = cred?.expiraEm ? cred.expiraEm.getTime() < Date.now() : false;
      if (!cred || !cred.ativo || cred.revogadoEm || expirada) {
        throw new SaqueBloqueadoError(
          'credencial de API revogada/expirada — saque não enviado',
        );
      }
      const escopos = (cred.escopos as string[] | null) ?? [];
      if (!escopos.includes(ESCOPOS_API.PIX_SAQUE_CRIAR)) {
        throw new SaqueBloqueadoError(
          'credencial sem escopo pix.saque.criar — saque não enviado',
        );
      }
      // Chave cadastrada também vale para a API quando a conta exige — mesma
      // regra da criação, reconferida aqui porque a aprovação pode ter caído.
      if (cfg.exigirChavePixCadastrada) {
        const chave = tx.pix?.chavePix;
        const cadastrada = chave
          ? await this.prisma.chavePixUsuario.findFirst({
              where: { usuarioId: tx.usuarioId, chave },
              select: { situacao: true },
            })
          : null;
        if (cadastrada?.situacao !== SITUACAO_CHAVE_PIX.APROVADA) {
          throw new SaqueBloqueadoError(
            'conta exige chave PIX cadastrada e aprovada — saque não enviado',
          );
        }
      }
    } else {
      // Saque pedido pelo painel: só sai para chave cadastrada E aprovada pelo
      // administrador, conferida agora — a aprovação pode ter sido revogada
      // entre a criação e o (re)processamento.
      const chave = tx.pix?.chavePix;
      if (!chave) {
        throw new SaqueBloqueadoError('saque sem chave PIX — não enviado');
      }
      const cadastrada = await this.prisma.chavePixUsuario.findFirst({
        where: { usuarioId: tx.usuarioId, chave },
        select: { situacao: true },
      });
      if (!cadastrada) {
        throw new SaqueBloqueadoError(
          'chave PIX não cadastrada nesta conta — saque não enviado',
        );
      }
      if (cadastrada.situacao !== SITUACAO_CHAVE_PIX.APROVADA) {
        throw new SaqueBloqueadoError(
          `chave PIX não aprovada (situação ${cadastrada.situacao}) — saque não enviado`,
        );
      }
    }

    // ── Envio ─────────────────────────────────────────────────────────────
    const provider = this.providers.get(tx.contaProvedor.provedor.codigo);
    const credenciais = decryptCredentials(
      tx.contaProvedor.credenciaisCriptografadas,
    );

    /**
     * Claim atômico: FOR UPDATE na transação + insert ENVIANDO.
     * Qualquer tentativa ≠ FALHA (inclusive ENVIANDO) barra o reenvio — é a
     * ordem em voo cuja resposta nunca chegou. Sem o lock, dois workers
     * criavam duas ENVIANDO e pagavam duas vezes.
     */
    let tentativaId: bigint;
    try {
      tentativaId = await this.prisma.$transaction(async (db) => {
        await db.$queryRaw`
          SELECT id FROM transacoes WHERE id = ${tx.id} FOR UPDATE
        `;
        const jaEnviado = await db.tentativaTransacao.findFirst({
          where: {
            transacaoId: tx.id,
            situacao: { not: SITUACAO_TENTATIVA.FALHA },
          },
          select: { id: true, idTransacaoLiquidante: true, situacao: true },
        });
        if (jaEnviado) {
          const emVoo = jaEnviado.situacao === SITUACAO_TENTATIVA.ENVIANDO;
          throw new SaqueJaEnviadoError(
            emVoo
              ? 'ordem em voo (resposta desconhecida) — conferir antes de reenviar'
              : 'saque já enviado à liquidante',
            jaEnviado.idTransacaoLiquidante,
            emVoo,
          );
        }
        const anteriores = await db.tentativaTransacao.count({
          where: { transacaoId: tx.id },
        });
        const criada = await db.tentativaTransacao.create({
          data: {
            transacaoId: tx.id,
            contaProvedorId: tx.contaProvedorId!,
            numeroTentativa: anteriores + 1,
            situacao: SITUACAO_TENTATIVA.ENVIANDO,
          },
          select: { id: true },
        });
        return criada.id;
      });
    } catch (e) {
      if (e instanceof SaqueJaEnviadoError) {
        this.logger.warn(
          e.emVoo
            ? `saque tx=${tx.id} tem ordem EM VOO sem desfecho conhecido — ` +
                'reprocessamento ignorado; confira na liquidante antes de reenviar'
            : `saque tx=${tx.id} já enviado à liquidante ` +
                `(${e.idTransacaoLiquidante}) — reprocessamento ignorado`,
        );
        return {
          ok: true,
          ignorado: true,
          motivo: e.message,
          idTransacaoLiquidante: e.idTransacaoLiquidante,
        };
      }
      // Unique parcial: outro worker ganhou a corrida entre o check e o insert.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        this.logger.warn(
          `saque tx=${tx.id} claim ENVIANDO perdido para outro worker — ignorado`,
        );
        return {
          ok: true,
          ignorado: true,
          motivo: 'claim ENVIANDO perdido para outro worker',
        };
      }
      throw e;
    }

    let result: Awaited<ReturnType<typeof provider.createCashOut>>;
    try {
      result = await provider.createCashOut({
        valor,
        idTransacaoPrivado: tx.idTransacaoPrivado,
        chavePix: tx.pix?.chavePix ?? '',
        tipoChavePix: tx.pix?.tipoChavePix ?? 'ALEATORIA',
        nomeBeneficiario: tx.pix?.nomeBeneficiario ?? undefined,
        documentoBeneficiario: tx.pix?.documentoBeneficiario ?? undefined,
        credenciais,
      });
    } catch (erro) {
      /**
       * Três desfechos, três tratamentos — e confundi-los custa dinheiro.
       *
       * 1. ANTES DO ENVIO (auth, credencial, payload): nada saiu. Apaga a
       *    tentativa e relança — o retry do BullMQ é seguro e necessário,
       *    senão um erro de configuração nosso prenderia todos os saques.
       * 2. RECUSA explícita (4xx da criação): a liquidante disse não, nada foi
       *    pago. Encerra em FALHA e avisa o lojista.
       * 3. AMBÍGUO (timeout, 5xx, rede depois do POST): não se sabe se o
       *    dinheiro saiu. A tentativa FICA em `ENVIANDO` — é o que impede o
       *    reenvio — e o job para de vez, para reconciliação humana.
       */
      if (erro instanceof ErroAntesDoEnvioError) {
        await this.prisma.tentativaTransacao.delete({ where: { id: tentativaId } });
        this.logger.warn(
          `saque tx=${tx.id} não chegou a ser enviado: ${erro.message.slice(0, 300)}`,
        );
        throw erro;
      }

      if (erro instanceof RecusaAdquirenteError) {
        this.logger.warn(
          `saque tx=${tx.id} RECUSADO pela liquidante: ${erro.message.slice(0, 300)}`,
        );
        await this.registrarRecusa(tx, tentativaId, erro);
        return { ok: false, recusado: true, motivo: erro.message };
      }

      const detalhe = erro instanceof Error ? erro.message : String(erro);
      await this.prisma.tentativaTransacao.update({
        where: { id: tentativaId },
        data: { mensagemErro: `AMBÍGUO — não reenviar sem conferir: ${detalhe}`.slice(0, 2000) },
      });
      this.logger.error(
        `saque tx=${tx.id} com desfecho AMBÍGUO — congelado para conciliação: ${detalhe.slice(0, 300)}`,
      );
      /**
       * `UnrecoverableError` em vez de `throw erro`: a fila roda com
       * `attempts: 5`, então relançar o erro cru REAGENDA o job — o oposto de
       * congelar. Com ela o job falha de uma vez, fica visível no Bull Board e
       * ninguém reenvia PIX por conta própria.
       */
      throw new UnrecoverableError(
        `Saque tx=${tx.id} com resposta ambígua da liquidante — conferir antes de qualquer reenvio: ${detalhe.slice(0, 300)}`,
      );
    }

    // Persiste o id liquidante o mais cedo possível (antes de qualquer outra
    // coisa): se o worker morrer depois, o webhook ainda casa a tentativa.
    //
    // A tentativa registra SUCESSO + `dadosResposta` (a resposta do banco ao
    // gerar o saque) SEMPRE — é o rastro do que a liquidante devolveu.
    //
    // A situação da TRANSAÇÃO, porém, só pode ir para PROCESSANDO se ela ainda
    // NÃO for terminal: `updateMany` com guarda `situacao in [PROCESSANDO,
    // PENDENTE]`. Sem a guarda, um webhook PAID que chegue enquanto o
    // `createCashOut` ainda está em voo marcaria CONCLUIDA e este bloco a
    // RE-baixaria para PROCESSANDO — estado final regredindo. `count === 0`
    // aqui significa "o desfecho já foi selado por outro caminho": mantém.
    await this.prisma.$transaction([
      this.prisma.tentativaTransacao.update({
        where: { id: tentativaId },
        data: {
          situacao: SITUACAO_TENTATIVA.SUCESSO,
          idTransacaoLiquidante: result.idTransacaoLiquidante,
          dadosResposta: result.raw as object,
          concluidoEm: new Date(),
        },
      }),
      this.prisma.transacao.updateMany({
        where: {
          id: tx.id,
          situacao: {
            in: [SITUACAO_TRANSACAO.PROCESSANDO, SITUACAO_TRANSACAO.PENDENTE],
          },
        },
        data: { situacao: SITUACAO_TRANSACAO.PROCESSANDO },
      }),
    ]);

    return { ok: true, idTransacaoLiquidante: result.idTransacaoLiquidante };
  }

  /**
   * Fecha um saque recusado: tentativa FALHA, transação FALHA e callback ao
   * lojista — tudo na mesma transação, para não existir "FALHA sem evento".
   *
   * **O saldo NÃO volta aqui.** O débito acontece na criação do saque e devolvê-lo
   * é decisão humana: é dinheiro, e a regra do projeto é que nenhum automatismo
   * mexe nele. O lojista é avisado pelo callback e o estorno sai pelo suporte —
   * mas agora ele SABE que precisa acionar, em vez de ficar olhando um saque
   * parado em PROCESSANDO para sempre.
   */
  /**
   * Devolve valor + tarifa de um saque que NÃO foi executado.
   *
   * Só é chamado em recusa CONFIRMADA: a liquidante disse não, então o dinheiro
   * nunca saiu e segurar o saldo do lojista seria reter dinheiro que é dele. Em
   * desfecho AMBÍGUO isto nunca roda — lá o valor pode ter saído, e estornar
   * criaria um rombo.
   *
   * Idempotente pela chave por transação: rodar duas vezes (retry, ou o webhook
   * chegando depois da recusa síncrona) credita uma vez só.
   */
  /**
   * Devolve valor + tarifa ao lojista, em transação PRÓPRIA e como primeiro
   * commit da recusa. Idempotente pelas chaves por transação
   * (`saque:estorno:<txId>` / `saque:estorno-tarifa:<txId>`): rodar de novo
   * (retry, ou o webhook/conciliação chegando depois da recusa síncrona)
   * credita uma vez só.
   */
  private async estornarSaque(
    tx: { id: bigint; usuarioId: bigint; valorBruto: unknown; valorTarifaPix: unknown },
    motivo: string,
  ) {
    const valor = money(String(tx.valorBruto));
    const tarifa = money(String(tx.valorTarifaPix));

    const entries = [
      {
        tipoSaldo: 'DISPONIVEL' as const,
        tipoMovimento: 'CREDITO' as const,
        natureza: 'ESTORNO_SAQUE' as const,
        valor,
        chaveIdempotencia: `saque:estorno:${tx.id}`,
        transacaoId: tx.id,
        descricao: `Estorno de saque recusado — ${motivo}`.slice(0, 500),
      },
    ];
    // Tarifa zero não vira lançamento: poluiria o extrato com R$ 0,00.
    if (tarifa.gt(0)) {
      entries.push({
        tipoSaldo: 'DISPONIVEL' as const,
        tipoMovimento: 'CREDITO' as const,
        natureza: 'ESTORNO_SAQUE' as const,
        valor: tarifa,
        chaveIdempotencia: `saque:estorno-tarifa:${tx.id}`,
        transacaoId: tx.id,
        descricao: 'Estorno da tarifa de saque recusado',
      });
    }

    await this.ledger.aplicarMovimentacoes({ usuarioId: tx.usuarioId, entries });
    this.logger.log(
      `saque tx=${tx.id} estornado: ${valor.toFixed(2)} + tarifa ${tarifa.toFixed(2)}`,
    );
  }

  private async registrarRecusa(
    tx: { id: bigint; usuarioId: bigint; idTransacaoPublico: string; situacao: string;
          contaProvedorId: bigint | null; valorBruto: unknown; valorTarifaPix: unknown },
    tentativaId: bigint,
    erro: RecusaAdquirenteError,
  ) {
    /**
     * Estorno ANTES da mudança de situação, de propósito — e este caminho NÃO
     * pode ser atômico como o do webhook/conciliação.
     *
     * A recusa é 4xx SÍNCRONO: o PIX não saiu e NÃO existe
     * `idTransacaoLiquidante`. Isso importa porque a conciliação só recupera
     * saque preso quando há id da liquidante para consultar
     * (`outbox-and-ops.processors.ts`, ramo `if (!liquidanteId)` — para SAIDA
     * sem id ela só LOGA "conferir manualmente"). Ou seja: aqui NÃO há rede de
     * recuperação automática, então o estorno tem que ser a primeira coisa a
     * commitar — o dinheiro do lojista volta no ato.
     *
     * Se o processo morrer DEPOIS do estorno e antes da marcação, o saldo já
     * voltou (crédito com chave idempotente) e sobra só a tx em `PROCESSANDO`
     * sem callback — inconsistência de STATUS, com o dinheiro a salvo. Fazer
     * isto atômico jogaria o estorno para dentro do mesmo commit da marcação:
     * um blip no commit reverteria a DEVOLUÇÃO junto, e sem conciliação para
     * refazer o dinheiro ficaria retido. Por isso: estorno primeiro, sempre.
     *
     * (No webhook e na conciliação é o oposto — lá o saque FOI enviado, tem id
     * da liquidante, então a conciliação recupera e o commit atômico é seguro.)
     */
    await this.estornarSaque(tx, erro.message.slice(0, 200));

    await this.prisma.$transaction([
      // Fecha a tentativa em FALHA: a ordem foi recusada, então ela NÃO conta
      // como "em voo" e não trava um reenvio futuro legítimo.
      this.prisma.tentativaTransacao.update({
        where: { id: tentativaId },
        data: {
          situacao: SITUACAO_TENTATIVA.FALHA,
          statusHttp: erro.detalhe.statusHttp,
          mensagemErro: erro.message.slice(0, 2000),
          dadosResposta: (erro.detalhe.dadosResposta ?? undefined) as never,
          concluidoEm: new Date(),
        },
      }),
      this.prisma.transacao.update({
        where: { id: tx.id },
        data: { situacao: SITUACAO_TRANSACAO.FALHA, falhouEm: new Date() },
      }),
      this.prisma.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: tx.situacao,
          novaSituacao: SITUACAO_TRANSACAO.FALHA,
          origem: 'WORKER',
          motivo: `Saque recusado pela liquidante: ${erro.message.slice(0, 400)}`,
          metadados: { saldoDevolvido: true, estorno: 'automatico' },
        },
      }),
      this.prisma.eventoOutbox.create({
        data: {
          usuarioId: tx.usuarioId,
          tipoAgregado: 'TRANSACAO',
          identificadorAgregado: tx.idTransacaoPublico,
          tipoEvento: EVENTOS_LOJISTA.PIX_CASHOUT_FALHOU,
          conteudo: {
            idTransacao: tx.idTransacaoPublico,
            situacao: SITUACAO_TRANSACAO.FALHA,
            motivo: erro.message.slice(0, 400),
          },
        },
      }),
    ]);
  }
}
