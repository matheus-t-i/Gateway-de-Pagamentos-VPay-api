import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  diaCivilBrasilia,
  fimDoDiaBrasilia,
  inicioDoDiaBrasilia,
  inicioDoDiaCivil,
  fimDoDiaCivil,
  money,
  moneyToString,
  SITUACAO_TRANSACAO,
} from '../shared';

type FiltrosResultado = {
  dataInicial?: string;
  dataFinal?: string;
  tipo?: string;
  cliente?: string;
  adquirente?: string;
  resultado?: string;
};

/**
 * Cash-in cuja tarifa já foi (ou está sendo) cobrada do lojista.
 *
 * - `CONCLUIDA`: crédito feito, tarifa persistida na operação.
 * - `LIQUIDADA`: passo interno do crédito (legado/intermediário) — o dinheiro
 *   já entrou; o faturamento trata igual a paga.
 * - `MED`: venda que JÁ foi paga e depois contestada. A tarifa foi cobrada no
 *   crédito; o MED mexe no saldo do lojista, não devolve a tarifa da VPay.
 *
 * `AGUARDANDO_PAGAMENTO` NÃO entra: PIX ainda não pago, ou retido pelo método
 * (pago na liquidante sem crédito — a tarifa do lojista ainda não foi cobrada).
 */
const SITUACOES_CASH_IN_PAGO: string[] = [
  SITUACAO_TRANSACAO.CONCLUIDA,
  SITUACAO_TRANSACAO.LIQUIDADA,
  SITUACAO_TRANSACAO.MED,
];

/** Cash-out que de fato saiu. PROCESSANDO ainda pode falhar na liquidante. */
const SITUACOES_CASH_OUT_PAGO: string[] = [SITUACAO_TRANSACAO.CONCLUIDA];

function statusDe(r: ReturnType<typeof money>): 'Lucro' | 'Prejuízo' | 'Neutro' {
  if (r.gt('0.0001')) return 'Lucro';
  if (r.lt('-0.0001')) return 'Prejuízo';
  return 'Neutro';
}

function margemPct(
  resultado: ReturnType<typeof money>,
  volume: ReturnType<typeof money>,
): string {
  if (volume.isZero()) return moneyToString(money(0));
  return moneyToString(resultado.mul(100).div(volume));
}

