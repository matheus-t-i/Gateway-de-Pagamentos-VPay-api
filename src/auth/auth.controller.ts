import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import {
  atualizarPerfilSchema,
  cadastroUsuarioSchema,
  DOCUMENTOS_LEGAIS,
  loginSchema,
  PAPEIS,
  SITUACAO_ANALISE,
  SITUACAO_USUARIO,
  VERSAO_DOCUMENTOS_LEGAIS,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { TIPOS_EMAIL } from '../shared';
import { JwtAuthGuard, type UsuarioAutenticado } from './jwt-auth.guard';
import { permissoesEfetivas } from './permissoes.util';
import { validarTotp } from './totp.controller';
import { montarStatusOnboarding } from '../onboarding/onboarding.util';
import { Throttle } from '../common/ip-throttle.guard';

/** Janela deslizante do lockout de login (expira sozinha). */
const JANELA_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_FALHAS_LOGIN = 5;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly queues: QueuesService,
  ) {}

  // Cadastro é caro (argon2 + transação): trava flood de criação de contas.
  @Throttle({ limit: 10, windowSec: 60 })
  @Post('cadastro')
  async cadastro(
    @Body() body: unknown,
    @Req() req: { ip?: string; headers: Record<string, string> },
  ) {
    const parsed = cadastroUsuarioSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const data = parsed.data;
    const exists = await this.prisma.usuario.findFirst({
      where: {
        OR: [{ email: data.email }, { cpfCnpj: data.cpfCnpj }],
      },
    });
    if (exists) {
      throw new BadRequestException('E-mail ou CPF/CNPJ já cadastrado');
    }
    const senhaHash = await argon2.hash(data.senha);
    const papel = await this.prisma.papel.findUniqueOrThrow({
      where: { nome: PAPEIS.CLIENTE },
    });

    const enderecoIp = req.ip ?? null;
    const agenteUsuario = req.headers['user-agent'] ?? null;

    const usuario = await this.prisma.$transaction(async (tx) => {
      const criado = await tx.usuario.create({
        data: {
          tipoPessoa: data.tipoPessoa,
          cpfCnpj: data.cpfCnpj,
          nomeRazaoSocial: data.nomeRazaoSocial,
          nomeFantasia: data.nomeFantasia,
          email: data.email,
          telefone: data.telefone,
          senhaHash,
          endereco: data.endereco,
          faturamentoMensalMedio: data.faturamentoMensalMedio,
          // PF: o responsável é o próprio titular (consulta uniforme no admin).
          cpfResponsavel: data.responsavel?.cpf ?? data.cpfCnpj,
          nomeResponsavel: data.responsavel?.nome ?? data.nomeRazaoSocial,
          situacao: SITUACAO_USUARIO.PENDENTE,
          papeis: { create: { papelId: papel.id } },
          analises: { create: { situacao: SITUACAO_ANALISE.PENDENTE } },
        },
      });

      // Assinatura eletrônica dos documentos legais: registra IP/user-agent
      // (e geolocalização quando enviada pelo app) no mesmo commit do cadastro.
      await tx.aceiteDocumentoLegal.createMany({
        data: [
          DOCUMENTOS_LEGAIS.TERMOS_USO_PRIVACIDADE,
          DOCUMENTOS_LEGAIS.CONTRATO_INTERMEDIACAO,
        ].map((documento) => ({
          usuarioId: criado.id,
          documento,
          versao: VERSAO_DOCUMENTOS_LEGAIS,
          enderecoIp,
          agenteUsuario,
          latitude: data.aceites.latitude,
          longitude: data.aceites.longitude,
        })),
      });

      await tx.historicoSituacaoUsuario.create({
        data: {
          usuarioId: criado.id,
          novaSituacao: SITUACAO_USUARIO.PENDENTE,
          motivo: 'Cadastro inicial (onboarding)',
          usuarioAtorId: criado.id,
          enderecoIp,
        },
      });

      return criado;
    });

    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.CADASTRO_RECEBIDO,
      para: usuario.email,
      nome: usuario.nomeRazaoSocial,
      dados: {
        url: `${process.env.WEB_URL ?? 'http://localhost:3000'}/onboarding/documentos`,
      },
    });

    return {
      idPublico: usuario.idPublico,
      email: usuario.email,
      situacao: usuario.situacao,
      tipoPessoa: usuario.tipoPessoa,
    };
  }

  // Freio por IP contra brute force distribuído (o lockout por conta não cobre
  // password spraying: 1 senha em N contas).
  @Throttle({ limit: 20, windowSec: 60 })
  @Post('login')
  async login(@Body() body: unknown, @Req() req: { ip?: string; headers: Record<string, string> }) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const { email, senha, codigoTotp } = parsed.data;
    const usuario = await this.prisma.usuario.findUnique({
      where: { email },
      include: { papeis: { include: { papel: true } } },
    });
    const ip = req.ip;
    const ua = req.headers['user-agent'];

    if (!usuario) {
      await this.prisma.auditoriaAcesso.create({
        data: {
          emailInformado: email,
          enderecoIp: ip,
          agenteUsuario: ua,
          sucesso: false,
          motivo: 'USUARIO_NAO_ENCONTRADO',
        },
      });
      throw new UnauthorizedException('Credenciais inválidas');
    }

    if (usuario.contaBloqueada) {
      await this.prisma.auditoriaAcesso.create({
        data: {
          usuarioId: usuario.id,
          emailInformado: email,
          enderecoIp: ip,
          agenteUsuario: ua,
          sucesso: false,
          motivo: 'CONTA_BLOQUEADA',
        },
      });
      throw new UnauthorizedException('Conta bloqueada');
    }

    const ok = await argon2.verify(usuario.senhaHash, senha);
    if (!ok) {
      await this.prisma.auditoriaAcesso.create({
        data: {
          usuarioId: usuario.id,
          emailInformado: email,
          enderecoIp: ip,
          agenteUsuario: ua,
          sucesso: false,
          motivo: 'SENHA_INVALIDA',
        },
      });
      // Lockout TEMPORÁRIO (janela deslizante), não permanente: com bloqueio
      // definitivo qualquer pessoa derrubaria a conta alheia só errando a senha
      // 5 vezes — negação de serviço trivial. A janela expira sozinha.
      const falhas = await this.prisma.auditoriaAcesso.count({
        where: {
          usuarioId: usuario.id,
          sucesso: false,
          ocorridoEm: { gte: new Date(Date.now() - JANELA_LOCKOUT_MS) },
        },
      });
      if (falhas >= MAX_FALHAS_LOGIN) {
        throw new UnauthorizedException(
          'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
        );
      }
      throw new UnauthorizedException('Credenciais inválidas');
    }

    // 2FA: com TOTP ativo, a senha correta sozinha NÃO emite token.
    if (usuario.totpHabilitado && usuario.segredoTotpCriptografado) {
      if (!codigoTotp) {
        return {
          situacao: usuario.situacao,
          requer2FA: true,
          proximoPasso: 'INFORMAR_CODIGO_2FA',
          mensagem: 'Informe o código do aplicativo autenticador.',
        };
      }
      if (!validarTotp(usuario.segredoTotpCriptografado, codigoTotp)) {
        await this.prisma.auditoriaAcesso.create({
          data: {
            usuarioId: usuario.id,
            emailInformado: email,
            enderecoIp: ip,
            agenteUsuario: ua,
            sucesso: false,
            motivo: 'TOTP_INVALIDO',
          },
        });
        throw new UnauthorizedException('Código de verificação inválido.');
      }
    }

    // Único estado que emite JWT: conta APROVADA (ATIVO).
    if (usuario.situacao === SITUACAO_USUARIO.ATIVO) {
      await this.prisma.auditoriaAcesso.create({
        data: {
          usuarioId: usuario.id,
          emailInformado: email,
          enderecoIp: ip,
          agenteUsuario: ua,
          sucesso: true,
        },
      });
      await this.prisma.usuario.update({
        where: { id: usuario.id },
        data: { ultimoAcessoEm: new Date() },
      });

      const papeis = usuario.papeis
        .filter((p) => p.papel.ativo)
        .map((p) => p.papel.nome);
      const accessToken = await this.jwt.signAsync({
        sub: usuario.id.toString(),
        email: usuario.email,
        papeis,
      });

      return {
        situacao: SITUACAO_USUARIO.ATIVO,
        accessToken,
        usuario: {
          idPublico: usuario.idPublico,
          email: usuario.email,
          nomeRazaoSocial: usuario.nomeRazaoSocial,
          temaPreferido: usuario.temaPreferido,
          // O indicador de 2FA no topo lê isto; sem enviar já no login ele
          // pisca "Inativo" até o /auth/me responder.
          totpHabilitado: usuario.totpHabilitado,
          papeis,
          // O painel monta menu e guardas de rota com isto; sem enviar já no
          // login, a primeira tela renderiza sem nada até o /auth/me responder.
          permissoes: await permissoesEfetivas(this.prisma, usuario.id, papeis),
        },
      };
    }

    // Credenciais válidas mas conta não aprovada: nunca emitimos token.
    // Registramos como acesso bem-sucedido (não conta como tentativa falha),
    // porém sem JWT, e devolvemos o próximo passo para o front rotear.
    await this.prisma.auditoriaAcesso.create({
      data: {
        usuarioId: usuario.id,
        emailInformado: email,
        enderecoIp: ip,
        agenteUsuario: ua,
        sucesso: true,
        motivo: `SEM_TOKEN_${usuario.situacao}`,
      },
    });

    if (usuario.situacao === SITUACAO_USUARIO.PENDENTE) {
      const status = await montarStatusOnboarding(this.prisma, usuario.id);
      return {
        situacao: SITUACAO_USUARIO.PENDENTE,
        proximoPasso: 'ENVIAR_DOCUMENTOS',
        mensagem: 'Cadastro recebido. Envie a documentação para concluir.',
        documentosFaltantes: status.documentos.faltantes,
      };
    }

    if (usuario.situacao === SITUACAO_USUARIO.EM_ANALISE) {
      return {
        situacao: SITUACAO_USUARIO.EM_ANALISE,
        proximoPasso: 'AGUARDAR_ANALISE',
        mensagem: 'Sua conta está em análise.',
      };
    }

    if (usuario.situacao === SITUACAO_USUARIO.REPROVADO) {
      return {
        situacao: SITUACAO_USUARIO.REPROVADO,
        proximoPasso: 'CONTATO_SUPORTE',
        mensagem: 'Cadastro reprovado.',
        motivo: usuario.motivoReprovacao ?? null,
      };
    }

    const mensagens: Record<string, string> = {
      [SITUACAO_USUARIO.SUSPENSO]: 'Conta suspensa. Contate o suporte.',
      [SITUACAO_USUARIO.BLOQUEADO]: 'Conta bloqueada. Contate o suporte.',
      [SITUACAO_USUARIO.ENCERRADO]: 'Conta encerrada.',
    };
    return {
      situacao: usuario.situacao,
      proximoPasso: 'CONTATO_SUPORTE',
      mensagem: mensagens[usuario.situacao] ?? 'Conta não habilitada para acesso.',
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: { user: UsuarioAutenticado }) {
    const usuario = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: BigInt(req.user.id) },
      include: { papeis: { include: { papel: true } }, saldo: true },
    });
    return {
      idPublico: usuario.idPublico,
      email: usuario.email,
      cpfCnpj: usuario.cpfCnpj,
      nomeRazaoSocial: usuario.nomeRazaoSocial,
      nomeFantasia: usuario.nomeFantasia,
      telefone: usuario.telefone,
      temaPreferido: usuario.temaPreferido,
      situacao: usuario.situacao,
      tipoPessoa: usuario.tipoPessoa,
      totpHabilitado: usuario.totpHabilitado,
      papeis: usuario.papeis.filter((p) => p.papel.ativo).map((p) => p.papel.nome),
      // Resolvidas pelo guard a cada request: refletem alteração de perfil na
      // hora, sem precisar reemitir o token.
      permissoes: req.user.permissoes,
      saldo: usuario.saldo
        ? {
            disponivel: usuario.saldo.saldoDisponivel.toString(),
            pendenteLiberacao: usuario.saldo.saldoPendenteLiberacao.toString(),
            reservado: usuario.saldo.saldoReservado.toString(),
            bloqueadoMed: usuario.saldo.saldoBloqueadoMed.toString(),
          }
        : null,
    };
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  async atualizarPerfil(@Req() req: { user: { id: string } }, @Body() body: unknown) {
    const parsed = atualizarPerfilSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const usuario = await this.prisma.usuario.update({
      where: { id: BigInt(req.user.id) },
      data: {
        telefone: parsed.data.telefone,
        nomeFantasia: parsed.data.nomeFantasia,
        temaPreferido: parsed.data.temaPreferido,
      },
    });
    return {
      idPublico: usuario.idPublico,
      temaPreferido: usuario.temaPreferido,
      telefone: usuario.telefone,
      nomeFantasia: usuario.nomeFantasia,
    };
  }
}
