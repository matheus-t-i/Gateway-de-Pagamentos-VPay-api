import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { createCipheriv, randomBytes } from 'node:crypto';
import { DISPONIBILIDADE_ADQUIRENTE } from '../src/shared/situacoes';
import {
  CATALOGO_PERMISSOES,
  descricaoPermissao,
  PERMISSOES_PADRAO_ANALISTA_MED,
  PERMISSOES_PADRAO_CLIENTE,
  PERMISSOES_PADRAO_FINANCEIRO,
  PERMISSOES_PADRAO_FUNCIONARIO,
  TODAS_PERMISSOES,
} from '../src/shared/permissoes';

const prisma = new PrismaClient();

/** Mesmo AES-GCM de `crypto.util.ts` — seed não importa Nest. */
function encryptCredentialsSeed(plain: Record<string, unknown>): string {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY deve ter 64 hex chars para o seed');
  }
  const key = Buffer.from(hex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(plain), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

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
  /**
   * Perfis iniciais. ADMINISTRADOR e CLIENTE são de sistema (não podem ser
   * excluídos pelo painel); os demais são só sugestões — o admin edita as
   * permissões deles à vontade em /admin/perfis.
   */
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

  // Espelha o catálogo de código (src/shared/permissoes.ts) na tabela.
  for (const codigo of TODAS_PERMISSOES) {
    await prisma.permissao.upsert({
      where: { codigo },
      create: { codigo, descricao: descricaoPermissao(codigo).slice(0, 255) },
      update: { descricao: descricaoPermissao(codigo).slice(0, 255) },
    });
  }

  // Permissões que sumiram do catálogo não podem ficar penduradas em perfil:
  // continuariam sendo concedidas e não apareceriam na matriz do painel.
  const codigosValidos = TODAS_PERMISSOES as string[];
  const obsoletas = await prisma.permissao.findMany({
    where: { codigo: { notIn: codigosValidos } },
    select: { id: true, codigo: true },
  });
  if (obsoletas.length) {
    const ids = obsoletas.map((p) => p.id);
    await prisma.papelPermissao.deleteMany({ where: { permissaoId: { in: ids } } });
    await prisma.permissao.deleteMany({ where: { id: { in: ids } } });
    console.log(
      `Permissões obsoletas removidas: ${obsoletas.map((p) => p.codigo).join(', ')}`,
    );
  }

  const permissoesPorCodigo = new Map(
    (await prisma.permissao.findMany()).map((p) => [p.codigo, p.id]),
  );

  /** Substitui o conjunto de permissões do perfil pelo informado. */
  async function definirPermissoes(nomePapel: string, codigos: readonly string[]) {
    const papel = await prisma.papel.findUniqueOrThrow({
      where: { nome: nomePapel },
    });
    for (const codigo of codigos) {
      const permissaoId = permissoesPorCodigo.get(codigo);
      if (!permissaoId) continue;
      await prisma.papelPermissao.upsert({
        where: { papelId_permissaoId: { papelId: papel.id, permissaoId } },
        create: { papelId: papel.id, permissaoId },
        update: {},
      });
    }
  }

  const adminPapel = await prisma.papel.findUniqueOrThrow({
    where: { nome: 'ADMINISTRADOR' },
  });

  await definirPermissoes('ADMINISTRADOR', TODAS_PERMISSOES);
  await definirPermissoes('CLIENTE', PERMISSOES_PADRAO_CLIENTE);
  await definirPermissoes('FINANCEIRO', PERMISSOES_PADRAO_FINANCEIRO);
  await definirPermissoes('ANALISTA_MED', PERMISSOES_PADRAO_ANALISTA_MED);
  await definirPermissoes('FUNCIONARIO', PERMISSOES_PADRAO_FUNCIONARIO);

  console.log(
    `Catálogo sincronizado: ${CATALOGO_PERMISSOES.length} recursos, ` +
      `${TODAS_PERMISSOES.length} permissões.`,
  );

  const provedor = await prisma.provedorPagamento.upsert({
    where: { codigo: 'mock' },
    create: {
      codigo: 'mock',
      nome: 'Mock Provider',
      // Em produção nasce INATIVO: provedor inativo não movimenta nada.
      situacao: PRODUCAO ? 'INATIVO' : 'ATIVO',
      /**
       * O default do schema é ESPECIFICOS, que exige uma linha em
       * `liberacoes_adquirente_usuario` por cliente. Como o seed não cria
       * nenhuma, um banco recém-semeado não conseguia gerar UMA cobrança
       * sequer: `PixService.criarCobranca` barrava em `estaLiberada`.
       * Em dev a adquirente de sandbox tem que valer para todo mundo.
       */
      disponibilidadePixEntrada: PRODUCAO
        ? DISPONIBILIDADE_ADQUIRENTE.ESPECIFICOS
        : DISPONIBILIDADE_ADQUIRENTE.TODOS,
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
      // Reexecutar o seed conserta um banco de dev que ficou com a adquirente
      // de sandbox restrita; em produção a escolha do admin é preservada.
      ...(PRODUCAO
        ? {}
        : { disponibilidadePixEntrada: DISPONIBILIDADE_ADQUIRENTE.TODOS }),
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
      credenciaisCriptografadas: encryptCredentialsSeed({ apiKey: 'mock-key' }),
      pixEntradaHabilitado: true,
      pixSaidaHabilitado: true,
      ticketMaximoPixEntrada: '100000.00',
      ticketMaximoPixSaida: '100000.00',
      situacao: 'ATIVO',
    },
    update: {
      situacao: 'ATIVO',
      // Migra contas antigas que ainda tinham JSON em claro.
      credenciaisCriptografadas: encryptCredentialsSeed({ apiKey: 'mock-key' }),
    },
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

  /**
   * Valorion — liquidante REAL. Nasce INATIVA e fechada (ESPECIFICOS): quem
   * liga é o administrador, depois de preencher as chaves `VALORION_*` no
   * `.env` (as credenciais da conta ficam vazias de propósito — o client cai
   * no fallback de env). Cadastrar os IPs de postback da Valorion no admin
   * fecha a Camada 2.
   */
  const valorion = await prisma.provedorPagamento.upsert({
    where: { codigo: 'valorion' },
    create: {
      codigo: 'valorion',
      nome: 'Valorion',
      nomeFantasia: 'Valorion',
      temMed: true,
      situacao: 'INATIVO',
      disponibilidadePixEntrada: DISPONIBILIDADE_ADQUIRENTE.ESPECIFICOS,
      permitePixEntrada: true,
      permitePixSaida: true,
      // A Valorion não manda header de assinatura — Camada 2 é allowlist de
      // IP + token secreto na query do postback (VALORION_WEBHOOK_TOKEN).
      exigeAssinaturaWebhook: false,
    },
    update: {},
  });

  const contaValorion = await prisma.contaProvedor.upsert({
    where: { chaveUnicaConta: 'valorion:GATEWAY:default' },
    create: {
      provedorPagamentoId: valorion.id,
      nome: 'Valorion Gateway Default',
      chaveUnicaConta: 'valorion:GATEWAY:default',
      identificadorContaExterna: 'valorion-default',
      // Vazio de propósito: o client usa os envs VALORION_* como fallback.
      credenciaisCriptografadas: encryptCredentialsSeed({}),
      pixEntradaHabilitado: true,
      pixSaidaHabilitado: true,
      ticketMaximoPixEntrada: '100000.00',
      ticketMaximoPixSaida: '100000.00',
      situacao: 'ATIVO',
    },
    update: {
      credenciaisCriptografadas: encryptCredentialsSeed({}),
    },
  });

  await prisma.custoPixContaProvedor.upsert({
    where: { contaProvedorId: contaValorion.id },
    create: {
      contaProvedorId: contaValorion.id,
      custoPixEntradaPercentual: '0',
      custoPixEntradaFixo: '0',
      custoPixSaidaPercentual: '0',
      custoPixSaidaFixo: '0',
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

  await prisma.parametroRetencaoMetodo.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });

  await prisma.parametroMedAutomatico.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });

  console.log('Seed OK — admin:', adminEmail);

  /**
   * Cliente de teste (somente desenvolvimento). Conta ATIVA com papel CLIENTE,
   * config PIX apontando para a adquirente mock e carteira zerada — suficiente
   * para validar o painel na visão do cliente (incl. /adquirentes).
   */
  if (!PRODUCAO) {
    const clientePapel = await prisma.papel.findUniqueOrThrow({
      where: { nome: 'CLIENTE' },
    });
    const clienteEmail = process.env.CLIENTE_EMAIL ?? 'cliente@vpay.local';
    const clientePassword = process.env.CLIENTE_PASSWORD ?? 'Cliente@123456';
    const clienteSenhaHash = await argon2.hash(clientePassword);
    const padrao = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
      where: { padraoSistema: true },
    });

    const cliente = await prisma.usuario.upsert({
      where: { email: clienteEmail },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '52998224725',
        nomeRazaoSocial: 'Cliente Teste VPay',
        nomeFantasia: 'Cliente Teste',
        cpfResponsavel: '52998224725',
        nomeResponsavel: 'Cliente Teste VPay',
        email: clienteEmail,
        senhaHash: clienteSenhaHash,
        situacao: 'ATIVO',
        temaPreferido: 'PADRAO',
        ativadoEm: new Date(),
      },
      // NÃO reescreve senhaHash (mesmo critério do admin).
      update: { situacao: 'ATIVO' },
    });

    await prisma.usuarioPapel.upsert({
      where: {
        usuarioId_papelId: {
          usuarioId: cliente.id,
          papelId: clientePapel.id,
        },
      },
      create: { usuarioId: cliente.id, papelId: clientePapel.id },
      update: {},
    });

    await prisma.configuracaoPixUsuario.upsert({
      where: { usuarioId: cliente.id },
      create: {
        usuarioId: cliente.id,
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
      update: {
        contaProvedorPixEntradaId: padrao.contaProvedorPixEntradaId,
        contaProvedorPixSaidaId: padrao.contaProvedorPixSaidaId,
      },
    });

    await prisma.saldoUsuario.upsert({
      where: { usuarioId: cliente.id },
      create: { usuarioId: cliente.id },
      update: {},
    });

    console.log('Seed OK — cliente:', clienteEmail, `(senha: ${clientePassword})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
