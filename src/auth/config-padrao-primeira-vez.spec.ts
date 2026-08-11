import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { AdminUsuariosController } from './admin-usuarios.controller';
import { SITUACAO_USUARIO } from '../shared';

/** Step-up mockado pelo mesmo motivo de ativar-sem-documentacao.spec.ts. */
jest.mock('../common/step-up-totp', () => {
  const { z } = jest.requireActual('zod') as typeof import('zod');
  return {
    stepUpBodySchema: z.object({ codigoTotp: z.string().regex(/^\d{6}$/) }),
    codigoTotpField: z.string().regex(/^\d{6}$/),
    assertStepUpTotp: jest.fn(async () => undefined),
    assertStepUpFromBody: jest.fn(async () => undefined),
  };
});

/**
 * Primeira configuração do "Padrão de novos clientes".
 *
 * Instalação nova não roda seed (regra de produção), então a linha
 * `padraoSistema` NÃO existe até o admin gravá-la. O GET devolvia 404 e a tela
 * ficava travada exatamente na primeira vez que era necessária; o PUT também
 * dava 404, ou seja, não havia caminho pelo produto para criar o padrão.
 *
 * Contrato coberto aqui: GET sem linha → 200 com defaults e
 * `primeiraConfiguracao: true`; PUT sem linha → CRIA a linha (upsert) apontando
 * para a primeira conta apta de adquirente ativa.
 *
 * O spec roda no banco de dev, onde o seed JÁ criou a linha: cada caso esconde
 * a linha real (flag/nome) num try/finally que restaura sempre — inclusive o
 * PUT, cujo upsert por nome devolve `padraoSistema: true` sozinho.
 */
describe('config-padrao — primeira configuração', () => {
  let prisma: PrismaService;
  let controller: AdminUsuariosController;
  let adminId: bigint;

  const CORPO_VALIDO = {
    codigoTotp: '000000',
    taxaPixEntradaPercentual: '2',
    taxaPixEntradaFixa: '0.5',
    taxaPixSaidaPercentual: '1',
    taxaPixSaidaFixa: '1',
    ticketMinimoPixEntrada: '1',
    ticketMaximoPixEntrada: '10000',
    diasLiberacaoSaldo: '0',
    percentualReserva: '0',
    diasRetencaoReserva: '0',
    baseCalculoReserva: 'VALOR_LIQUIDO_EMPRESA',
    modoTratamentoMed: 'BLOQUEAR_SALDO',
    permiteSaldoNegativo: 'false',
    origemSaquePermitida: 'PAINEL',
    exigirChavePixCadastrada: 'true',
  };

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService],
    }).compile();
    prisma = modulo.get(PrismaService);
    controller = new AdminUsuariosController(prisma, {
      enqueueEmail: async () => undefined,
    } as unknown as QueuesService);

    const sufixo = String(Date.now()).slice(-9);
    const admin = await prisma.usuario.create({
      data: {
        tipoPessoa: 'PF',
        cpfCnpj: `7${sufixo}`.slice(0, 11).padEnd(11, '0'),
        nomeRazaoSocial: 'Admin config padrão',
        email: `admin-config-${sufixo}@teste.local`,
        senhaHash: 'x',
        situacao: SITUACAO_USUARIO.ATIVO,
      },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Esconde a linha do padrão durante `fn` e SEMPRE a restaura. */
  async function semLinhaPadrao<T>(fn: () => Promise<T>): Promise<T> {
    const linha = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
      where: { padraoSistema: true },
    });
    const nomeOculto = `__spec_oculta_${Date.now()}`;
    await prisma.configuracaoPadraoPixUsuario.update({
      where: { id: linha.id },
      data: { padraoSistema: false, nome: nomeOculto },
    });
    try {
      return await fn();
    } finally {
      // Se o PUT criou uma linha nova, ela sai antes de devolver a original.
      await prisma.configuracaoPadraoPixUsuario.deleteMany({
        where: { padraoSistema: true, id: { not: linha.id } },
      });
      await prisma.configuracaoPadraoPixUsuario.update({
        where: { id: linha.id },
        data: { padraoSistema: true, nome: linha.nome },
      });
    }
  }

  it('GET sem linha devolve defaults com primeiraConfiguracao, não 404', async () => {
    await semLinhaPadrao(async () => {
      const r = (await controller.configPadrao()) as Record<string, unknown>;
      expect(r.primeiraConfiguracao).toBe(true);
      expect(r.modoTratamentoMed).toBe('BLOQUEAR_SALDO');
    });
  });

  it('GET com linha continua devolvendo a configuração real', async () => {
    const r = (await controller.configPadrao()) as Record<string, unknown>;
    expect(r.primeiraConfiguracao).toBe(false);
  });

  it('PUT sem linha CRIA o padrão apontando para conta apta de adquirente ativa', async () => {
    await semLinhaPadrao(async () => {
      const r = await controller.editarConfigPadrao(CORPO_VALIDO, {
        user: { id: adminId.toString() },
      });
      expect(r).toMatchObject({ ok: true, criada: true });

      const criada = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
        where: { padraoSistema: true },
      });
      expect(criada.ativo).toBe(true);
      expect(criada.taxaPixEntradaPercentual.toString()).toBe('2');
      expect(criada.contaProvedorPixEntradaId).toBeDefined();
      expect(criada.contaProvedorPixSaidaId).toBeDefined();

      // A criação deixa rastro próprio na auditoria.
      const auditoria = await prisma.registroAuditoria.findFirst({
        where: {
          acao: 'CONFIG_PADRAO_CLIENTE_CRIAR',
          chaveRegistro: criada.id.toString(),
        },
      });
      expect(auditoria).not.toBeNull();
    });
  });

  it('PUT com linha existente continua sendo edição (sem criar segunda linha)', async () => {
    const antes = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
      where: { padraoSistema: true },
    });
    const taxaOriginal = antes.taxaPixEntradaPercentual.toString();
    try {
      const r = await controller.editarConfigPadrao(
        { ...CORPO_VALIDO, taxaPixEntradaPercentual: '3.21' },
        { user: { id: adminId.toString() } },
      );
      expect(r).toMatchObject({ ok: true });
      const linhas = await prisma.configuracaoPadraoPixUsuario.count({
        where: { padraoSistema: true },
      });
      expect(linhas).toBe(1);
      const depois = await prisma.configuracaoPadraoPixUsuario.findUniqueOrThrow({
        where: { id: antes.id },
      });
      expect(depois.taxaPixEntradaPercentual.toString()).toBe('3.21');
    } finally {
      await prisma.configuracaoPadraoPixUsuario.update({
        where: { id: antes.id },
        data: { taxaPixEntradaPercentual: taxaOriginal },
      });
    }
  });
});
