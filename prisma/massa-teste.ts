/**
 * Massa de teste — DESENVOLVIMENTO.
 *
 * Gera um histórico plausível (12 meses) para ver o sistema funcionando: vários
 * lojistas em situações diferentes, cobranças com itens e pagador, saques,
 * contestações (MED) e — o ponto delicado — **saldo coerente com o ledger**:
 * cada crédito/débito vira `movimentacoes_saldo` com `saldoApos`, e
 * `saldos_usuarios` é o resultado dessa simulação, nunca um número escrito na mão.
 *
 * Idempotente: tudo que ele cria carrega o prefixo `MASSA-` em
 * `referenciaExterna` / `chaveIdempotencia`, e a execução começa limpando o que
 * ficou da rodada anterior. Não toca em dado que não seja dele.
 *
 * Uso:  npm run db:massa            (populacao padrão)
 *       npm run db:massa -- --limpar  (só remove a massa anterior)
 *
 * Recusa rodar com NODE_ENV=production.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();
const PREFIXO = 'MASSA-';
const SENHA_PADRAO = process.env.MASSA_SENHA ?? 'Cliente@123456';

const dec = (v: number | string) => new Prisma.Decimal(v);
const dinheiro = (v: Prisma.Decimal | number | string) =>
  dec(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** PRNG determinístico: a mesma massa em toda execução (bug reproduzível). */
let semente = 20260805;
function rnd() {
  semente = (semente * 1664525 + 1013904223) % 4294967296;
  return semente / 4294967296;
}
const entre = (min: number, max: number) => min + rnd() * (max - min);
const inteiro = (min: number, max: number) => Math.floor(entre(min, max + 1));
const escolher = <T>(itens: readonly T[]) => itens[inteiro(0, itens.length - 1)];

const PRODUTOS = [
  { titulo: 'Curso de Tráfego Pago', min: 197, max: 997, tangivel: false },
  { titulo: 'Mentoria Individual', min: 500, max: 2500, tangivel: false },
  { titulo: 'E-book Receitas Fit', min: 27, max: 67, tangivel: false },
  { titulo: 'Kit Skincare Completo', min: 89, max: 350, tangivel: true },
  { titulo: 'Tênis Running Pro', min: 299, max: 899, tangivel: true },
  { titulo: 'Assinatura Mensal Premium', min: 49, max: 149, tangivel: false },
  { titulo: 'Consultoria Financeira', min: 350, max: 1500, tangivel: false },
  { titulo: 'Camiseta Oversized', min: 59, max: 159, tangivel: true },
];

const PAGADORES = [
  ['Ana Beatriz Souza', 'ana.souza@email.com', '11987654321'],
  ['Carlos Eduardo Lima', 'carlos.lima@email.com', '21998877665'],
  ['Fernanda Rocha', 'fernanda.rocha@email.com', '31991234567'],
  ['João Pedro Alves', 'joao.alves@email.com', '41987651234'],
  ['Mariana Castro', 'mariana.castro@email.com', '51996543210'],
  ['Rafael Nogueira', 'rafael.nogueira@email.com', '61994321098'],
  ['Juliana Ferreira', 'ju.ferreira@email.com', '71993216547'],
  ['Bruno Martins', 'bruno.martins@email.com', '81992345678'],
  ['Patrícia Gomes', 'patricia.gomes@email.com', '91998765432'],
  ['Thiago Mendes', 'thiago.mendes@email.com', '11976543210'],
];

const ENDERECO_PAGADOR = {
  logradouro: 'Rua das Palmeiras',
  numero: '1024',
  complemento: 'Apto 52',
  cep: '01310930',
  bairro: 'Bela Vista',
  cidade: 'São Paulo',
  uf: 'SP',
  pais: 'BR',
};

/** Perfis de lojista: volume/ritmo diferentes para as telas não ficarem chapadas. */
const LOJISTAS = [
  {
    email: process.env.CLIENTE_EMAIL ?? 'cliente@vpay.local',
    criarUsuario: false, // já vem do seed — só recebe histórico
    nome: 'Cliente Teste VPay',
    vendasPorMes: [8, 12, 14, 19, 22, 27, 31, 38, 44, 52, 61, 74],
    faixa: [120, 900] as [number, number],
    // D+2 com 5% de reserva por 30 dias: é o que faz "A liberar" e "Reservado"
    // aparecerem no painel — no padrão do sistema (D+0, 0%) tudo cai em
    // disponível e as caixas ficam sempre zeradas.
    config: { diasLiberacaoSaldo: 2, percentualReserva: 5, diasRetencaoReserva: 30 },
    saques: 4,
    meds: 3,
  },
  {
    email: 'acaipower@vpay.local',
    criarUsuario: true,
    tipoPessoa: 'PF' as const,
    cpfCnpj: '39053344705',
    nome: 'Marcos Vinícius Ribeiro',
    fantasia: 'Açaí Power Delivery',
    situacao: 'ATIVO' as const,
    vendasPorMes: [30, 34, 41, 38, 47, 52, 59, 66, 71, 83, 92, 104],
    faixa: [35, 220] as [number, number],
    config: { diasLiberacaoSaldo: 1, percentualReserva: 0, diasRetencaoReserva: 0 },
    saques: 6,
    meds: 1,
  },
  {
    email: 'modaviva@vpay.local',
    criarUsuario: true,
    tipoPessoa: 'PJ' as const,
    cpfCnpj: '19131243000197',
    nome: 'Moda Viva Comércio de Roupas LTDA',
    fantasia: 'Moda Viva',
    responsavel: { cpf: '52998224725', nome: 'Renata Aparecida Duarte' },
    situacao: 'ATIVO' as const,
    vendasPorMes: [4, 9, 11, 16, 15, 23, 26, 24, 33, 37, 40, 48],
    faixa: [90, 1200] as [number, number],
    config: { diasLiberacaoSaldo: 3, percentualReserva: 8, diasRetencaoReserva: 45 },
    saques: 3,
    meds: 2,
  },
  {
    email: 'novato@vpay.local',
    criarUsuario: true,
    tipoPessoa: 'PF' as const,
    cpfCnpj: '16899535009',
    nome: 'Lucas Andrade Pinto',
    fantasia: 'Lucas Digital',
    situacao: 'ATIVO' as const,
    vendasPorMes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 5, 9],
    faixa: [47, 297] as [number, number],
    config: { diasLiberacaoSaldo: 1, percentualReserva: 0, diasRetencaoReserva: 0 },
    saques: 1,
    meds: 0,
  },
  {
    email: 'aguardando-docs@vpay.local',
    criarUsuario: true,
    tipoPessoa: 'PF' as const,
    cpfCnpj: '24971563792',
    nome: 'Camila Ribeiro Nunes',
    fantasia: 'Camila Cosméticos',
    situacao: 'PENDENTE' as const, // login roteia para envio de documentos
    vendasPorMes: [],
    faixa: [50, 300] as [number, number],
  },
  {
    email: 'em-analise@vpay.local',
    criarUsuario: true,
    tipoPessoa: 'PJ' as const,
    cpfCnpj: '11444777000161',
    nome: 'Tech Store Eletrônicos LTDA',
    fantasia: 'Tech Store',
    responsavel: { cpf: '39053344705', nome: 'Gustavo Henrique Prado' },
    situacao: 'EM_ANALISE' as const, // aparece na fila de aprovações do admin
    vendasPorMes: [],
    faixa: [200, 2000] as [number, number],
  },
];