@Injectable()
export class RelatorioResultadoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Apuração de resultado: receita efetivamente cobrada do lojista (tarifa
   * persistida em venda PAGA) menos o custo persistido da adquirente.
   *
   * Volume processado = valor bruto das mesmas operações pagas. PIX em
   * `AGUARDANDO_PAGAMENTO` não é volume processado nem receita.
   *
   * Vendas retidas = `retidaMetodo` ainda em `AGUARDANDO_PAGAMENTO` (pagas na
   * liquidante, sem crédito). Entram só no card informativo — não na receita
   * nem no resultado líquido.
   */
  async gerar(q: FiltrosResultado) {
    const inicio = q.dataInicial
      ? (inicioDoDiaCivil(q.dataInicial) ?? inicioDoDiaBrasilia())
      : inicioDoDiaBrasilia();
    const fim = q.dataFinal
      ? (fimDoDiaCivil(q.dataFinal) ?? fimDoDiaBrasilia())
      : fimDoDiaBrasilia();
    const tipo =
      q.tipo === 'cash-in' || q.tipo === 'cash-out' ? q.tipo : undefined;
    const buscaCliente = (q.cliente ?? '').trim().toLowerCase();
    const filtroAdq = (q.adquirente ?? '').trim();
    const filtroResultado = q.resultado;

    const AG = SITUACAO_TRANSACAO.AGUARDANDO_PAGAMENTO;

    const cond: Array<Record<string, unknown>> = [];
    if (!tipo || tipo === 'cash-in') {
      cond.push({
        direcao: 'ENTRADA',
        situacao: { in: SITUACOES_CASH_IN_PAGO as never },
      });
      // Informativo: paga na liquidante, ainda sem crédito ao lojista.
      cond.push({
        direcao: 'ENTRADA',
        situacao: AG,
        retidaMetodo: true,
      });
    }
    if (!tipo || tipo === 'cash-out') {
      cond.push({
        direcao: 'SAIDA',
        situacao: { in: SITUACOES_CASH_OUT_PAGO as never },
      });
    }

    const txs = await this.prisma.transacao.findMany({
      where: { criadoEm: { gte: inicio, lte: fim }, OR: cond as never },
      select: {
        usuarioId: true,
        direcao: true,
        situacao: true,
        retidaMetodo: true,
        valorBruto: true,
        valorTarifaPix: true,
        valorCustoPixProvedor: true,
        contaProvedorId: true,
      },
      take: 200000,
    });

    const usuarioIds = [...new Set(txs.map((t) => t.usuarioId))];
    const contaIds = [
      ...new Set(txs.map((t) => t.contaProvedorId).filter(Boolean)),
    ] as bigint[];
    const [donos, contas] = await Promise.all([
      this.prisma.usuario.findMany({
        where: { id: { in: usuarioIds } },
        select: {
          id: true,
          idPublico: true,
          nomeRazaoSocial: true,
          email: true,
        },
      }),
      this.prisma.contaProvedor.findMany({
        where: { id: { in: contaIds } },
        select: { id: true, provedor: { select: { codigo: true, nome: true } } },
      }),
    ]);
    const donoMap = new Map(donos.map((u) => [u.id.toString(), u]));
    const contaMap = new Map(contas.map((c) => [c.id.toString(), c.provedor]));

    type Det = {
      tipo: string;
      adquirente: string;
      operacoes: number;
      volume: ReturnType<typeof money>;
      receita: ReturnType<typeof money>;
      custo: ReturnType<typeof money>;
      resultado: ReturnType<typeof money>;
    };
    type Cli = {
      idPublico: string;
      nome: string;
      email: string;
      operacoes: number;
      volume: ReturnType<typeof money>;
      receita: ReturnType<typeof money>;
      custo: ReturnType<typeof money>;
      resultado: ReturnType<typeof money>;
      retido: ReturnType<typeof money>;
      retidoOps: number;
      custoAusente: boolean;
      adqSet: Set<string>;
      dets: Map<string, Det>;
    };
    const clientes = new Map<string, Cli>();

    const zero = () => money(0);

    for (const t of txs) {
      const dono = donoMap.get(t.usuarioId.toString());
      if (!dono) continue;
      const nome = dono.nomeRazaoSocial;
      const email = dono.email;
      if (
        buscaCliente &&
        !(
          nome.toLowerCase().includes(buscaCliente) ||
          email.toLowerCase().includes(buscaCliente) ||
          dono.idPublico.toLowerCase().includes(buscaCliente)
        )
      )
        continue;
      const prov = t.contaProvedorId
        ? contaMap.get(t.contaProvedorId.toString())
        : null;
      const adqCodigo = prov?.codigo ?? '—';
      if (filtroAdq && adqCodigo !== filtroAdq) continue;

      const retida =
        t.direcao === 'ENTRADA' &&
        t.situacao === AG &&
        t.retidaMetodo === true;
      const cashInPago =
        t.direcao === 'ENTRADA' && SITUACOES_CASH_IN_PAGO.includes(t.situacao);
      const cashOutPago =
        t.direcao === 'SAIDA' && SITUACOES_CASH_OUT_PAGO.includes(t.situacao);
      if (!retida && !cashInPago && !cashOutPago) continue;

      const volume = money(t.valorBruto.toString());
      const tipoLabel = t.direcao === 'ENTRADA' ? 'Cash-in' : 'Cash-out';

      let cli = clientes.get(t.usuarioId.toString());
      if (!cli) {
        cli = {
          idPublico: dono.idPublico,
          nome,
          email,
          operacoes: 0,
          volume: zero(),
          receita: zero(),
          custo: zero(),
          resultado: zero(),
          retido: zero(),
          retidoOps: 0,
          custoAusente: false,
          adqSet: new Set(),
          dets: new Map(),
        };
        clientes.set(t.usuarioId.toString(), cli);
      }
      cli.adqSet.add(adqCodigo);

      if (retida) {
        cli.retido = cli.retido.plus(volume);
        cli.retidoOps++;
        continue;
      }

      const receita = money(t.valorTarifaPix.toString());
      const custo = money(t.valorCustoPixProvedor.toString());
      const resultado = receita.minus(custo);

      cli.operacoes++;
      cli.volume = cli.volume.plus(volume);
      cli.receita = cli.receita.plus(receita);
      cli.custo = cli.custo.plus(custo);
      cli.resultado = cli.resultado.plus(resultado);
      if (custo.isZero()) cli.custoAusente = true;

      const dk = `${tipoLabel}|${adqCodigo}`;
      let det = cli.dets.get(dk);
      if (!det) {
        det = {
          tipo: tipoLabel,
          adquirente: adqCodigo,
          operacoes: 0,
          volume: zero(),
          receita: zero(),
          custo: zero(),
          resultado: zero(),
        };
        cli.dets.set(dk, det);
      }
      det.operacoes++;
      det.volume = det.volume.plus(volume);
      det.receita = det.receita.plus(receita);
      det.custo = det.custo.plus(custo);
      det.resultado = det.resultado.plus(resultado);
    }

    let lista = [...clientes.values()];
    if (filtroResultado === 'lucro')
      lista = lista.filter((c) => c.resultado.gt('0.0001'));
    else if (filtroResultado === 'prejuizo')
      lista = lista.filter((c) => c.resultado.lt('-0.0001'));
    else if (filtroResultado === 'neutro')
      lista = lista.filter((c) => c.resultado.abs().lte('0.0001'));
    lista.sort((a, b) => b.resultado.cmp(a.resultado));

    const volumeTotal = lista.reduce((s, c) => s.plus(c.volume), zero());
    const receitaTotal = lista.reduce((s, c) => s.plus(c.receita), zero());
    const custoTotal = lista.reduce((s, c) => s.plus(c.custo), zero());
    const resultadoTotal = receitaTotal.minus(custoTotal);
    const retidasTotal = lista.reduce((s, c) => s.plus(c.retido), zero());
    const retidasOps = lista.reduce((s, c) => s + c.retidoOps, 0);

    return {
      filtros: {
        dataInicial: diaCivilBrasilia(inicio),
        dataFinal: diaCivilBrasilia(fim),
        tipo: tipo ?? 'todos',
        adquirente: filtroAdq || 'todas',
        resultado: filtroResultado ?? 'todos',
      },
      kpis: {
        volumeProcessado: moneyToString(volumeTotal),
        receitaCobrada: moneyToString(receitaTotal),
        custoAdquirentes: moneyToString(custoTotal),
        resultadoLiquido: moneyToString(resultadoTotal),
        vendasRetidas: moneyToString(retidasTotal),
        vendasRetidasOps: retidasOps,
        margemSobreVolume: margemPct(resultadoTotal, volumeTotal),
        operacoes: lista.reduce((s, c) => s + c.operacoes, 0),
        clientesLucrativos: lista.filter((c) => c.resultado.gt('0.0001')).length,
        clientesPrejuizo: lista.filter((c) => c.resultado.lt('-0.0001')).length,
        clientesNeutros: lista.filter((c) => c.resultado.abs().lte('0.0001'))
          .length,
        clientesCustoAusente: lista.filter((c) => c.custoAusente).length,
      },
      clientes: lista.map((c) => ({
        idPublico: c.idPublico,
        nome: c.nome,
        email: c.email,
        operacoes: c.operacoes,
        volume: moneyToString(c.volume),
        receita: moneyToString(c.receita),
        custo: moneyToString(c.custo),
        resultado: moneyToString(c.resultado),
        margem: margemPct(c.resultado, c.volume),
        status: statusDe(c.resultado),
        adquirentes: c.adqSet.size,
        retido: moneyToString(c.retido),
        retidoOps: c.retidoOps,
        custoAusente: c.custoAusente,
        detalhes: [...c.dets.values()]
          .map((d) => ({
            tipo: d.tipo,
            adquirente: d.adquirente,
            operacoes: d.operacoes,
            volume: moneyToString(d.volume),
            receita: moneyToString(d.receita),
            custo: moneyToString(d.custo),
            resultado: moneyToString(d.resultado),
            margem: margemPct(d.resultado, d.volume),
            taxaCliente: d.volume.isZero()
              ? moneyToString(money(0))
              : moneyToString(d.receita.mul(100).div(d.volume)),
            status: statusDe(d.resultado),
          }))
          .sort((a, b) => money(b.resultado).cmp(money(a.resultado))),
      })),
      total: lista.length,
    };
  }
}
