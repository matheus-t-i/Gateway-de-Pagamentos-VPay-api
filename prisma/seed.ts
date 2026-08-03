import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const PRODUCAO = process.env.NODE_ENV === 'production';
/**
 * Recursos de DESENVOLVIMENTO (provedor mock, allowlist aberta, admin com senha
 * padrão) nunca podem nascer em produção. Em prod o seed cria apenas o
 * indispensável: papéis, permissões e o admin — com senha obrigatória via env.
 */

async function main() {
  if (PRODUCAO && !process.env.ADMIN_PASSWORD) {
    throw new Error('ADMIN_PASSWORD é obrigatória para semear em produção.');
  }
  const papeis = [
    { nome: 'CLIENTE', descricao: 'Cliente do gateway' },
    { nome: 'FUNCIONARIO', descricao: 'Funcionário interno' },
    { nome: 'ADMINISTRADOR', descricao: 'Administrador do sistema' },
    { nome: 'FINANCEIRO', descricao: 'Equipe financeira' },
    { nome: 'ANALISTA_MED', descricao: 'Analista de casos MED' },
  ];

  for (const p of papeis) {
    await prisma.papel.upsert({
      where: { nome: p.nome },
      create: p,
      update: { descricao: p.descricao, ativo: true },
    });
  }

  const permissoes = [
    { codigo: 'painel.acessar', descricao: 'Acessar painel' },
    { codigo: 'empresas.gerenciar', descricao: 'Gerenciar empresas' },
    { codigo: 'credenciais.gerenciar', descricao: 'Gerenciar credenciais API' },
    { codigo: 'transacoes.ler', descricao: 'Listar transações' },
    { codigo: 'transacoes.criar', descricao: 'Criar cobranças/saques' },
    { codigo: 'admin.filas', descricao: 'Acessar Bull Board' },
    { codigo: 'admin.provedores', descricao: 'Gerenciar provedores' },
    { codigo: 'admin.usuarios', descricao: 'Gerenciar usuários' },
    { codigo: 'med.decidir', descricao: 'Decidir casos MED' },
  ];

  for (const perm of permissoes) {
    await prisma.permissao.upsert({
      where: { codigo: perm.codigo },
      create: perm,
      update: { descricao: perm.descricao },
    });
  }

  const adminPapel = await prisma.papel.findUniqueOrThrow({
    where: { nome: 'ADMINISTRADOR' },
  });
  const clientePapel = await prisma.papel.findUniqueOrThrow({
    where: { nome: 'CLIENTE' },
  });
  const allPerms = await prisma.permissao.findMany();

  for (const perm of allPerms) {
    await prisma.papelPermissao.upsert({
      where: {
        papelId_permissaoId: {
          papelId: adminPapel.id,
          permissaoId: perm.id,
        },
      },
      create: { papelId: adminPapel.id, permissaoId: perm.id },
      update: {},
    });
  }

  const clientePermCodes = [
    'painel.acessar',
    'empresas.gerenciar',
    'credenciais.gerenciar',
    'transacoes.ler',
    'transacoes.criar',
  ];
  for (const code of clientePermCodes) {
    const perm = allPerms.find((p) => p.codigo === code);
    if (!perm) continue;
    await prisma.papelPermissao.upsert({
      where: {
        papelId_permissaoId: {
          papelId: clientePapel.id,
          permissaoId: perm.id,
        },
      },
      create: { papelId: clientePapel.id, permissaoId: perm.id },
      update: {},
    });
  }

  const provedor = await prisma.provedorPagamento.upsert({
    where: { codigo: 'mock' },
    create: {
      codigo: 'mock',
      nome: 'Mock Provider',
      // Em produção nasce INATIVO: provedor inativo não movimenta nada.
      situacao: PRODUCAO ? 'INATIVO' : 'ATIVO',
      permitePixEntrada: true,
      permitePixSaida: true,
      exigeAssinaturaWebhook: true,
      segredoWebhookHash: await argon2.hash(
        process.env.MOCK_PROVIDER_WEBHOOK_KEY ?? 'mock-webhook-x-key-dev',
      ),
    },
    update: {
      permitePixEntrada: true,
      permitePixSaida: true,
    },
  });

  await prisma.ipPermitidoWebhookProvedor.upsert({
    where: {
      provedorPagamentoId_ipOuCidr: {
        provedorPagamentoId: provedor.id,
        ipOuCidr: '127.0.0.1',
      },
    },
    create: {
      provedorPagamentoId: provedor.id,
      ipOuCidr: '127.0.0.1',
    },
    update: {},
  });
  await prisma.ipPermitidoWebhookProvedor.upsert({
    where: {
      provedorPagamentoId_ipOuCidr: {
        provedorPagamentoId: provedor.id,
        ipOuCidr: '::1',
      },
    },
    create: {
      provedorPagamentoId: provedor.id,
      ipOuCidr: '::1',
    },
    update: {},
  });
  // 0.0.0.0/0 anula a Camada 2 (IP) — apenas para desenvolvimento local.
  if (!PRODUCAO) {
    await prisma.ipPermitidoWebhookProvedor.upsert({
      where: {
        provedorPagamentoId_ipOuCidr: {
          provedorPagamentoId: provedor.id,
          ipOuCidr: '0.0.0.0/0',
        },
      },
      create: { provedorPagamentoId: provedor.id, ipOuCidr: '0.0.0.0/0' },
      update: {},
    });
  }

  const conta = await prisma.contaProvedor.upsert({
    where: { chaveUnicaConta: 'mock:GATEWAY:default' },
    create: {
      provedorPagamentoId: provedor.id,
      nome: 'Mock Gateway Default',
      chaveUnicaConta: 'mock:GATEWAY:default',
      identificadorContaExterna: 'mock-default',
      credenciaisCriptografadas: JSON.stringify({ apiKey: 'mock-key' }),
      pixEntradaHabilitado: true,
      pixSaidaHabilitado: true,
      ticketMaximoPixEntrada: '100000.00',
      ticketMaximoPixSaida: '100000.00',
      situacao: 'ATIVO',
    },
    update: { situacao: 'ATIVO' },
  });

  await prisma.custoPixContaProvedor.upsert({
    where: { contaProvedorId: conta.id },
    create: {
      contaProvedorId: conta.id,
      custoPixEntradaPercentual: '0.5',
      custoPixEntradaFixo: '0.10',
      custoPixSaidaPercentual: '0.3',
      custoPixSaidaFixo: '0.50',
    },
    update: {},
  });

  await prisma.configuracaoPadraoPixUsuario.upsert({
    where: { nome: 'Padrao Sistema' },
    create: {
      nome: 'Padrao Sistema',
      descricao: 'Configuração padrão copiada na ativação do CLIENTE',
      padraoSistema: true,
      ativo: true,
      contaProvedorPixEntradaId: conta.id,
      contaProvedorPixSaidaId: conta.id,
      taxaPixEntradaPercentual: '1.5',
      taxaPixEntradaFixa: '0.50',
      taxaPixSaidaPercentual: '1.0',
      taxaPixSaidaFixa: '1.00',
      ticketMinimoPixEntrada: '1.00',
      ticketMaximoPixEntrada: '50000.00',
      ticketMinimoPixSaida: '1.00',
      ticketMaximoPixSaida: '50000.00',
      permitirPixSaidaViaApi: true,
      diasLiberacaoSaldo: 0,
      percentualReserva: '0',
      diasRetencaoReserva: 0,
      modoTratamentoMed: 'BLOQUEAR_SALDO',
    },
    update: {
      ativo: true,
      padraoSistema: true,
      contaProvedorPixEntradaId: conta.id,
      contaProvedorPixSaidaId: conta.id,
    },
  });

  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@vpay.local';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'Admin@123456';
  const senhaHash = await argon2.hash(adminPassword);

  const admin = await prisma.usuario.upsert({
    where: { email: adminEmail },
    create: {
      tipoPessoa: 'PF',
      cpfCnpj: '00000000000',
      nomeRazaoSocial: 'Administrador VPay',
      email: adminEmail,
      senhaHash,
      situacao: 'ATIVO',
      temaPreferido: 'PADRAO',
      ativadoEm: new Date(),
    },
    // NÃO reescreve senhaHash: reexecutar o seed não pode resetar a senha
    // do administrador para o valor padrão.
    update: { situacao: 'ATIVO' },
  });

  await prisma.usuarioPapel.upsert({
    where: {
      usuarioId_papelId: { usuarioId: admin.id, papelId: adminPapel.id },
    },
    create: { usuarioId: admin.id, papelId: adminPapel.id },
    update: {},
  });

  await prisma.politicaLimiteRequisicoes.createMany({
    data: [
      {
        escopo: 'IP',
        quantidadeMaxima: 120,
        janelaSegundos: 60,
        duracaoBloqueioSegundos: 300,
      },
      {
        escopo: 'CREDENCIAL_API',
        quantidadeMaxima: 60,
        janelaSegundos: 60,
        duracaoBloqueioSegundos: 300,
      },
    ],
    skipDuplicates: true,
  });

  console.log('Seed OK — admin:', adminEmail);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
