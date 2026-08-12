import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { AdminUsuariosController } from './admin-usuarios.controller';
import { SITUACAO_USUARIO } from '../shared';

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
 * Admin corrige ficha cadastral (nome, documento, endereço). E-mail é o
 * identificador único — mesmo se o body mandar outro, a conta não troca.
 */
describe('editar dados cadastrais (admin)', () => {
  let prisma: PrismaService;
  let controller: AdminUsuariosController;
  let adminId: bigint;
  let sufixo: string;
  let seq = 0;

  const totp = () => '000000';

  const endereco = {
    cep: '01310100',
    logradouro: 'Avenida Paulista',
    numero: '1000',
    bairro: 'Bela Vista',
    cidade: 'São Paulo',
    uf: 'SP',
  };

  async function criarUsuario(extra?: {
    cpfCnpj?: string;
    email?: string;
    tipoPessoa?: 'PF' | 'PJ';
  }) {
    seq += 1;
    return prisma.usuario.create({
      data: {
        tipoPessoa: extra?.tipoPessoa ?? 'PF',
        cpfCnpj: extra?.cpfCnpj ?? `7${seq}${sufixo}`.slice(0, 11).padEnd(11, '0'),
        nomeRazaoSocial: 'Nome Errado',
        email: extra?.email ?? `cliente-ficha-${seq}-${sufixo}@teste.local`,
        senhaHash: 'x',
        telefone: '11988887777',
        endereco,
        faturamentoMensalMedio: '10000.00',
        nomeResponsavel: 'Nome Errado',
        cpfResponsavel: extra?.cpfCnpj ?? `7${seq}${sufixo}`.slice(0, 11).padEnd(11, '0'),
        situacao: SITUACAO_USUARIO.ATIVO,
      },
    });
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
        cpfCnpj: `9${sufixo}`.slice(0, 11).padEnd(11, '0'),
        nomeRazaoSocial: 'Admin ficha',
        email: `admin-ficha-${sufixo}@teste.local`,
        senhaHash: 'x',
        situacao: SITUACAO_USUARIO.ATIVO,
      },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('corrige nome, telefone e endereço e grava auditoria', async () => {
    const alvo = await criarUsuario();

    await controller.editarDadosCadastrais(
      alvo.idPublico,
      {
        tipoPessoa: 'PF',
        cpfCnpj: alvo.cpfCnpj,
        nomeRazaoSocial: 'Nome Correto da Silva',
        telefone: '(11) 99999-0000',
        endereco: {
          cep: '22041-080',
          logradouro: 'Avenida Atlântica',
          numero: '1702',
          complemento: 'Apto 101',
          bairro: 'Copacabana',
          cidade: 'Rio de Janeiro',
          uf: 'rj',
        },
        faturamentoMensalMedio: '25000.50',
        codigoTotp: totp(),
      },
      { user: { id: adminId.toString() }, ip: '203.0.113.9' },
    );

    const depois = await prisma.usuario.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(depois.nomeRazaoSocial).toBe('Nome Correto da Silva');
    expect(depois.telefone).toBe('11999990000');
    expect(depois.email).toBe(alvo.email);
    expect(depois.endereco).toMatchObject({
      cep: '22041080',
      logradouro: 'Avenida Atlântica',
      numero: '1702',
      complemento: 'Apto 101',
      cidade: 'Rio de Janeiro',
      uf: 'RJ',
    });
    expect(depois.faturamentoMensalMedio?.toFixed(2)).toBe('25000.50');
    expect(depois.nomeResponsavel).toBe('Nome Correto da Silva');
    expect(depois.cpfResponsavel).toBe(alvo.cpfCnpj);

    const auditoria = await prisma.registroAuditoria.findFirst({
      where: {
        acao: 'USUARIO_DADOS_CADASTRAIS_EDITAR',
        usuarioAfetadoId: alvo.id,
      },
    });
    expect(auditoria).toBeTruthy();
    expect(auditoria?.dadosAnteriores).toMatchObject({
      nomeRazaoSocial: 'Nome Errado',
    });
    expect(auditoria?.dadosNovos).toMatchObject({
      nomeRazaoSocial: 'Nome Correto da Silva',
    });
  });

  it('ignora e-mail no body — identificador único não muda', async () => {
    const alvo = await criarUsuario();
    const emailOriginal = alvo.email;

    await controller.editarDadosCadastrais(
      alvo.idPublico,
      {
        tipoPessoa: 'PF',
        cpfCnpj: alvo.cpfCnpj,
        nomeRazaoSocial: 'Ainda o mesmo',
        email: 'nao-pode-trocar@ataque.local',
        endereco,
        codigoTotp: totp(),
      },
      { user: { id: adminId.toString() } },
    );

    const depois = await prisma.usuario.findUniqueOrThrow({ where: { id: alvo.id } });
    expect(depois.email).toBe(emailOriginal);
  });

  it('recusa CPF/CNPJ que já pertence a outra conta', async () => {
    const a = await criarUsuario();
    const b = await criarUsuario();

    await expect(
      controller.editarDadosCadastrais(
        b.idPublico,
        {
          tipoPessoa: 'PF',
          cpfCnpj: a.cpfCnpj,
          nomeRazaoSocial: b.nomeRazaoSocial,
          endereco,
          codigoTotp: totp(),
        },
        { user: { id: adminId.toString() } },
      ),
    ).rejects.toThrow(BadRequestException);

    const depois = await prisma.usuario.findUniqueOrThrow({ where: { id: b.id } });
    expect(depois.cpfCnpj).toBe(b.cpfCnpj);
  });

  it('PJ sem responsável é recusado', async () => {
    const alvo = await criarUsuario();

    await expect(
      controller.editarDadosCadastrais(
        alvo.idPublico,
        {
          tipoPessoa: 'PJ',
          cpfCnpj: '12345678000199',
          nomeRazaoSocial: 'Empresa Sem Responsavel LTDA',
          endereco,
          codigoTotp: totp(),
        },
        { user: { id: adminId.toString() } },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
