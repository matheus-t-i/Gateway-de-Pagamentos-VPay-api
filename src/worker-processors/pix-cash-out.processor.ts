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
  chavePixParaLiquidante,
  chavePixValida,
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
 *
 * O desfecho é `encerrarPorBloqueio`: FALHA + estorno automático — nada saiu
 * para a liquidante (o bloqueio dispara ANTES do claim ENVIANDO), então segurar
 * o saldo seria reter dinheiro do lojista, com a transação presa em
 * `PROCESSANDO` e o recovery de órfãos reenfileirando o mesmo bloqueio a cada
 * tick, para sempre. Era exatamente esse o loop: dinheiro debitado, motivo
 * invisível ao lojista e `ALERTA_FILA` da mesma tx se acumulando.
 */
class SaqueBloqueadoError extends Error {}

/** Forma da transação carregada pelo processor (include do `process`). */
type TxSaque = Prisma.TransacaoGetPayload<{
  include: {
    pix: true;
    contaProvedor: { include: { provedor: true } };
    usuario: { select: { situacao: true; contaBloqueada: true } };
    credencialApi: {
      select: {
        ativo: true;
        revogadoEm: true;
        expiraEm: true;
        escopos: true;
        _count: { select: { ipsPermitidos: true } };
      };
    };
  };
}>;

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
          select: {
            ativo: true,
            revogadoEm: true,
            expiraEm: true,
            escopos: true,
            _count: { select: { ipsPermitidos: true } },
          },
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
      // NÃO é SaqueBloqueadoError de propósito: marcar FALHA/estornar uma tx
      // que nem é saque seria corromper um cash-in. Job morre e fica visível.
      throw new Error(`tx=${tx.id} não é um saque (${tx.direcao})`);
    }

    // ── 3–7. Revalidação total ────────────────────────────────────────────
    // Bloqueio aqui = regra violada com NADA enviado. O encerramento devolve o
    // saldo e sela FALHA — ver `encerrarPorBloqueio` para o porquê de cada guarda.
    let valor: ReturnType<typeof money>;
    try {
      valor = await this.revalidar(tx);
    } catch (e) {
      if (e instanceof SaqueBloqueadoError) {
        const desfecho = await this.encerrarPorBloqueio(tx, e.message);
        return { ok: false, bloqueado: true, desfecho, motivo: e.message };
      }
      throw e;
    }
    return this.enviar(tx, valor, job);
  }

  /**
   * Passos 3–7: tudo que a criação validou é conferido DE NOVO, imediatamente
   * antes de mover dinheiro. Regra violada → `SaqueBloqueadoError` (o chamador
   * encerra com estorno). Devolve o `valor` conferido para o envio.
   */
  private async revalidar(
    tx: TxSaque,
  ): Promise<ReturnType<typeof money>> {
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
        // Este saque JÁ existe como SAIDA de hoje: sem excluí-lo da conta,
        // ele estoura o próprio limite (valor contado duas vezes) e congela
        // com o saldo debitado.
        ignorarTransacaoId: tx.id,
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
      // Saque via API exige IP allowlist na credencial (criação e revalidação).
      if ((cred._count?.ipsPermitidos ?? 0) < 1) {
        throw new SaqueBloqueadoError(
          'credencial sem IP allowlist — saque via API não enviado',
        );
      }
    }

    // Chave de destino — mesma regra da criação:
    // painel sempre APROVADA; API só quando exigirChavePixCadastrada.
    // Reconferida aqui porque a aprovação pode ter sido revogada entre a
    // criação e o envio (e o admin pode ter religado a exigência).
    const chave = tx.pix?.chavePix;
    if (!chave) {
      throw new SaqueBloqueadoError('saque sem chave PIX — não enviado');
    }
    // Formato do valor GRAVADO (telefone sem +55). O E.164 entra só no payload
    // da liquidante, em `chavePixParaLiquidante`.
    const tipoChave = tx.pix?.tipoChavePix;
    if (tipoChave && !chavePixValida(tipoChave, chave)) {
      throw new SaqueBloqueadoError(
        `chave PIX incompatível com o tipo ${tipoChave} — saque não enviado`,
      );
    }
    const exigeChaveCadastrada = !viaApi || cfg.exigirChavePixCadastrada;
    if (exigeChaveCadastrada) {
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

    return valor;
  }

  /** Claim ENVIANDO + POST na liquidante + os três desfechos do envio. */
  private async enviar(
    tx: TxSaque,
    valor: ReturnType<typeof money>,
    job: Job<PixJobPayload>,
  ) {
    // ── Envio ─────────────────────────────────────────────────────────────
    const provider = this.providers.get(tx.contaProvedor!.provedor.codigo);
    const credenciais = decryptCredentials(
      tx.contaProvedor!.credenciaisCriptografadas,
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
        chavePix: chavePixParaLiquidante(
          tx.pix?.tipoChavePix ?? 'ALEATORIA',
          tx.pix?.chavePix ?? '',
        ),
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
        // Retry enquanto a fila ainda tem tentativas — um 401 de API key
        // rotacionada se resolve no minuto seguinte. Esgotou → nada saiu e
        // não vai sair: FALHA + estorno, senão o saldo fica em PROCESSANDO
        // e a conciliação reenfileira o mesmo erro para sempre.
        const max = job.opts?.attempts;
        const ultima =
          typeof max === 'number' && Number(job.attemptsMade ?? 0) >= max;
        if (ultima) {
          const desfecho = await this.encerrarPorBloqueio(tx, erro.message);
          return {
            ok: false,
            preEnvioEsgotado: true,
            desfecho,
            motivo: erro.message,
          };
        }
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
   * Devolve valor + tarifa ao lojista. Idempotente pelas chaves por transação
   * (`saque:estorno:<txId>` / `saque:estorno-tarifa:<txId>`): rodar de novo
   * (retry, ou o webhook/conciliação chegando depois da recusa síncrona)
   * credita uma vez só.
   *
   * Só roda em recusa CONFIRMADA: a liquidante disse não, então o dinheiro
   * nunca saiu e segurar o saldo seria reter dinheiro do lojista. Em desfecho
   * AMBÍGUO isto nunca roda — lá o valor pode ter saído, e estornar criaria um
   * rombo.
   */
  private async estornarSaque(
    tx: { id: bigint; usuarioId: bigint; valorBruto: unknown; valorTarifaPix: unknown },
    motivo: string,
    db?: Prisma.TransactionClient,
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

    await this.ledger.aplicarMovimentacoes(
      { usuarioId: tx.usuarioId, entries },
      db,
    );
    this.logger.log(
      `saque tx=${tx.id} estornado: ${valor.toFixed(2)} + tarifa ${tarifa.toFixed(2)}`,
    );
  }

  /**
   * Encerra saque BLOQUEADO na revalidação: FALHA + estorno automático.
   *
   * Bloqueio ≠ recusa: aqui a liquidante nunca foi chamada. Mas a doutrina é a
   * MESMA da recusa síncrona — não há tentativa nem id da liquidante, logo não
   * há rede de recuperação pela conciliação: o ESTORNO vem primeiro, em commit
   * próprio; a marcação de FALHA vem depois. Um blip entre os dois deixa
   * inconsistência de STATUS com o dinheiro já devolvido (o crédito tem chave
   * idempotente `saque:estorno:<txId>` — reprocessar não paga de novo).
   *
   * Três guardas dentro do FOR UPDATE, nesta ordem:
   *
   * 1. **Situação ainda enviável.** Terminal = outro caminho já selou; não
   *    regride nem estorna.
   * 2. **Nenhuma tentativa não-FALHA.** O bloqueio roda ANTES do claim, mas um
   *    retry manual de saque JÁ ENVIADO (tentativa SUCESSO/ENVIANDO à espera do
   *    webhook) também cai aqui — p.ex. admin bloqueou a conta com a ordem em
   *    voo. Estornar esse seria devolver o saldo de um PIX que saiu: perda
   *    dupla. Nada é tocado; webhook/conciliação decidem (têm o id).
   * 3. **Débito integral existe.** `criarSaque` grava débito e transação no
   *    mesmo commit, então faltar débito é estado corrompido (dado legado /
   *    intervenção manual) — estornar criaria dinheiro. Sela FALHA sem estorno,
   *    com `conferenciaManual: true` no histórico e erro alto no log.
   */
  private async encerrarPorBloqueio(
    tx: {
      id: bigint;
      usuarioId: bigint;
      idTransacaoPublico: string;
      situacao: string;
      valorBruto: unknown;
      valorTarifaPix: unknown;
    },
    motivo: string,
  ): Promise<'estornado' | 'sem-debito' | 'em-voo' | 'selado'> {
    const enviaveis = [
      SITUACAO_TRANSACAO.PENDENTE,
      SITUACAO_TRANSACAO.PROCESSANDO,
    ];

    const desfecho = await this.prisma.$transaction(async (db) => {
      const rows = await db.$queryRaw<Array<{ situacao: string }>>`
        SELECT situacao FROM transacoes WHERE id = ${tx.id} FOR UPDATE
      `;
      const atual = rows[0]?.situacao ?? '';
      if (!(enviaveis as string[]).includes(atual)) return 'selado' as const;

      const emVoo = await db.tentativaTransacao.findFirst({
        where: {
          transacaoId: tx.id,
          situacao: { not: SITUACAO_TENTATIVA.FALHA },
        },
        select: { id: true },
      });
      if (emVoo) return 'em-voo' as const;

      const debitos = await db.movimentacaoSaldo.aggregate({
        where: { transacaoId: tx.id, tipoMovimento: 'DEBITO' },
        _sum: { valor: true },
      });
      const debitado = money(debitos._sum.valor?.toString() ?? '0');
      const esperado = money(String(tx.valorBruto)).plus(
        money(String(tx.valorTarifaPix)),
      );
      if (debitado.lt(esperado)) return 'sem-debito' as const;

      await this.estornarSaque(tx, `bloqueado: ${motivo}`.slice(0, 200), db);
      return 'estornado' as const;
    });

    if (desfecho === 'selado') {
      this.logger.warn(
        `saque tx=${tx.id} bloqueado (${motivo.slice(0, 200)}) mas desfecho já ` +
          'selado por outro caminho — nada a fazer',
      );
      return desfecho;
    }
    if (desfecho === 'em-voo') {
      this.logger.error(
        `saque tx=${tx.id} bloqueado (${motivo.slice(0, 200)}) com ordem JÁ ` +
          'ENVIADA/EM VOO — sem estorno e sem FALHA; webhook/conciliação decidem',
      );
      return desfecho;
    }
    if (desfecho === 'sem-debito') {
      this.logger.error(
        `OPS saque tx=${tx.id} bloqueado (${motivo.slice(0, 200)}) SEM débito ` +
          'integral no ledger — FALHA sem estorno; conferência manual obrigatória',
      );
    }

    await this.prisma.$transaction(async (db) => {
      // Guarda de estado final: nunca regride desfecho selado em corrida.
      const claim = await db.transacao.updateMany({
        where: { id: tx.id, situacao: { in: enviaveis } },
        data: { situacao: SITUACAO_TRANSACAO.FALHA, falhouEm: new Date() },
      });
      if (claim.count !== 1) {
        this.logger.error(
          `saque tx=${tx.id} bloqueado e ESTORNADO mas desfecho selado antes ` +
            'da marcação de FALHA — conferência manual obrigatória',
        );
        await db.historicoSituacaoTransacao.create({
          data: {
            transacaoId: tx.id,
            situacaoAnterior: tx.situacao,
            novaSituacao: tx.situacao,
            origem: 'WORKER',
            motivo:
              'Bloqueio na revalidação APÓS desfecho selado por outro caminho — ' +
              'estorno já aplicado, conferir manualmente',
            metadados: { saldoDevolvido: true, conferenciaManual: true },
          },
        });
        return;
      }
      await db.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: tx.situacao,
          novaSituacao: SITUACAO_TRANSACAO.FALHA,
          origem: 'WORKER',
          motivo: `Saque bloqueado na revalidação: ${motivo.slice(0, 400)}`,
          metadados:
            desfecho === 'estornado'
              ? { saldoDevolvido: true, estorno: 'automatico' }
              : { saldoDevolvido: false, conferenciaManual: true },
        },
      });
      await db.eventoOutbox.create({
        data: {
          usuarioId: tx.usuarioId,
          tipoAgregado: 'TRANSACAO',
          identificadorAgregado: tx.idTransacaoPublico,
          tipoEvento: EVENTOS_LOJISTA.PIX_CASHOUT_FALHOU,
          conteudo: {
            idTransacao: tx.idTransacaoPublico,
            situacao: SITUACAO_TRANSACAO.FALHA,
            motivo: motivo.slice(0, 400),
          },
        },
      });
    });

    this.logger.warn(
      `saque tx=${tx.id} encerrado por bloqueio (${desfecho}): ${motivo.slice(0, 200)}`,
    );
    return desfecho;
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
     * O estorno é GUARDADO pela situação, com FOR UPDATE: se um webhook PAID
     * contraditório selou `CONCLUIDA` enquanto o 4xx estava em trânsito, o PIX
     * saiu — estornar aqui devolveria o saldo de um PIX pago (perda dupla).
     * Nesse caso nada é estornado e a situação não regride.
     *
     * (No webhook e na conciliação é o oposto — lá o saque FOI enviado, tem id
     * da liquidante, então a conciliação recupera e o commit atômico é seguro.)
     */
    const enviaveis = [
      SITUACAO_TRANSACAO.PENDENTE,
      SITUACAO_TRANSACAO.PROCESSANDO,
    ];
    const estornado = await this.prisma.$transaction(async (db) => {
      const rows = await db.$queryRaw<Array<{ situacao: string }>>`
        SELECT situacao FROM transacoes WHERE id = ${tx.id} FOR UPDATE
      `;
      const atual = rows[0]?.situacao ?? '';
      if (!(enviaveis as string[]).includes(atual)) return false;
      await this.estornarSaque(tx, erro.message.slice(0, 200), db);
      return true;
    });

    if (!estornado) {
      this.logger.error(
        `saque tx=${tx.id} recusa 4xx com desfecho já selado por outro caminho ` +
          `— sem estorno e sem rebaixar a situação; conferir na liquidante`,
      );
      // A tentativa só fecha em FALHA se ainda estava em voo — se o webhook a
      // promoveu a SUCESSO, o registro do pagamento não é apagado.
      await this.prisma.tentativaTransacao.updateMany({
        where: { id: tentativaId, situacao: SITUACAO_TENTATIVA.ENVIANDO },
        data: {
          situacao: SITUACAO_TENTATIVA.FALHA,
          statusHttp: erro.detalhe.statusHttp,
          mensagemErro: erro.message.slice(0, 2000),
          dadosResposta: (erro.detalhe.dadosResposta ?? undefined) as never,
          concluidoEm: new Date(),
        },
      });
      return;
    }

    await this.prisma.$transaction(async (db) => {
      // Fecha a tentativa em FALHA: a ordem foi recusada, então ela NÃO conta
      // como "em voo" e não trava um reenvio futuro legítimo.
      await db.tentativaTransacao.updateMany({
        where: { id: tentativaId, situacao: SITUACAO_TENTATIVA.ENVIANDO },
        data: {
          situacao: SITUACAO_TENTATIVA.FALHA,
          statusHttp: erro.detalhe.statusHttp,
          mensagemErro: erro.message.slice(0, 2000),
          dadosResposta: (erro.detalhe.dadosResposta ?? undefined) as never,
          concluidoEm: new Date(),
        },
      });
      // Guarda de estado final: `count === 0` significa que outro caminho selou
      // o desfecho entre o estorno e esta marcação. A situação nunca regride.
      const claim = await db.transacao.updateMany({
        where: { id: tx.id, situacao: { in: enviaveis } },
        data: { situacao: SITUACAO_TRANSACAO.FALHA, falhouEm: new Date() },
      });
      if (claim.count !== 1) {
        this.logger.error(
          `saque tx=${tx.id} ESTORNADO mas desfecho selado por outro caminho ` +
            `antes da marcação de FALHA — conferência manual obrigatória`,
        );
        await db.historicoSituacaoTransacao.create({
          data: {
            transacaoId: tx.id,
            situacaoAnterior: tx.situacao,
            novaSituacao: tx.situacao,
            origem: 'WORKER',
            motivo:
              'Recusa da liquidante APÓS desfecho selado por outro caminho — ' +
              'estorno já aplicado, conferir manualmente',
            metadados: { saldoDevolvido: true, conferenciaManual: true },
          },
        });
        return;
      }
      await db.historicoSituacaoTransacao.create({
        data: {
          transacaoId: tx.id,
          situacaoAnterior: tx.situacao,
          novaSituacao: SITUACAO_TRANSACAO.FALHA,
          origem: 'WORKER',
          motivo: `Saque recusado pela liquidante: ${erro.message.slice(0, 400)}`,
          metadados: { saldoDevolvido: true, estorno: 'automatico' },
        },
      });
      await db.eventoOutbox.create({
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
      });
    });
  }
}
