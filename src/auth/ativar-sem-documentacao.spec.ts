import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { AdminUsuariosController } from './admin-usuarios.controller';
import { reavaliarSituacoes } from '../onboarding/onboarding.util';
import { SITUACAO_USUARIO } from '../shared';

/**
 * Step-up 2FA neutralizado: o objeto deste spec é o gate de KYC, não o TOTP
 * (compartilhado por dezenas de rotas e com cobertura própria).
 *
 * Mock TOTAL, sem `requireActual`: `step-up-totp` importa `validarTotp` do
 * `totp.controller`, que puxa `otplib` → `@scure/base`, que é ESM puro e não
 * passa pelo transform do jest. Carregar o módulo real aqui derruba a suíte
 * antes do primeiro teste. Em troca, `stepUpBodySchema` é reconstruído abaixo —
 * se o schema real ganhar campo obrigatório, este mock precisa acompanhar.
 */
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
 * Ativar conta SEM a documentação de KYC é EXCEÇÃO, não caminho alternativo.
 *
 * O padrão continua sendo o bloqueio: sem `semDocumentacao`, cadastro com
 * documento faltando não ativa — é a mesma trava que impedia um PJ de virar
 * ATIVO só com os documentos pessoais do responsável.
 *
 * Quando a exceção é usada, o que este spec trava é o RASTRO: sem justificativa
 * não passa, e a ativação tem que deixar (a) o motivo no histórico da conta e
 * (b) um `registro_auditoria` com ação própria e a lista do que faltava. Sem
 * isso a ativação por exceção fica indistinguível da normal, e a pergunta "por
 * que esta conta está ativa sem KYC?" deixa de ter resposta.
 */
