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

/**
 * Os dois `describe` moram no MESMO arquivo de propósito: ambos mexem na linha
 * `padraoSistema`, que é única no banco. Em arquivos separados o jest os roda em
 * workers paralelos e um escondia a linha enquanto o outro a lia — falha
 * intermitente que não é bug de produto.
 */
/**
 * "Padrão de novos clientes": adquirente de cash-in/cash-out e limites de PIX
 * out.
 *
 * O padrão é o ÚNICO lugar que decide por onde uma conta nova roteia — a
 * ativação copia `contaProvedorPixEntradaId`/`SaidaId` dele. Enquanto o modal
 * não editava esses campos, o roteamento de toda conta nova era o que a
 * primeira gravação tivesse encontrado ("primeira conta apta"), sem forma de
 * corrigir pelo produto; e o ticket de PIX out do padrão nascia zerado porque a
 * tela não mandava os campos.
 *
 * O que este spec trava:
 *  - a vitrine do modal só oferece adquirente APTA (recusar depois seria tarde);
 *  - escolher a adquirente grava a conta correspondente, e não mandar o campo
 *    mantém o roteamento (corpo antigo não pode remanejar sozinho);
 *  - adquirente de vitrine fechada (`ESPECIFICOS`) escolhida como padrão é
 *    LIBERADA para a conta na ativação — senão o cliente nasce roteado para uma
 *    adquirente que a vitrine dele não mostra e a primeira cobrança é recusada.
 */