/** Distribuição de desfecho das cobranças (soma 100). */
const DESFECHOS = [
  { situacao: 'CONCLUIDA' as const, peso: 62 },
  { situacao: 'AGUARDANDO_PAGAMENTO' as const, peso: 14 },
  { situacao: 'FALHA' as const, peso: 9 },
  { situacao: 'CANCELADA' as const, peso: 9 },
  { situacao: 'MED' as const, peso: 6 },
];

function sortearDesfecho() {
  const total = DESFECHOS.reduce((s, d) => s + d.peso, 0);
  let n = rnd() * total;
  for (const d of DESFECHOS) {
    n -= d.peso;
    if (n <= 0) return d.situacao;
  }
  return 'CONCLUIDA' as const;
}

// ---------------------------------------------------------------------------
// Limpeza da massa anterior
// ---------------------------------------------------------------------------

async function limpar() {
  const txs = await prisma.transacao.findMany({
    where: { referenciaExterna: { startsWith: PREFIXO } },
    select: { id: true },
  });
  const ids = txs.map((t) => t.id);
  if (ids.length) {
    const casos = await prisma.casoMed.findMany({
      where: { transacaoId: { in: ids } },
      select: { id: true },
    });
    const casoIds = casos.map((c) => c.id);

    await prisma.devolucaoPix.deleteMany({ where: { transacaoId: { in: ids } } });
    await prisma.movimentacaoSaldo.updateMany({
      where: { transacaoId: { in: ids } },
      data: { movimentacaoRelacionadaId: null },
    });
    await prisma.liberacaoSaldo.deleteMany({ where: { transacaoId: { in: ids } } });
    await prisma.movimentacaoSaldo.deleteMany({ where: { transacaoId: { in: ids } } });
    if (casoIds.length) {
      await prisma.historicoCasoMed.deleteMany({
        where: { casoMedId: { in: casoIds } },
      });
      await prisma.bloqueioSaldo.deleteMany({ where: { casoMedId: { in: casoIds } } });
      await prisma.movimentacaoSaldo.deleteMany({
        where: { casoMedId: { in: casoIds } },
      });
      await prisma.casoMed.deleteMany({ where: { id: { in: casoIds } } });
    }
    await prisma.historicoSituacaoTransacao.deleteMany({
      where: { transacaoId: { in: ids } },
    });
    await prisma.tentativaTransacao.deleteMany({ where: { transacaoId: { in: ids } } });
    await prisma.itemCobranca.deleteMany({ where: { transacaoId: { in: ids } } });
    await prisma.chaveIdempotencia.deleteMany({ where: { transacaoId: { in: ids } } });
    await prisma.transacaoPix.deleteMany({ where: { transacaoId: { in: ids } } });
    await prisma.transacao.deleteMany({ where: { id: { in: ids } } });
  }

  // Movimentações avulsas da massa (saques/ajustes sem transação vinculada).
  await prisma.movimentacaoSaldo.deleteMany({
    where: { chaveIdempotencia: { startsWith: PREFIXO } },
  });

  const emails = LOJISTAS.filter((l) => l.criarUsuario).map((l) => l.email);
  const usuarios = await prisma.usuario.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const usuarioIds = usuarios.map((u) => u.id);
  if (usuarioIds.length) {
    await prisma.chavePixUsuario.deleteMany({ where: { usuarioId: { in: usuarioIds } } });
    await prisma.historicoSituacaoUsuario.deleteMany({
      where: { usuarioId: { in: usuarioIds } },
    });
    await prisma.aceiteDocumentoLegal.deleteMany({
      where: { usuarioId: { in: usuarioIds } },
    });
    await prisma.usuarioPapel.deleteMany({ where: { usuarioId: { in: usuarioIds } } });
    await prisma.configuracaoPixUsuario.deleteMany({
      where: { usuarioId: { in: usuarioIds } },
    });
    await prisma.saldoUsuario.deleteMany({ where: { usuarioId: { in: usuarioIds } } });
    await prisma.usuario.deleteMany({ where: { id: { in: usuarioIds } } });
  }

  // Zera o saldo do cliente do seed (o histórico dele é recriado do zero).
  const seedEmail = process.env.CLIENTE_EMAIL ?? 'cliente@vpay.local';
  const doSeed = await prisma.usuario.findUnique({ where: { email: seedEmail } });
  if (doSeed) {
    await prisma.chavePixUsuario.deleteMany({
      where: { usuarioId: doSeed.id, apelido: { startsWith: PREFIXO } },
    });
    await prisma.saldoUsuario.updateMany({
      where: { usuarioId: doSeed.id },
      data: {
        saldoDisponivel: 0,
        saldoPendenteLiberacao: 0,
        saldoReservado: 0,
        saldoBloqueadoMed: 0,
        saldoBloqueadoManual: 0,
      },
    });
  }

  console.log(`Limpeza: ${ids.length} transações da massa anterior removidas.`);
}

