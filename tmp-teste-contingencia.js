/* Verificação end-to-end da contingência (roda contra o dist compilado). */
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { PixService } = require('./dist/pix/pix.service');
const { PrismaService } = require('./dist/prisma/prisma.service');
const { ProviderRegistry } = require('./dist/providers/provider.registry');

let falhas = 0;
const ok = (s) => console.log(`  OK      ${s}`);
const nok = (s) => { falhas++; console.log(`  FALHOU  ${s}`); };

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const pix = app.get(PixService);
  const mock = app.get(ProviderRegistry).get('mock');
  const original = mock.createCharge.bind(mock);

  const admin = await prisma.usuario.findFirstOrThrow({ where: { email: 'admin@vpay.local' } });
  const entrada = (ref) => ({
    usuarioId: admin.id,
    input: { valor: '10.00', referenciaExterna: ref,
      itens: [{ titulo: 'Teste', quantidade: 1, valorUnitario: 10, tangivel: false }] },
  });

  console.log('\nA) Caminho feliz (regressão da via do dinheiro)');
  const a = await pix.criarCobranca(entrada(`a-${Date.now()}`));
  a.pixCopiaCola ? ok('cobrança gerada com código PIX') : nok('sem código PIX');
  a.situacao === 'AGUARDANDO_PAGAMENTO' ? ok(`situação ${a.situacao}`) : nok(`situação ${a.situacao}`);
  const nA = await prisma.falhaAdquirente.count({ where: { transacaoId: BigInt(a.idInterno) } });
  nA === 0 ? ok('nenhuma falha registrada') : nok(`${nA} falha(s)`);

  console.log('\nB) Adquirente falha SEM cadeia de contingência');
  await prisma.contingenciaAdquirente.deleteMany({});
  mock.createCharge = async () => {
    throw Object.assign(new Error('503 da liquidante'), {
      response: { status: 503, data: { erro: 'upstream indisponivel' } } });
  };
  let erroB = null;
  try { await pix.criarCobranca(entrada(`b-${Date.now()}`)); } catch (e) { erroB = e; }
  erroB ? ok(`recusou a venda: ${String(erroB.message).slice(0, 55)}…`) : nok('deveria ter lançado');
  const fB = await prisma.falhaAdquirente.findFirst({ orderBy: { id: 'desc' }, include: { transacao: true } });
  fB && fB.tipo === 'ERRO_PROVEDOR' ? ok(`tipo=${fB.tipo} httpStatus=${fB.statusHttp}`) : nok(`tipo=${fB && fB.tipo}`);
  fB && fB.dadosResposta ? ok(`response cru guardado: ${JSON.stringify(fB.dadosResposta)}`) : nok('response cru ausente');
  fB && fB.transacao && fB.transacao.situacao === 'FALHA' ? ok('transação marcada FALHA') : nok('transação não virou FALHA');
  fB && fB.resolvidaPorContaProvedorId === null ? ok('marcada como venda perdida') : nok('resolução indevida');

  console.log('\nC) Principal falha e a CONTINGÊNCIA salva a venda');
  const principal = await prisma.contaProvedor.findFirstOrThrow({ orderBy: { id: 'asc' } });
  const backup = await prisma.contaProvedor.upsert({
    where: { chaveUnicaConta: 'mock:contingencia-teste' },
    create: { provedorPagamentoId: principal.provedorPagamentoId, nome: 'Mock Contingência',
      chaveUnicaConta: 'mock:contingencia-teste',
      credenciaisCriptografadas: principal.credenciaisCriptografadas,
      pixEntradaHabilitado: true, pixSaidaHabilitado: false, situacao: 'ATIVO' },
    update: { situacao: 'ATIVO', pixEntradaHabilitado: true },
  });
  await prisma.contingenciaAdquirente.deleteMany({});
  await prisma.contingenciaAdquirente.create({ data: { contaProvedorId: backup.id, ordem: 1, ativo: true } });

  let primeira = true;
  mock.createCharge = async (input) => {
    if (primeira) { primeira = false;
      throw Object.assign(new Error('gateway timeout'), {
        response: { status: 504, data: { erro: 'gateway timeout' } } }); }
    return original(input);
  };

  const c = await pix.criarCobranca(entrada(`c-${Date.now()}`));
  c.pixCopiaCola ? ok('venda SALVA pela contingência') : nok('contingência não gerou código');
  const txC = await prisma.transacao.findUniqueOrThrow({ where: { id: BigInt(c.idInterno) },
    include: { tentativas: { orderBy: { numeroTentativa: 'asc' } } } });
  txC.contaProvedorId === backup.id ? ok('transação remanejada para a conta de contingência')
    : nok(`ficou na conta ${txC.contaProvedorId}`);
  txC.tentativas.length === 2 ? ok(`2 tentativas: ${txC.tentativas.map((t) => t.situacao).join(' → ')}`)
    : nok(`${txC.tentativas.length} tentativa(s)`);
  const fC = await prisma.falhaAdquirente.findFirst({ where: { transacaoId: txC.id } });
  fC && fC.resolvidaPorContaProvedorId === backup.id ? ok('falha marcada com "onde foi gerada"')
    : nok('resolução não marcada');

  mock.createCharge = original;
  await app.close();
  console.log(falhas === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${falhas} VERIFICAÇÃO(ÕES) FALHARAM`);
  process.exitCode = falhas === 0 ? 0 : 1;
}
main().catch((e) => { console.error('ERRO:', e && e.message); process.exitCode = 1; });
