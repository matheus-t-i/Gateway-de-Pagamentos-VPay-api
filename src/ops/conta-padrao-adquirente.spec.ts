import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { AdquirentesService } from '../providers/adquirentes.service';
import { ReenvioWebhookService } from '../queues/reenvio-webhook.service';
import { AdminOpsController } from './ops.controller';
import { SITUACAO_PROVEDOR, SITUACAO_USUARIO } from '../shared';

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
 * A CONTA padrão da adquirente (`<codigo>:default`) nasce e se recupera pelo
 * painel.
 *
 * Nenhum outro fluxo do produto cria `contas_provedor` — o cadastro de
 * adquirente criava só o provedor, e uma instalação sem seed (produção) ficava
 * com adquirente ATIVA na tela mas sem conta por baixo: o roteamento e o
 * "Padrão de novos clientes" não tinham onde se pendurar (aconteceu em
 * produção, com o PUT do padrão respondendo "cadastre uma adquirente" para
 * quem estava OLHANDO para a adquirente cadastrada).
 *
 * Contrato: criar adquirente cria a conta padrão junto; SALVAR a edição de uma
 * adquirente antiga recria a conta que falta; conta existente nunca é tocada.
 */
describe('conta padrão da adquirente', () => {
  let prisma: PrismaService;
  let controller: AdminOpsController;
  let adminId: bigint;
  const criados: string[] = [];

  const req = () => ({ user: { id: adminId.toString(), papeis: ['ADMINISTRADOR'] } });
  const totp = '000000';

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService],
    }).compile();
    prisma = modulo.get(PrismaService);
    // Só criarAdquirente/editarAdquirente entram neste spec — ambos usam
    // apenas o prisma; os demais serviços do construtor viram stubs.
    controller = new AdminOpsController(
      prisma,
      {} as unknown as QueuesService,
      {} as unknown as AdquirentesService,
      {} as unknown as ReenvioWebhookService,
      {} as never,
      {} as never,
      {} as never,
    );

    const sufixo = String(Date.now()).slice(-9);
    const admin = await prisma.usuario.create({
      data: {
        tipoPessoa: 'PF',
        cpfCnpj: `6${sufixo}`.slice(0, 11).padEnd(11, '0'),
        nomeRazaoSocial: 'Admin conta padrão',
        email: `admin-conta-${sufixo}@teste.local`,
        senhaHash: 'x',
        situacao: SITUACAO_USUARIO.ATIVO,
      },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    for (const codigo of criados) {
      await prisma.contaProvedor.deleteMany({
        where: { provedor: { codigo } },
      });
      await prisma.provedorPagamento.deleteMany({ where: { codigo } });
    }
    await prisma.$disconnect();
  });

  function novoCodigo(prefixo: string) {
    const codigo = `${prefixo}_${String(Date.now()).slice(-8)}`;
    criados.push(codigo);
    return codigo;
  }

  it('criar adquirente cria a conta padrão junto', async () => {
    const codigo = novoCodigo('spec_cria');
    await controller.criarAdquirente(
      { codigo, nome: 'Spec Cria', permitePixEntrada: true, codigoTotp: totp },
      req(),
    );

    const conta = await prisma.contaProvedor.findUniqueOrThrow({
      where: { chaveUnicaConta: `${codigo}:default` },
    });
    expect(conta.situacao).toBe(SITUACAO_PROVEDOR.ATIVO);
    expect(conta.pixEntradaHabilitado).toBe(true);
    expect(conta.pixSaidaHabilitado).toBe(true);
  });

  it('salvar a edição RECRIA a conta de adquirente antiga sem conta', async () => {
    const codigo = novoCodigo('spec_cura');
    // O estado de produção: provedor criado sem conta nenhuma.
    await prisma.provedorPagamento.create({
      data: {
        codigo,
        nome: 'Spec Cura',
        situacao: SITUACAO_PROVEDOR.ATIVO,
        permitePixEntrada: true,
        permitePixSaida: true,
      },
    });
    expect(
      await prisma.contaProvedor.count({ where: { provedor: { codigo } } }),
    ).toBe(0);

    await controller.editarAdquirente(codigo, { codigoTotp: totp }, req());

    const conta = await prisma.contaProvedor.findUniqueOrThrow({
      where: { chaveUnicaConta: `${codigo}:default` },
    });
    expect(conta.pixEntradaHabilitado).toBe(true);
    expect(conta.situacao).toBe(SITUACAO_PROVEDOR.ATIVO);
  });

  it('conta padrão existente não é tocada ao salvar de novo', async () => {
    const codigo = novoCodigo('spec_nao_toca');
    await controller.criarAdquirente(
      { codigo, nome: 'Spec Não Toca', codigoTotp: totp },
      req(),
    );
    // O admin desabilitou a saída na conta (estado deliberado)…
    await prisma.contaProvedor.update({
      where: { chaveUnicaConta: `${codigo}:default` },
      data: { pixSaidaHabilitado: false },
    });

    await controller.editarAdquirente(codigo, { codigoTotp: totp }, req());

    // …e salvar a adquirente não pode reverter isso.
    const conta = await prisma.contaProvedor.findUniqueOrThrow({
      where: { chaveUnicaConta: `${codigo}:default` },
    });
    expect(conta.pixSaidaHabilitado).toBe(false);
  });
});