// ---------------------------------------------------------------------------
// Simulação de saldo (espelha LedgerService.aplicarMovimentacoes)
// ---------------------------------------------------------------------------

type TipoSaldo =
  | 'DISPONIVEL'
  | 'PENDENTE_LIBERACAO'
  | 'RESERVADO'
  | 'BLOQUEADO_MED'
  | 'BLOQUEADO_MANUAL';

type Lancamento = {
  usuarioId: bigint;
  tipoSaldo: TipoSaldo;
  tipoMovimento: 'CREDITO' | 'DEBITO';
  natureza: string;
  valor: Prisma.Decimal;
  chaveIdempotencia: string;
  transacaoId?: bigint;
  casoMedId?: bigint;
  descricao: string;
  ocorridoEm: Date;
};

/** Aplica os lançamentos em ordem cronológica, calculando `saldoApos` por caixa. */
async function aplicarLancamentos(lancamentos: Lancamento[]) {
  const ordenados = [...lancamentos].sort(
    (a, b) => a.ocorridoEm.getTime() - b.ocorridoEm.getTime(),
  );
  const caixas = new Map<string, Prisma.Decimal>();
  const chave = (u: bigint, t: TipoSaldo) => `${u}:${t}`;

  const registros: Prisma.MovimentacaoSaldoCreateManyInput[] = [];
  for (const l of ordenados) {
    const k = chave(l.usuarioId, l.tipoSaldo);
    const atual = caixas.get(k) ?? dec(0);
    const novo =
      l.tipoMovimento === 'CREDITO' ? atual.plus(l.valor) : atual.minus(l.valor);
    caixas.set(k, novo);
    registros.push({
      usuarioId: l.usuarioId,
      transacaoId: l.transacaoId,
      casoMedId: l.casoMedId,
      chaveIdempotencia: l.chaveIdempotencia,
      tipoSaldo: l.tipoSaldo,
      tipoMovimento: l.tipoMovimento,
      natureza: l.natureza as never,
      valor: dinheiro(l.valor),
      saldoApos: dinheiro(novo),
      descricao: l.descricao,
      ocorridoEm: l.ocorridoEm,
      criadoEm: l.ocorridoEm,
    });
  }

  for (let i = 0; i < registros.length; i += 500) {
    await prisma.movimentacaoSaldo.createMany({ data: registros.slice(i, i + 500) });
  }

  // Consolida os saldos a partir do último `saldoApos` de cada caixa.
  const porUsuario = new Map<string, Record<TipoSaldo, Prisma.Decimal>>();
  for (const [k, v] of caixas) {
    const [uid, tipo] = k.split(':');
    const atual =
      porUsuario.get(uid) ??
      ({
        DISPONIVEL: dec(0),
        PENDENTE_LIBERACAO: dec(0),
        RESERVADO: dec(0),
        BLOQUEADO_MED: dec(0),
        BLOQUEADO_MANUAL: dec(0),
      } as Record<TipoSaldo, Prisma.Decimal>);
    atual[tipo as TipoSaldo] = v;
    porUsuario.set(uid, atual);
  }

  for (const [uid, s] of porUsuario) {
    await prisma.saldoUsuario.upsert({
      where: { usuarioId: BigInt(uid) },
      create: {
        usuarioId: BigInt(uid),
        saldoDisponivel: dinheiro(s.DISPONIVEL),
        saldoPendenteLiberacao: dinheiro(s.PENDENTE_LIBERACAO),
        saldoReservado: dinheiro(s.RESERVADO),
        saldoBloqueadoMed: dinheiro(s.BLOQUEADO_MED),
        saldoBloqueadoManual: dinheiro(s.BLOQUEADO_MANUAL),
      },
      update: {
        saldoDisponivel: dinheiro(s.DISPONIVEL),
        saldoPendenteLiberacao: dinheiro(s.PENDENTE_LIBERACAO),
        saldoReservado: dinheiro(s.RESERVADO),
        saldoBloqueadoMed: dinheiro(s.BLOQUEADO_MED),
        saldoBloqueadoManual: dinheiro(s.BLOQUEADO_MANUAL),
      },
    });
  }

  return registros.length;
}