describe('config-padrao — adquirente e limites de PIX out', () => {
  let prisma: PrismaService;
  let controller: AdminUsuariosController;
  let adminId: bigint;
  let sufixo: string;
  /** Adquirentes criadas por este spec (removidas no final). */
  const criadas: bigint[] = [];
  let aberta: { codigo: string; id: bigint; contaId: bigint };
  let restrita: { codigo: string; id: bigint; contaId: bigint };
  let inativa: { codigo: string; id: bigint; contaId: bigint };

  const CORPO_BASE = {
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

  /**
   * Adquirente própria do spec: o banco de dev tem adquirente de tudo quanto é
   * feitio, e depender de qual sobrou tornaria o teste dependente do ambiente.
   */
  async function criarAdquirente(
    sulfixo: string,
    dados: { situacao: string; disponibilidade: string },
  ) {
    const codigo = `spec_pad_${sulfixo}_${sufixo}`.slice(0, 50);
    const provedor = await prisma.provedorPagamento.create({
      data: {
        codigo,
        nome: `Spec padrão ${sulfixo}`,
        situacao: dados.situacao as never,
        permitePixEntrada: true,
        permitePixSaida: true,
        disponibilidadePixEntrada: dados.disponibilidade as never,
      },
    });
    const conta = await prisma.contaProvedor.create({
      data: {
        provedorPagamentoId: provedor.id,
        nome: 'Conta spec',
        chaveUnicaConta: `${codigo}:conta`,
        credenciaisCriptografadas: '{}',
        pixEntradaHabilitado: true,
        pixSaidaHabilitado: true,
      },
    });
    criadas.push(provedor.id);
    return { codigo, id: provedor.id, contaId: conta.id };
  }

  /** Roda `fn` e devolve o padrão exatamente como estava. */
  async function preservandoPadrao<T>(fn: () => Promise<T>): Promise<T> {
    const antes = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
      where: { padraoSistema: true },
    });
    try {
      return await fn();
    } finally {
      await prisma.configuracaoPadraoPixUsuario.update({
        where: { id: antes.id },
        data: {
          contaProvedorPixEntradaId: antes.contaProvedorPixEntradaId,
          contaProvedorPixSaidaId: antes.contaProvedorPixSaidaId,
          ticketMinimoPixSaida: antes.ticketMinimoPixSaida,
          ticketMaximoPixSaida: antes.ticketMaximoPixSaida,
          limiteDiarioPixSaida: antes.limiteDiarioPixSaida,
          maxSaquesPorHora: antes.maxSaquesPorHora,
          taxaPixEntradaPercentual: antes.taxaPixEntradaPercentual,
          taxaPixEntradaFixa: antes.taxaPixEntradaFixa,
          taxaPixSaidaPercentual: antes.taxaPixSaidaPercentual,
          taxaPixSaidaFixa: antes.taxaPixSaidaFixa,
          ticketMinimoPixEntrada: antes.ticketMinimoPixEntrada,
          ticketMaximoPixEntrada: antes.ticketMaximoPixEntrada,
        },
      });
    }
  }

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService],
    }).compile();
    prisma = modulo.get(PrismaService);
    controller = new AdminUsuariosController(prisma, {
      enqueueEmail: async () => undefined,
    } as unknown as QueuesService);

    sufixo = String(Date.now()).slice(-9);
    const admin = await prisma.usuario.create({
      data: {
        tipoPessoa: 'PF',
        cpfCnpj: `6${sufixo}`.slice(0, 11).padEnd(11, '0'),
        nomeRazaoSocial: 'Admin adquirente padrão',
        email: `admin-adq-${sufixo}@teste.local`,
        senhaHash: 'x',
        situacao: SITUACAO_USUARIO.ATIVO,
      },
    });
    adminId = admin.id;

    aberta = await criarAdquirente('aberta', {
      situacao: 'ATIVO',
      disponibilidade: 'TODOS',
    });
    restrita = await criarAdquirente('restrita', {
      situacao: 'ATIVO',
      disponibilidade: 'ESPECIFICOS',
    });
    // Conta ATIVA de adquirente INATIVA: o caso que o filtro precisa barrar.
    inativa = await criarAdquirente('inativa', {
      situacao: 'INATIVO',
      disponibilidade: 'TODOS',
    });
  });

  afterAll(async () => {
    // O banco de teste é compartilhado e o jest roda os arquivos em paralelo:
    // enquanto o padrão apontava para a adquirente deste spec, uma ativação de
    // OUTRO spec pode ter copiado essa conta para a configuração do cliente
    // dela. Sem devolver essas configs ao padrão real, o `deleteMany` abaixo
    // morre em foreign key e derruba a suíte inteira por tabela de teste.
    const padrao = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
      where: { padraoSistema: true },
    });
    const contas = [aberta.contaId, restrita.contaId, inativa.contaId];
    await prisma.configuracaoPixUsuario.updateMany({
      where: { contaProvedorPixEntradaId: { in: contas } },
      data: { contaProvedorPixEntradaId: padrao.contaProvedorPixEntradaId },
    });
    await prisma.configuracaoPixUsuario.updateMany({
      where: { contaProvedorPixSaidaId: { in: contas } },
      data: { contaProvedorPixSaidaId: padrao.contaProvedorPixSaidaId },
    });
    await prisma.contaProvedor.deleteMany({
      where: { provedorPagamentoId: { in: criadas } },
    });
    await prisma.provedorPagamento.deleteMany({ where: { id: { in: criadas } } });
    await prisma.$disconnect();
  });

  it('GET devolve a adquirente em uso e só oferece adquirente APTA', async () => {
    const r = await controller.configPadrao();
    const entrada = r.adquirentesEntrada;
    const saida = r.adquirentesSaida;

    expect(typeof r.adquirenteEntrada).toBe('string');
    expect(typeof r.adquirenteSaida).toBe('string');
    // Adquirente INATIVA não entra na vitrine do modal nem com conta ativa.
    expect(entrada.some((a) => a.codigo === inativa.codigo)).toBe(false);
    expect(saida.some((a) => a.codigo === inativa.codigo)).toBe(false);
    expect(entrada.some((a) => a.codigo === aberta.codigo)).toBe(true);

    // `restrita` é conceito de vitrine de PIX in — cash-out não tem vitrine.
    expect(entrada.find((a) => a.codigo === restrita.codigo)?.restrita).toBe(true);
    expect(entrada.find((a) => a.codigo === aberta.codigo)?.restrita).toBe(false);
    expect(saida.find((a) => a.codigo === restrita.codigo)?.restrita).toBe(false);

    // Uma adquirente aparece UMA vez, mesmo tendo várias contas aptas.
    const codigos = entrada.map((a) => a.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
  });

  it('grava a adquirente escolhida em cada sentido', async () => {
    await preservandoPadrao(async () => {
      await controller.editarConfigPadrao(
        {
          ...CORPO_BASE,
          adquirenteEntrada: aberta.codigo,
          adquirenteSaida: restrita.codigo,
        },
        { user: { id: adminId.toString() } },
      );
      const depois = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
        where: { padraoSistema: true },
      });
      expect(depois.contaProvedorPixEntradaId).toBe(aberta.contaId);
      expect(depois.contaProvedorPixSaidaId).toBe(restrita.contaId);
    });
  });

  it('corpo SEM adquirente mantém o roteamento gravado', async () => {
    await preservandoPadrao(async () => {
      const antes = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
        where: { padraoSistema: true },
      });
      await controller.editarConfigPadrao(
        { ...CORPO_BASE, taxaPixEntradaPercentual: '3' },
        { user: { id: adminId.toString() } },
      );
      const depois = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
        where: { padraoSistema: true },
      });
      expect(depois.contaProvedorPixEntradaId).toBe(antes.contaProvedorPixEntradaId);
      expect(depois.contaProvedorPixSaidaId).toBe(antes.contaProvedorPixSaidaId);
    });
  });

  it('recusa adquirente inapta em vez de gravar roteamento quebrado', async () => {
    await expect(
      controller.editarConfigPadrao(
        { ...CORPO_BASE, adquirenteEntrada: inativa.codigo },
        { user: { id: adminId.toString() } },
      ),
    ).rejects.toThrow(/não está apta/i);
    await expect(
      controller.editarConfigPadrao(
        { ...CORPO_BASE, adquirenteSaida: 'nao_existe' },
        { user: { id: adminId.toString() } },
      ),
    ).rejects.toThrow(/não está apta/i);
  });

  it('grava o ticket de PIX out do padrão — vazio = sem teto', async () => {
    await preservandoPadrao(async () => {
      await controller.editarConfigPadrao(
        {
          ...CORPO_BASE,
          ticketMinimoPixSaida: '5',
          ticketMaximoPixSaida: '900',
          limiteDiarioPixSaida: '5000',
          maxSaquesPorHora: '3',
        },
        { user: { id: adminId.toString() } },
      );
      const comTeto = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
        where: { padraoSistema: true },
      });
      expect(comTeto.ticketMinimoPixSaida.toString()).toBe('5');
      expect(comTeto.ticketMaximoPixSaida?.toString()).toBe('900');
      expect(comTeto.limiteDiarioPixSaida?.toString()).toBe('5000');
      expect(comTeto.maxSaquesPorHora).toBe(3);

      await controller.editarConfigPadrao(
        {
          ...CORPO_BASE,
          ticketMinimoPixSaida: '0',
          ticketMaximoPixSaida: '',
          limiteDiarioPixSaida: '',
          maxSaquesPorHora: '',
        },
        { user: { id: adminId.toString() } },
      );
      const semTeto = await prisma.configuracaoPadraoPixUsuario.findFirstOrThrow({
        where: { padraoSistema: true },
      });
      expect(semTeto.ticketMaximoPixSaida).toBeNull();
      expect(semTeto.limiteDiarioPixSaida).toBeNull();
      expect(semTeto.maxSaquesPorHora).toBeNull();

      const r = (await controller.configPadrao()) as Record<string, unknown>;
      expect(r.ticketMinimoPixSaida).toBe('0');
      expect(r.ticketMaximoPixSaida).toBe('');
    });
  });

  it('ativação LIBERA a adquirente de vitrine fechada apontada pelo padrão', async () => {
    await preservandoPadrao(async () => {
      await controller.editarConfigPadrao(
        { ...CORPO_BASE, adquirenteEntrada: restrita.codigo },
        { user: { id: adminId.toString() } },
      );

      const cliente = await prisma.usuario.create({
        data: {
          tipoPessoa: 'PF',
          cpfCnpj: `5${sufixo}`.slice(0, 11).padEnd(11, '0'),
          nomeRazaoSocial: 'Cliente vitrine fechada',
          email: `cliente-adq-${sufixo}@teste.local`,
          senhaHash: 'x',
          situacao: SITUACAO_USUARIO.EM_ANALISE,
        },
      });
      try {
        // KYC não é o assunto aqui: a exceção documentada evita montar a
        // papelada só para chegar na ativação.
        await controller.ativar(
          cliente.idPublico,
          {
            codigoTotp: '000000',
            semDocumentacao: true,
            justificativa: 'Spec de roteamento padrão — sem KYC.',
          },
          { user: { id: adminId.toString() } },
        );

        const cfg = await prisma.configuracaoPixUsuario.findUniqueOrThrow({
          where: { usuarioId: cliente.id },
        });
        expect(cfg.contaProvedorPixEntradaId).toBe(restrita.contaId);

        const liberacao = await prisma.liberacaoAdquirenteUsuario.findUnique({
          where: {
            provedorPagamentoId_usuarioId: {
              provedorPagamentoId: restrita.id,
              usuarioId: cliente.id,
            },
          },
        });
        expect(liberacao).not.toBeNull();
      } finally {
        // Só o que amarra o cliente às adquirentes do spec sai: as contas do
        // `afterAll` não são removíveis enquanto a config apontar para elas. O
        // usuário fica (como nos outros specs de ativação) porque
        // `registros_auditoria` é APPEND-ONLY e trava a exclusão em cascata.
        await prisma.liberacaoAdquirenteUsuario.deleteMany({
          where: { usuarioId: cliente.id },
        });
        await prisma.configuracaoPixUsuario.deleteMany({
          where: { usuarioId: cliente.id },
        });
      }
    });
  });
});
