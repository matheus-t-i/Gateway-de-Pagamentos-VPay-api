import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { encryptCredentials } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigPixService, LedgerService } from '../ledger/ledger.service';
import { PixService } from './pix.service';
import { assertSaqueViaApiPermitido } from '../api-credentials/api-token.guard';
import { ESCOPOS_API, SITUACAO_CHAVE_PIX, SITUACAO_PROVEDOR } from '../shared';

/**
 * Regra de produto (dono):
 * - Painel: NUNCA chave livre — sempre cadastrada/APROVADA.
 * - API (BAAS): chave livre só se `exigirChavePixCadastrada = false` E a
 *   credencial tiver IP allowlist (assertSaqueViaApiPermitido).
 */
describe('Saque — chave cadastrada vs chave livre (API BAAS)', () => {
  let prisma: PrismaService;
  let pix: PixService;
  let usuarioId: bigint;
  let contaId: bigint;
  let sufixo: string;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
      providers: [PrismaService, LedgerService, ConfigPixService],
    }).compile();

    prisma = modulo.get(PrismaService);
    await prisma.$connect();

    pix = new PixService(
      prisma,
      modulo.get(ConfigPixService),
      modulo.get(LedgerService),
      {} as never,
      {
        enqueuePixCashOut: () => Promise.resolve(),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        assertSaquePermitido: async () => undefined,
        registrarRecusaSaque: async () => undefined,
      } as never,
    );

    sufixo = `${Date.now()}`;

    const usuario = await prisma.usuario.upsert({
      where: { email: 'saque-chave-livre@vpay.local' },
      create: {
        tipoPessoa: 'PF',
        cpfCnpj: '22222222225',
        nomeRazaoSocial: 'Saque Chave Livre Test',
        email: 'saque-chave-livre@vpay.local',
        senhaHash: 'x',
        situacao: 'ATIVO',
      },
      update: { situacao: 'ATIVO' },
    });
    usuarioId = usuario.id;

    const provedor = await prisma.provedorPagamento.upsert({
      where: { codigo: 'teste_chave_livre' },
      create: {
        codigo: 'teste_chave_livre',
        nome: 'Adquirente teste chave livre',
        permitePixEntrada: true,
        permitePixSaida: true,
        situacao: SITUACAO_PROVEDOR.ATIVO,
      },
      update: { situacao: SITUACAO_PROVEDOR.ATIVO },
    });

    const contaExistente = await prisma.contaProvedor.findFirst({
      where: { provedorPagamentoId: provedor.id, usuarioId: null },
    });
    const conta =
      contaExistente ??
      (await prisma.contaProvedor.create({
        data: {
          provedorPagamentoId: provedor.id,
          nome: 'Conta teste chave livre',
          chaveUnicaConta: 'teste_chave_livre:conta-principal',
          credenciaisCriptografadas: encryptCredentials({}),
          pixEntradaHabilitado: true,
          pixSaidaHabilitado: true,
          situacao: SITUACAO_PROVEDOR.ATIVO,
          ticketMaximoPixEntrada: '100000',
        },
      }));
    contaId = conta.id;

    await prisma.saldoUsuario.upsert({
      where: { usuarioId },
      create: { usuarioId, saldoDisponivel: '5000.00' },
      update: { saldoDisponivel: '5000.00' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function configurar(params: {
    origem: 'PAINEL' | 'API' | 'AMBOS';
    exigirChave: boolean;
  }) {
    await prisma.configuracaoPixUsuario.upsert({
      where: { usuarioId },
      create: {
        usuarioId,
        contaProvedorPixEntradaId: contaId,
        contaProvedorPixSaidaId: contaId,
        ticketMaximoPixEntrada: '100000',
        ticketMinimoPixSaida: '0',
        taxaPixSaidaPercentual: '0',
        taxaPixSaidaFixa: '0',
        origemSaquePermitida: params.origem,
        exigirChavePixCadastrada: params.exigirChave,
      },
      update: {
        contaProvedorPixSaidaId: contaId,
        ticketMinimoPixSaida: '0',
        taxaPixSaidaPercentual: '0',
        taxaPixSaidaFixa: '0',
        origemSaquePermitida: params.origem,
        exigirChavePixCadastrada: params.exigirChave,
      },
    });
  }

  const inputChaveLivre = (ref: string) =>
    ({
      valor: '10.00',
      chavePix: `livre-${sufixo}@destino.baas`,
      tipoChavePix: 'EMAIL',
      nomeBeneficiario: 'Cliente Final BAAS',
      documentoBeneficiario: '33333333334',
      referenciaExterna: ref,
    }) as never;

  it('(a) painel rejeita chave livre mesmo com flag BAAS ligada', async () => {
    await configurar({ origem: 'AMBOS', exigirChave: false });

    await expect(
      pix.criarSaque({
        usuarioId,
        // sem credencialApiId = origem painel
        input: inputChaveLivre(`painel-livre-${sufixo}`),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('(b) API com flag livre aceita chave não cadastrada', async () => {
    await configurar({ origem: 'AMBOS', exigirChave: false });

    const r = await pix.criarSaque({
      usuarioId,
      credencialApiId: 1n, // só marca origem API; IP é do guard
      input: inputChaveLivre(`api-livre-ok-${sufixo}`),
    });
    expect(r.idInterno).toBeTruthy();
  });

  it('(c) API sem IP allowlist na credencial é recusada pelo guard', () => {
    expect(() =>
      assertSaqueViaApiPermitido({
        escopos: [ESCOPOS_API.PIX_SAQUE_CRIAR],
        temIpAllowlist: false,
      }),
    ).toThrow(ForbiddenException);

    expect(() =>
      assertSaqueViaApiPermitido({
        escopos: [ESCOPOS_API.PIX_SAQUE_CRIAR],
        temIpAllowlist: true,
      }),
    ).not.toThrow();
  });

  it('(d) API com exigir cadastrada rejeita chave não cadastrada', async () => {
    await configurar({ origem: 'AMBOS', exigirChave: true });

    await expect(
      pix.criarSaque({
        usuarioId,
        credencialApiId: 1n,
        input: inputChaveLivre(`api-exige-${sufixo}`),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('API com exigir cadastrada aceita chave APROVADA da conta', async () => {
    await configurar({ origem: 'AMBOS', exigirChave: true });
    const chave = `aprovada-${sufixo}@vpay.local`;
    await prisma.chavePixUsuario.upsert({
      where: { usuarioId_chave: { usuarioId, chave } },
      create: {
        usuarioId,
        chave,
        tipoChave: 'EMAIL',
        situacao: SITUACAO_CHAVE_PIX.APROVADA,
        nomeTitular: 'Titular OK',
        documentoTitular: '22222222225',
      },
      update: { situacao: SITUACAO_CHAVE_PIX.APROVADA },
    });

    const r = await pix.criarSaque({
      usuarioId,
      credencialApiId: 1n,
      input: {
        valor: '10.00',
        chavePix: chave,
        tipoChavePix: 'EMAIL',
        nomeBeneficiario: 'Titular OK',
        documentoBeneficiario: '22222222225',
        referenciaExterna: `api-aprovada-${sufixo}`,
      } as never,
    });
    expect(r.idInterno).toBeTruthy();
  });
});