// ---------------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('massa-teste não roda em produção.');
  }

  const somenteLimpar = process.argv.includes('--limpar');
  await limpar();
  if (somenteLimpar) {
    console.log('Só limpeza pedida — encerrando.');
    return;
  }

  const padrao = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
    where: { padraoSistema: true },
  });
  const conta = await prisma.contaProvedor.findFirstOrThrow({
    where: { id: padrao.contaProvedorPixEntradaId ?? undefined },
    include: { custoPix: true },
  });
  const papelCliente = await prisma.papel.findUniqueOrThrow({
    where: { nome: 'CLIENTE' },
  });
  const admin = await prisma.usuario.findFirstOrThrow({
    where: { email: process.env.ADMIN_EMAIL ?? 'admin@vpay.local' },
  });
  const senhaHash = await argon2.hash(SENHA_PADRAO);

  const custoPct = dec(conta.custoPix?.custoPixEntradaPercentual ?? 0);
  const custoFixo = dec(conta.custoPix?.custoPixEntradaFixo ?? 0);

  const agora = new Date();
  const lancamentos: Lancamento[] = [];
  let totalTx = 0;
  const resumo: Array<{ lojista: string; vendas: number; gmv: string }> = [];

  for (const perfil of LOJISTAS) {
    // --- usuário ---------------------------------------------------------
    let usuario = await prisma.usuario.findUnique({ where: { email: perfil.email } });
    if (!usuario) {
      if (!perfil.criarUsuario) {
        console.warn(`Lojista ${perfil.email} não existe — rode o seed antes. Pulando.`);
        continue;
      }
      usuario = await prisma.usuario.create({
        data: {
          tipoPessoa: perfil.tipoPessoa!,
          cpfCnpj: perfil.cpfCnpj!,
          nomeRazaoSocial: perfil.nome,
          nomeFantasia: perfil.fantasia,
          cpfResponsavel: perfil.responsavel?.cpf ?? perfil.cpfCnpj!,
          nomeResponsavel: perfil.responsavel?.nome ?? perfil.nome,
          email: perfil.email,
          telefone: `1198${inteiro(1000000, 9999999)}`,
          senhaHash,
          situacao: perfil.situacao!,
          temaPreferido: 'PADRAO',
          ativadoEm: perfil.situacao === 'ATIVO' ? new Date() : null,
          faturamentoMensalMedio: dinheiro(entre(5000, 250000)),
          endereco: ENDERECO_PAGADOR,
        },
      });
      await prisma.usuarioPapel.create({
        data: { usuarioId: usuario.id, papelId: papelCliente.id },
      });
      await prisma.configuracaoPixUsuario.create({
        data: {
          usuarioId: usuario.id,
          configuracaoPadraoOrigemId: padrao.id,
          contaProvedorPixEntradaId: padrao.contaProvedorPixEntradaId,
          contaProvedorPixSaidaId: padrao.contaProvedorPixSaidaId,
          taxaPixEntradaPercentual: padrao.taxaPixEntradaPercentual,
          taxaPixEntradaFixa: padrao.taxaPixEntradaFixa,
          taxaPixSaidaPercentual: padrao.taxaPixSaidaPercentual,
          taxaPixSaidaFixa: padrao.taxaPixSaidaFixa,
          ticketMinimoPixEntrada: padrao.ticketMinimoPixEntrada,
          ticketMaximoPixEntrada: padrao.ticketMaximoPixEntrada,
          ticketMinimoPixSaida: padrao.ticketMinimoPixSaida,
          ticketMaximoPixSaida: padrao.ticketMaximoPixSaida,
          limiteDiarioPixSaida: padrao.limiteDiarioPixSaida,
          maxSaquesPorHora: padrao.maxSaquesPorHora,
          permitirPixSaidaViaApi: padrao.permitirPixSaidaViaApi,
          diasLiberacaoSaldo: padrao.diasLiberacaoSaldo,
          percentualReserva: padrao.percentualReserva,
          baseCalculoReserva: padrao.baseCalculoReserva,
          diasRetencaoReserva: padrao.diasRetencaoReserva,
          modoTratamentoMed: padrao.modoTratamentoMed,
          permiteSaldoNegativo: padrao.permiteSaldoNegativo,
        },
      });
      await prisma.saldoUsuario.create({ data: { usuarioId: usuario.id } });
    }

    if (perfil.config) {
      await prisma.configuracaoPixUsuario.update({
        where: { usuarioId: usuario.id },
        data: {
          diasLiberacaoSaldo: perfil.config.diasLiberacaoSaldo,
          percentualReserva: dec(perfil.config.percentualReserva),
          diasRetencaoReserva: perfil.config.diasRetencaoReserva,
        },
      });
    }

    const cfg = await prisma.configuracaoPixUsuario.findUniqueOrThrow({
      where: { usuarioId: usuario.id },
    });

    // Chave PIX aprovada — sem ela o saque pelo painel não é permitido.
    if (perfil.situacao !== 'PENDENTE' && perfil.situacao !== 'EM_ANALISE') {
      await prisma.chavePixUsuario.upsert({
        where: { usuarioId_chave: { usuarioId: usuario.id, chave: perfil.email } },
        create: {
          usuarioId: usuario.id,
          apelido: `${PREFIXO}Conta principal`,
          chave: perfil.email,
          tipoChave: 'EMAIL',
          nomeTitular: usuario.nomeRazaoSocial,
          documentoTitular: usuario.cpfCnpj,
          situacao: 'APROVADA',
          aprovadaPorUsuarioId: admin.id,
          aprovadaEm: new Date(),
          criadoPorUsuarioId: usuario.id,
        },
        update: { situacao: 'APROVADA', aprovadaPorUsuarioId: admin.id },
      });
    }

    if (!perfil.vendasPorMes.length) {
      resumo.push({ lojista: perfil.fantasia ?? perfil.nome, vendas: 0, gmv: '0,00' });
      continue;
    }

    // --- transações ------------------------------------------------------
    let vendasDoLojista = 0;
    let gmvDoLojista = dec(0);
    // Lançamentos deste lojista: saque e MED precisam saber o disponível que
    // sobrou antes de debitar, para a massa nunca gerar saldo negativo.
    const lancamentosUsuario: Lancamento[] = [];
    const pagas: Array<{ id: bigint; valor: Prisma.Decimal; quando: Date }> = [];

    for (let m = 0; m < perfil.vendasPorMes.length; m++) {
      const mesesAtras = perfil.vendasPorMes.length - 1 - m;
      const quantidade = perfil.vendasPorMes[m];

      for (let i = 0; i < quantidade; i++) {
        const ref = new Date(
          agora.getFullYear(),
          agora.getMonth() - mesesAtras,
          1,
          0,
          0,
          0,
        );
        const ultimoDia =
          mesesAtras === 0
            ? agora.getDate()
            : new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate();
        const criadoEm = new Date(
          ref.getFullYear(),
          ref.getMonth(),
          inteiro(1, Math.max(ultimoDia, 1)),
          inteiro(8, 22),
          inteiro(0, 59),
          inteiro(0, 59),
        );
        if (criadoEm > agora) criadoEm.setTime(agora.getTime() - inteiro(60, 7200) * 1000);

        const produto = escolher(PRODUTOS);
        const quantidadeItem = produto.tangivel ? inteiro(1, 3) : 1;
        const unitario = dinheiro(entre(perfil.faixa[0], perfil.faixa[1]));
        const valorBruto = dinheiro(unitario.mul(quantidadeItem));
        const situacao = sortearDesfecho();
        const pagador = escolher(PAGADORES);

        // Snapshot financeiro — mesma conta do LedgerService.calcularSnapshotsEntrada.
        const valorTarifa = dinheiro(
          valorBruto.mul(cfg.taxaPixEntradaPercentual).div(100).plus(cfg.taxaPixEntradaFixa),
        );
        const valorCusto = dinheiro(
          valorBruto.mul(custoPct).div(100).plus(custoFixo),
        );
        const valorLiquidacao = dinheiro(valorBruto.minus(valorTarifa));
        const baseReserva =
          cfg.baseCalculoReserva === 'VALOR_BRUTO' ? valorBruto : valorLiquidacao;
        const valorReserva = dinheiro(baseReserva.mul(cfg.percentualReserva).div(100));
        const valorDisponivel = dinheiro(valorLiquidacao.minus(valorReserva));

        const liberarSaldoEm = new Date(criadoEm);
        liberarSaldoEm.setDate(liberarSaldoEm.getDate() + cfg.diasLiberacaoSaldo);
        const liberarReservaEm = new Date(criadoEm);
        liberarReservaEm.setDate(liberarReservaEm.getDate() + cfg.diasRetencaoReserva);

        const paga = situacao === 'CONCLUIDA';
        const liquidadoEm = paga
          ? new Date(criadoEm.getTime() + inteiro(30, 3600) * 1000)
          : null;

        const tx = await prisma.transacao.create({
          data: {
            usuarioId: usuario.id,
            contaProvedorId: conta.id,
            referenciaExterna: `${PREFIXO}${usuario.id}-${mesesAtras}-${i}`,
            direcao: 'ENTRADA',
            valorBruto,
            tarifaPixPercentualAplicada: cfg.taxaPixEntradaPercentual,
            tarifaPixFixaAplicada: cfg.taxaPixEntradaFixa,
            valorTarifaPix: valorTarifa,
            custoPixProvedorPercentualAplicado: custoPct,
            custoPixProvedorFixoAplicado: custoFixo,
            valorCustoPixProvedor: valorCusto,
            valorLiquidacaoEmpresa: valorLiquidacao,
            valorReserva,
            valorDisponivelPrevisto: valorDisponivel,
            valorMargemBruta: dinheiro(valorTarifa.minus(valorCusto)),
            diasLiberacaoSaldoAplicado: cfg.diasLiberacaoSaldo,
            percentualReservaAplicado: cfg.percentualReserva,
            baseCalculoReservaAplicada: cfg.baseCalculoReserva,
            diasRetencaoReservaAplicado: cfg.diasRetencaoReserva,
            liberarSaldoEm,
            liberarReservaEm,
            situacao,
            liquidadoEm,
            concluidoEm: liquidadoEm,
            falhouEm:
              situacao === 'FALHA' || situacao === 'CANCELADA'
                ? new Date(criadoEm.getTime() + inteiro(60, 7200) * 1000)
                : null,
            criadoEm,
            metadados: { origem: 'massa-teste' },
            pix: {
              create: {
                txid: `MASSA${usuario.id}${mesesAtras}${i}`.slice(0, 35),
                identificadorFimAFim: paga
                  ? `E${inteiro(10000000, 99999999)}${criadoEm.getTime()}`.slice(0, 32)
                  : null,
                nomePagador: pagador[0],
                documentoPagador: String(inteiro(10000000000, 99999999999)),
                emailPagador: pagador[1],
                telefonePagador: pagador[2],
                enderecoPagador: produto.tangivel ? ENDERECO_PAGADOR : undefined,
                pixCopiaCola: `00020126580014BR.GOV.BCB.PIX0136${usuario.idPublico}5204000053039865802BR`,
                expiraEm: new Date(criadoEm.getTime() + 3600 * 1000),
                criadoEm,
              },
            },
            itens: {
              create: [
                {
                  titulo: produto.titulo,
                  quantidade: quantidadeItem,
                  valorUnitario: unitario,
                  valorTotal: valorBruto,
                  tangivel: produto.tangivel,
                  criadoEm,
                },
              ],
            },
            historicosSituacao: {
              create: {
                // Espelha o fluxo real: a cobrança nasce AGUARDANDO_PAGAMENTO
                // (histórico inicial sem anterior) e só depois vira terminal.
                situacaoAnterior:
                  situacao === 'AGUARDANDO_PAGAMENTO' ? null : 'AGUARDANDO_PAGAMENTO',
                novaSituacao: situacao,
                origem: paga ? 'WEBHOOK_PROVEDOR' : 'SISTEMA',
                motivo: paga ? 'Confirmado Camada1' : 'Massa de teste',
                criadoEm: liquidadoEm ?? criadoEm,
              },
            },
          },
        });

        totalTx++;
        if (!paga) continue;

        vendasDoLojista++;
        gmvDoLojista = gmvDoLojista.plus(valorBruto);
        const quando = liquidadoEm!;
        const principal = dinheiro(valorLiquidacao.minus(valorReserva));
        pagas.push({ id: tx.id, valor: valorBruto, quando });

        // Crédito: entra em PENDENTE_LIBERACAO e migra para DISPONIVEL na data
        // de liberação — exatamente o que a fila 6-liberacao-saldo faria.
        if (cfg.diasLiberacaoSaldo > 0) {
          lancamentosUsuario.push({
            usuarioId: usuario.id,
            tipoSaldo: 'PENDENTE_LIBERACAO',
            tipoMovimento: 'CREDITO',
            natureza: 'RECEBIMENTO',
            valor: principal,
            chaveIdempotencia: `${PREFIXO}cashin:pendente:${tx.id}`,
            transacaoId: tx.id,
            descricao: 'Crédito pendente liberação',
            ocorridoEm: quando,
          });
          if (liberarSaldoEm <= agora) {
            lancamentosUsuario.push({
              usuarioId: usuario.id,
              tipoSaldo: 'PENDENTE_LIBERACAO',
              tipoMovimento: 'DEBITO',
              natureza: 'LIBERACAO',
              valor: principal,
              chaveIdempotencia: `${PREFIXO}lib:saida:${tx.id}`,
              transacaoId: tx.id,
              descricao: 'Liberação de saldo',
              ocorridoEm: liberarSaldoEm,
            });
            lancamentosUsuario.push({
              usuarioId: usuario.id,
              tipoSaldo: 'DISPONIVEL',
              tipoMovimento: 'CREDITO',
              natureza: 'LIBERACAO',
              valor: principal,
              chaveIdempotencia: `${PREFIXO}lib:entrada:${tx.id}`,
              transacaoId: tx.id,
              descricao: 'Liberação de saldo',
              ocorridoEm: liberarSaldoEm,
            });
          }
          await prisma.liberacaoSaldo.create({
            data: {
              usuarioId: usuario.id,
              transacaoId: tx.id,
              tipoLiberacao: 'SALDO_PRINCIPAL',
              valor: principal,
              liberarEm: liberarSaldoEm,
              situacao: liberarSaldoEm <= agora ? 'LIBERADA' : 'AGENDADA',
              processadoEm: liberarSaldoEm <= agora ? liberarSaldoEm : null,
              criadoEm: quando,
            },
          });
        } else {
          lancamentosUsuario.push({
            usuarioId: usuario.id,
            tipoSaldo: 'DISPONIVEL',
            tipoMovimento: 'CREDITO',
            natureza: 'RECEBIMENTO',
            valor: principal,
            chaveIdempotencia: `${PREFIXO}cashin:disp:${tx.id}`,
            transacaoId: tx.id,
            descricao: 'Crédito disponível cash-in',
            ocorridoEm: quando,
          });
        }

        if (valorReserva.gt(0)) {
          lancamentosUsuario.push({
            usuarioId: usuario.id,
            tipoSaldo: 'RESERVADO',
            tipoMovimento: 'CREDITO',
            natureza: 'RESERVA',
            valor: valorReserva,
            chaveIdempotencia: `${PREFIXO}cashin:reserva:${tx.id}`,
            transacaoId: tx.id,
            descricao: 'Reserva cash-in',
            ocorridoEm: quando,
          });
          if (liberarReservaEm <= agora) {
            lancamentosUsuario.push({
              usuarioId: usuario.id,
              tipoSaldo: 'RESERVADO',
              tipoMovimento: 'DEBITO',
              natureza: 'LIBERACAO',
              valor: valorReserva,
              chaveIdempotencia: `${PREFIXO}lib:res:saida:${tx.id}`,
              transacaoId: tx.id,
              descricao: 'Liberação de reserva',
              ocorridoEm: liberarReservaEm,
            });
            lancamentosUsuario.push({
              usuarioId: usuario.id,
              tipoSaldo: 'DISPONIVEL',
              tipoMovimento: 'CREDITO',
              natureza: 'LIBERACAO',
              valor: valorReserva,
              chaveIdempotencia: `${PREFIXO}lib:res:entrada:${tx.id}`,
              transacaoId: tx.id,
              descricao: 'Liberação de reserva',
              ocorridoEm: liberarReservaEm,
            });
          }
        }
      }
    }

    // --- saques (SAIDA) --------------------------------------------------
    // Sempre depois do último crédito e limitados a uma fração do disponível:
    // saque maior que o saldo é justamente o que o sistema recusa.
    // Disponível NA DATA: debitar olhando só o total final deixaria `saldoApos`
    // negativo no meio da linha do tempo. Como débito só existe aqui, o que
    // couber na data também cabe depois (crédito posterior só soma).
    const disponivel = (ate: Date) =>
      lancamentosUsuario
        .filter((l) => l.tipoSaldo === 'DISPONIVEL' && l.ocorridoEm <= ate)
        .reduce(
          (s, l) => (l.tipoMovimento === 'CREDITO' ? s.plus(l.valor) : s.minus(l.valor)),
          dec(0),
        );

    const chavePix = await prisma.chavePixUsuario.findFirst({
      where: { usuarioId: usuario.id, situacao: 'APROVADA' },
    });

    for (let s = 0; s < (perfil.saques ?? 0); s++) {
      const quandoSaque = new Date(
        agora.getTime() - inteiro(1, 45) * 86_400_000 + inteiro(0, 43_200) * 1000,
      );
      const saldo = disponivel(quandoSaque);
      if (saldo.lte(100)) continue;
      const valorSaque = dinheiro(saldo.mul(dec(entre(0.08, 0.22))));
      if (valorSaque.lt(20)) continue;
      const tarifaSaque = dinheiro(
        valorSaque.mul(cfg.taxaPixSaidaPercentual).div(100).plus(cfg.taxaPixSaidaFixa),
      );
      if (saldo.lt(valorSaque.plus(tarifaSaque))) continue;

      const txSaque = await prisma.transacao.create({
        data: {
          usuarioId: usuario.id,
          contaProvedorId: conta.id,
          referenciaExterna: `${PREFIXO}saque-${usuario.id}-${s}`,
          direcao: 'SAIDA',
          valorBruto: valorSaque,
          tarifaPixPercentualAplicada: cfg.taxaPixSaidaPercentual,
          tarifaPixFixaAplicada: cfg.taxaPixSaidaFixa,
          valorTarifaPix: tarifaSaque,
          valorLiquidacaoEmpresa: valorSaque,
          valorDisponivelPrevisto: valorSaque,
          valorMargemBruta: tarifaSaque,
          situacao: 'CONCLUIDA',
          liquidadoEm: quandoSaque,
          concluidoEm: quandoSaque,
          criadoEm: quandoSaque,
          metadados: { origem: 'massa-teste' },
          pix: {
            create: {
              nomeBeneficiario: usuario.nomeRazaoSocial,
              documentoBeneficiario: usuario.cpfCnpj,
              chavePix: chavePix?.chave ?? usuario.email,
              tipoChavePix: chavePix?.tipoChave ?? 'EMAIL',
              identificadorFimAFim: `E${inteiro(10000000, 99999999)}${quandoSaque.getTime()}`.slice(0, 32),
              criadoEm: quandoSaque,
            },
          },
          historicosSituacao: {
            create: {
              situacaoAnterior: 'PROCESSANDO',
              novaSituacao: 'CONCLUIDA',
              origem: 'WEBHOOK_PROVEDOR',
              motivo: 'Saque confirmado',
              criadoEm: quandoSaque,
            },
          },
        },
      });
      totalTx++;

      lancamentosUsuario.push({
        usuarioId: usuario.id,
        tipoSaldo: 'DISPONIVEL',
        tipoMovimento: 'DEBITO',
        natureza: 'SAIDA',
        valor: valorSaque,
        chaveIdempotencia: `${PREFIXO}saque:${txSaque.id}`,
        transacaoId: txSaque.id,
        descricao: 'Saque PIX',
        ocorridoEm: quandoSaque,
      });
      if (tarifaSaque.gt(0)) {
        lancamentosUsuario.push({
          usuarioId: usuario.id,
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'DEBITO',
          natureza: 'TARIFA',
          valor: tarifaSaque,
          chaveIdempotencia: `${PREFIXO}saque:tarifa:${txSaque.id}`,
          transacaoId: txSaque.id,
          descricao: 'Tarifa saque PIX',
          ocorridoEm: quandoSaque,
        });
      }
    }

    // --- contestações (MED) ----------------------------------------------
    // Um caso em aberto (saldo bloqueado), um aceito (devolvido ao pagador) e
    // um recusado (valor volta ao disponível) — os três estados que a tela de
    // MED precisa mostrar.
    const desfechosMed = ['SALDO_BLOQUEADO', 'ACEITO', 'RECUSADO'] as const;
    const candidatas = pagas.slice(-40);
    for (let k = 0; k < Math.min(perfil.meds ?? 0, candidatas.length); k++) {
      const alvo = candidatas[candidatas.length - 1 - k * 3];
      if (!alvo) break;

      const desfecho = desfechosMed[k % desfechosMed.length];
      const recebidoEm = new Date(
        Math.min(
          agora.getTime() - inteiro(1, 20) * 86_400_000,
          alvo.quando.getTime() + inteiro(2, 15) * 86_400_000,
        ),
      );
      const quandoMed =
        recebidoEm > alvo.quando
          ? recebidoEm
          : new Date(alvo.quando.getTime() + 86_400_000);

      // Bloqueio só alcança o que existe na data (o resto vira valorNaoCoberto).
      // O teto de 40% é só de vitrine: sem ele um MED grande zera o disponível
      // do lojista demo e a tela fica sem nada para mostrar.
      const saldo = disponivel(quandoMed);
      const teto = saldo.gt(0) ? dinheiro(saldo.mul(dec(0.4))) : dec(0);
      const valorMed = dinheiro(Prisma.Decimal.min(alvo.valor, teto));
      if (valorMed.lte(0)) continue;
      const decididoEm =
        desfecho === 'SALDO_BLOQUEADO'
          ? null
          : new Date(quandoMed.getTime() + inteiro(1, 5) * 86_400_000);

      const caso = await prisma.casoMed.create({
        data: {
          usuarioId: usuario.id,
          transacaoId: alvo.id,
          contaProvedorId: conta.id,
          identificadorMedProvedor: `${PREFIXO}med-${alvo.id}`,
          chaveIdempotencia: `${PREFIXO}med:${alvo.id}`,
          valorSolicitado: alvo.valor,
          modoTratamentoAplicado: 'BLOQUEAR_SALDO',
          valorBloqueado: valorMed,
          valorNaoCoberto: dinheiro(alvo.valor.minus(valorMed)),
          valorDebitado: desfecho === 'ACEITO' ? valorMed : dec(0),
          situacao: desfecho,
          motivo: escolher([
            'Cliente não reconhece a compra',
            'Produto não entregue',
            'Suspeita de fraude no pagamento',
          ]),
          prazoRespostaEm: new Date(quandoMed.getTime() + 7 * 86_400_000),
          recebidoEm: quandoMed,
          decididoEm,
          decididoPorUsuarioId: decididoEm ? admin.id : null,
          encerradoEm: decididoEm,
          criadoEm: quandoMed,
        },
      });

      await prisma.bloqueioSaldo.create({
        data: {
          usuarioId: usuario.id,
          casoMedId: caso.id,
          tipo: 'MED',
          valorSolicitado: alvo.valor,
          valorBloqueado: valorMed,
          valorNaoCoberto: dinheiro(alvo.valor.minus(valorMed)),
          motivo: 'Contestação recebida da adquirente',
          situacao: decididoEm ? 'ENCERRADO' : 'ATIVO',
          bloqueadoEm: quandoMed,
          encerradoEm: decididoEm,
          criadoEm: quandoMed,
        },
      });

      // Bloqueio: sai do disponível, entra no bloqueado MED.
      lancamentosUsuario.push({
        usuarioId: usuario.id,
        tipoSaldo: 'DISPONIVEL',
        tipoMovimento: 'DEBITO',
        natureza: 'BLOQUEIO_MED',
        valor: valorMed,
        chaveIdempotencia: `${PREFIXO}med:bloq:saida:${caso.id}`,
        casoMedId: caso.id,
        transacaoId: alvo.id,
        descricao: 'Bloqueio por contestação (MED)',
        ocorridoEm: quandoMed,
      });
      lancamentosUsuario.push({
        usuarioId: usuario.id,
        tipoSaldo: 'BLOQUEADO_MED',
        tipoMovimento: 'CREDITO',
        natureza: 'BLOQUEIO_MED',
        valor: valorMed,
        chaveIdempotencia: `${PREFIXO}med:bloq:entrada:${caso.id}`,
        casoMedId: caso.id,
        transacaoId: alvo.id,
        descricao: 'Bloqueio por contestação (MED)',
        ocorridoEm: quandoMed,
      });

      if (desfecho === 'ACEITO' && decididoEm) {
        // Aceito: o dinheiro sai de vez e vira devolução ao pagador.
        lancamentosUsuario.push({
          usuarioId: usuario.id,
          tipoSaldo: 'BLOQUEADO_MED',
          tipoMovimento: 'DEBITO',
          natureza: 'DEBITO_MED',
          valor: valorMed,
          chaveIdempotencia: `${PREFIXO}med:debito:${caso.id}`,
          casoMedId: caso.id,
          transacaoId: alvo.id,
          descricao: 'MED aceito — débito definitivo',
          ocorridoEm: decididoEm,
        });
        await prisma.devolucaoPix.create({
          data: {
            transacaoId: alvo.id,
            casoMedId: caso.id,
            referenciaExterna: `${PREFIXO}dev-${caso.id}`,
            identificadorDevolucaoProvedor: `${PREFIXO}D${caso.id}`,
            valor: valorMed,
            motivo: 'Devolução por MED aceito',
            situacao: 'CONCLUIDA',
            criadoEm: decididoEm,
          },
        });
        await prisma.transacao.update({
          where: { id: alvo.id },
          data: { situacao: 'MED' },
        });
      } else if (desfecho === 'RECUSADO' && decididoEm) {
        // Recusado: volta para o disponível do lojista.
        lancamentosUsuario.push({
          usuarioId: usuario.id,
          tipoSaldo: 'BLOQUEADO_MED',
          tipoMovimento: 'DEBITO',
          natureza: 'DESBLOQUEIO_MED',
          valor: valorMed,
          chaveIdempotencia: `${PREFIXO}med:desbloq:saida:${caso.id}`,
          casoMedId: caso.id,
          transacaoId: alvo.id,
          descricao: 'MED recusado — desbloqueio',
          ocorridoEm: decididoEm,
        });
        lancamentosUsuario.push({
          usuarioId: usuario.id,
          tipoSaldo: 'DISPONIVEL',
          tipoMovimento: 'CREDITO',
          natureza: 'DESBLOQUEIO_MED',
          valor: valorMed,
          chaveIdempotencia: `${PREFIXO}med:desbloq:entrada:${caso.id}`,
          casoMedId: caso.id,
          transacaoId: alvo.id,
          descricao: 'MED recusado — desbloqueio',
          ocorridoEm: decididoEm,
        });
      }

      await prisma.historicoCasoMed.create({
        data: {
          casoMedId: caso.id,
          situacaoAnterior: 'RECEBIDO',
          novaSituacao: desfecho,
          acao: desfecho === 'SALDO_BLOQUEADO' ? 'BLOQUEIO_SALDO' : 'DECISAO',
          origem: desfecho === 'SALDO_BLOQUEADO' ? 'WEBHOOK_PROVEDOR' : 'PAINEL_ADMIN',
          usuarioAtorId: decididoEm ? admin.id : null,
          motivo: 'Massa de teste',
          criadoEm: decididoEm ?? quandoMed,
        },
      });
    }

    lancamentos.push(...lancamentosUsuario);
    resumo.push({
      lojista: perfil.fantasia ?? perfil.nome,
      vendas: vendasDoLojista,
      gmv: gmvDoLojista.toFixed(2),
    });
  }

  const movimentacoes = await aplicarLancamentos(lancamentos);

  console.log('\n--- Massa de teste criada ---');
  console.table(resumo);
  console.log(`Transações: ${totalTx} · Movimentações de saldo: ${movimentacoes}`);
  console.log(`Senha dos lojistas criados: ${SENHA_PADRAO}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