describe('ativar usuário — exceção de KYC', () => {
  let prisma: PrismaService;
  let controller: AdminUsuariosController;
  let adminId: bigint;
  let sufixo: string;

  /** Código qualquer: o step-up está mockado (ver o mock no topo). */
  const totp = () => '000000';

  async function criarAdmin() {
    const admin = await prisma.usuario.create({
      data: {
        tipoPessoa: 'PF',
        cpfCnpj: `9${sufixo}`.slice(0, 11).padEnd(11, '0'),
        nomeRazaoSocial: 'Admin do teste',
        email: `admin-kyc-${sufixo}@teste.local`,
        senhaHash: 'x',
        situacao: SITUACAO_USUARIO.ATIVO,
      },
    });
    return admin.id;
  }

  /**
   * Cadastro sem NENHUM documento — o caso que motivou a exceção.
   * `seq` mantém cpf/e-mail únicos: os dois têm unique e cada teste cria o seu.
   */
  let seq = 0;
  async function criarCadastroSemDocumentos(situacao: string) {
    seq += 1;
    return prisma.usuario.create({
      data: {
        tipoPessoa: 'PF',
        cpfCnpj: `8${seq}${sufixo}`.slice(0, 11).padEnd(11, '0'),
        nomeRazaoSocial: 'Cliente sem documento',
        email: `cliente-kyc-${seq}-${sufixo}@teste.local`,
        senhaHash: 'x',
        situacao: situacao as never,
      },
    });
  }

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService],
    }).compile();
    prisma = modulo.get(PrismaService);

    /**
     * Instanciado à mão, não pelo container: o controller declara
     * `@UseGuards(JwtAuthGuard)` e o Nest tentaria construir o guard (e o
     * `JwtService` inteiro) só para compilar o módulo. Aqui os métodos são
     * chamados direto — autorização é assunto do guard, não deste spec.
     * A fila só recebe o e-mail de boas-vindas; stub basta.
     */
    controller = new AdminUsuariosController(prisma, {
      enqueueEmail: async () => undefined,
    } as unknown as QueuesService);

    sufixo = String(Date.now()).slice(-9);
    adminId = await criarAdmin();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('SEM a flag, cadastro sem documentação continua BLOQUEADO', async () => {
    const alvo = await criarCadastroSemDocumentos(SITUACAO_USUARIO.EM_ANALISE);

    await expect(
      controller.ativar(
        alvo.idPublico,
        { codigoTotp: totp() },
        { user: { id: adminId.toString() } },
      ),
    ).rejects.toThrow(/Documentação incompleta/i);

    const depois = await prisma.usuario.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(depois.situacao).toBe(SITUACAO_USUARIO.EM_ANALISE);
  });

  it('a exceção SEM justificativa é recusada', async () => {
    const alvo = await criarCadastroSemDocumentos(SITUACAO_USUARIO.PENDENTE);

    await expect(
      controller.ativar(
        alvo.idPublico,
        { codigoTotp: totp(), semDocumentacao: true },
        { user: { id: adminId.toString() } },
      ),
    ).rejects.toThrow(/justificativa/i);

    const depois = await prisma.usuario.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(depois.situacao).toBe(SITUACAO_USUARIO.PENDENTE);
  });

  it('com justificativa ativa a conta e deixa rastro em auditoria e histórico', async () => {
    // PENDENTE: o cliente nunca chegou a enviar nada. É o caso em que o botão
    // de aprovação normal nem aparece.
    const alvo = await criarCadastroSemDocumentos(SITUACAO_USUARIO.PENDENTE);
    const justificativa = 'Documentacao recebida por e-mail, sera anexada pela VPay';

    await controller.ativar(
      alvo.idPublico,
      { codigoTotp: totp(), semDocumentacao: true, justificativa },
      { user: { id: adminId.toString() }, ip: '203.0.113.7' },
    );

    const depois = await prisma.usuario.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(depois.situacao).toBe(SITUACAO_USUARIO.ATIVO);

    const auditoria = await prisma.registroAuditoria.findFirst({
      where: {
        acao: 'USUARIO_ATIVAR_SEM_DOCUMENTACAO',
        usuarioAfetadoId: alvo.id,
      },
    });
    expect(auditoria).not.toBeNull();
    expect(auditoria?.usuarioAtorId).toBe(adminId);
    // O que faltava fica gravado: é isso que responde "sem qual documento?".
    expect(
      (auditoria?.dadosAnteriores as { documentosFaltantes?: string[] })
        ?.documentosFaltantes,
    ).toEqual(
      expect.arrayContaining(['RG_CNH_FRENTE', 'RG_CNH_VERSO', 'SELFIE_COM_DOCUMENTO']),
    );
    expect(
      (auditoria?.dadosNovos as { justificativa?: string })?.justificativa,
    ).toBe(justificativa);

    const historico = await prisma.historicoSituacaoUsuario.findFirst({
      where: { usuarioId: alvo.id, novaSituacao: SITUACAO_USUARIO.ATIVO },
    });
    expect(historico?.motivo).toContain('SEM DOCUMENTAÇÃO');
    expect(historico?.motivo).toContain(justificativa);
  });

  /**
   * O outro meio do fluxo: a VPay sobe a documentação que faltava. A conta tem
   * que sair de PENDENTE para EM_ANALISE — senão o botão de aprovação NORMAL
   * (que só existe em EM_ANALISE) nunca aparece e o admin fica obrigado a usar
   * a exceção de KYC mesmo tendo todos os documentos em mãos.
   */
  it('documentação completa tira a conta de PENDENTE, sem precisar de exceção', async () => {
    const alvo = await criarCadastroSemDocumentos(SITUACAO_USUARIO.PENDENTE);

    for (const tipo of ['RG_CNH_FRENTE', 'RG_CNH_VERSO', 'SELFIE_COM_DOCUMENTO']) {
      await prisma.documentoUsuario.create({
        data: {
          usuarioId: alvo.id,
          tipoDocumento: tipo as never,
          nomeArquivo: `${tipo}.png`,
          caminhoArquivo: `/tmp/${tipo}.png`,
          tipoMime: 'image/png',
          tamanhoBytes: BigInt(1024),
          hashArquivo: 'x',
          situacao: 'VALIDO' as never,
        },
      });
    }
    await prisma.$transaction((tx) => reavaliarSituacoes(tx, alvo.id));

    const reavaliado = await prisma.usuario.findUniqueOrThrow({
      where: { id: alvo.id },
    });
    expect(reavaliado.situacao).toBe(SITUACAO_USUARIO.EM_ANALISE);

    // E agora a aprovação NORMAL passa — sem flag, sem justificativa.
    await controller.ativar(
      alvo.idPublico,
      { codigoTotp: totp() },
      { user: { id: adminId.toString() } },
    );
    const ativo = await prisma.usuario.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(ativo.situacao).toBe(SITUACAO_USUARIO.ATIVO);
  });

  it('a exceção NÃO ressuscita cadastro reprovado', async () => {
    // A exceção é sobre KYC, não sobre desfazer decisão anterior.
    const alvo = await criarCadastroSemDocumentos(SITUACAO_USUARIO.REPROVADO);

    await expect(
      controller.ativar(
        alvo.idPublico,
        {
          codigoTotp: totp(),
          semDocumentacao: true,
          justificativa: 'tentativa de reativar cadastro reprovado',
        },
        { user: { id: adminId.toString() } },
      ),
    ).rejects.toThrow(/não está em análise/i);
  });
});
