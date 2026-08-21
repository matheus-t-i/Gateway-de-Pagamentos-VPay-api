import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
  atualizarTemaSchema,
  cadastroUsuarioSchema,
  DOCUMENTOS_LEGAIS,
  loginSchema,
  MARGEM_MINIMA_RENOVACAO_MS,
  PAPEIS,
  PERMISSOES,
  renovacaoPermitida,
  SITUACAO_ANALISE,
  SITUACAO_USUARIO,
  VERSAO_DOCUMENTOS_LEGAIS,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { TIPOS_EMAIL } from '../shared';
import {
  JwtAuthGuard,
  type JwtPayload,
  type UsuarioAutenticado,
} from './jwt-auth.guard';
import { segundosDaDuracao, tetoSessaoMs } from './sessao.util';
import { JWT_AUDIENCE_PAINEL, JWT_ISSUER } from '../common/jwt-claims';
import { permissoesEfetivas } from './permissoes.util';
import { validarTotp } from './totp.controller';
import { montarStatusOnboarding } from '../onboarding/onboarding.util';
import { Throttle } from '../common/ip-throttle.guard';
import { assertStepUpTotp } from '../common/step-up-totp';
import { assertTurnstileLogin } from '../common/turnstile.util';

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
    const { email, senha, codigoTotp, turnstileToken } = parsed.data;
    const ip = req.ip;
    const ua = req.headers['user-agent'];
    // Anti-bot antes do argon2 / lookup — Turnstile fail-closed em produção.
    await assertTurnstileLogin({ token: turnstileToken, ip });
    const usuario = await this.prisma.usuario.findUnique({
      where: { email },
      include: { papeis: { include: { papel: true } } },
    });

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

    const papeisAtivos = usuario.papeis
      .filter((p) => p.papel.ativo)
      .map((p) => p.papel.nome);
    const permissoesLogin = await permissoesEfetivas(
      this.prisma,
      usuario.id,
      papeisAtivos,
    );
    // Perfis com escopo global / ADMINISTRADOR: 2FA obrigatório no login.
    // Sem TOTP ainda, o token é emitido mas o JwtAuthGuard só libera rotas de
    // ativação — chicken-and-egg resolvido sem bootstrap especial.
    const perfilAdmin =
      papeisAtivos.includes(PAPEIS.ADMINISTRADOR) ||
      permissoesLogin.includes(PERMISSOES.ESCOPO_GLOBAL);

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
    } else if (perfilAdmin && !codigoTotp) {
      // Admin sem 2FA ainda entra, mas o front deve forçar a ativação.
    }

    /**
     * Senha provisória (reset feito pelo administrador): senha correta NÃO
     * emite token. Sem esta trava a provisória — que passou pelas mãos do
     * admin e provavelmente por um canal de mensagem — viraria a senha
     * definitiva da conta.
     */
    if (usuario.forcarTrocaSenha && usuario.situacao === SITUACAO_USUARIO.ATIVO) {
      await this.prisma.auditoriaAcesso.create({
        data: {
          usuarioId: usuario.id,
          emailInformado: email,
          enderecoIp: ip,
          agenteUsuario: ua,
          sucesso: true,
          motivo: 'LOGIN_BLOQUEADO_TROCA_SENHA_OBRIGATORIA',
        },
      });
      return {
        situacao: usuario.situacao,
        requerTrocaSenha: true,
        proximoPasso: 'TROCAR_SENHA',
        mensagem:
          'Sua senha foi redefinida pelo administrador. Crie uma nova senha para continuar.',
      };
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

      const papeis = papeisAtivos;
      const accessToken = await this.jwt.signAsync({
        sub: usuario.id.toString(),
        email: usuario.email,
        papeis,
        /**
         * Marca o início da SESSÃO. A renovação silenciosa copia este valor
         * para todo token novo, então é ele que limita a soma das renovações
         * (`POST /auth/renovar`) — o `iat`, que muda a cada troca, deixaria a
         * sessão se esticar para sempre.
         */
        inicioSessao: Math.floor(Date.now() / 1000),
      });

      return {
        situacao: SITUACAO_USUARIO.ATIVO,
        accessToken,
        /** Admin sem TOTP: painel redireciona para ativar 2FA. */
        requerAtivar2FA: perfilAdmin && !usuario.totpHabilitado,
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
          permissoes: permissoesLogin,
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

  /**
   * Renovação silenciosa da sessão do painel — conta própria, sem
   * `@RequerPermissao` (mesma razão de `/auth/me`).
   *
   * Troca um JWT ainda VÁLIDO por outro para quem está trabalhando não ser
   * deslogado no meio de uma tarefa. NÃO existe refresh token guardado: o
   * próprio access token é a credencial da troca, e quem revalida a conta é o
   * `JwtAuthGuard`, que relê usuário, situação e perfis no banco a cada
   * requisição. Conta suspensa, bloqueada ou com perfil inativado não renova
   * nada — mesma razão pela qual o RBAC não mora dentro do JWT.
   *
   * Duas travas impedem que "renovar" vire "sessão eterna":
   *  - **janela** — só a partir de metade da validade gasta
   *    (`renovacaoPermitida`); sem ela, um cliente em laço ganharia um token
   *    novo por chamada;
   *  - **teto absoluto** — `inicioSessao` viaja no token e limita a soma das
   *    renovações a `SESSAO_PAINEL_MAX_HORAS`. Passou disso, é login de novo,
   *    com senha e 2FA.
   *
   * Recusa é **403, nunca 401**: o painel trata 401 de rota autenticada como
   * sessão morta e vai direto para o login. Aqui o token ainda vale — o
   * combinado com o front é não renovar e deixar expirar normalmente.
   *
   * Admin sem 2FA leva 403 do próprio guard, porque `/auth/renovar` está fora
   * de `ROTAS_SEM_2FA_ADMIN` de propósito: aquela allowlist é o caminho de
   * ATIVAR o segundo fator, não um jeito de esticar sessão sem ele.
   */
  @Post('renovar')
  @UseGuards(JwtAuthGuard)
  async renovar(@Req() req: { user: UsuarioAutenticado; jwtPayload?: JwtPayload }) {
    const payload = req.jwtPayload;
    if (!payload?.iat || !payload?.exp) {
      throw new ForbiddenException(
        'Token sem janela de validade. Entre novamente para continuar.',
      );
    }

    const agora = Date.now();
    const janela = { emitidoEm: payload.iat * 1000, expiraEm: payload.exp * 1000 };
    if (!renovacaoPermitida(janela, agora)) {
      throw new ForbiddenException('Token recente demais para renovar.');
    }

    /**
     * Token emitido ANTES desta versão não tem `inicioSessao` — a sessão dele
     * passa a contar do próprio `iat`. Sem esse fallback, o deploy com tráfego
     * vivo derrubaria a renovação de quem já estava logado.
     */
    const inicioSessao = payload.inicioSessao ?? payload.iat;
    const duracaoPadrao = segundosDaDuracao(process.env.JWT_EXPIRES_IN);
    const teto = tetoSessaoMs();
    const restanteSessao = teto
      ? Math.floor((inicioSessao * 1000 + teto - agora) / 1000)
      : duracaoPadrao;
    if (restanteSessao * 1000 <= MARGEM_MINIMA_RENOVACAO_MS) {
      throw new ForbiddenException(
        'Duração máxima da sessão atingida. Entre novamente para continuar.',
      );
    }

    // O último token da sessão é ENCURTADO até o teto em vez de passar dele:
    // assim o contador da tela mostra o prazo real e a sessão acaba na hora
    // marcada, sem um token válido sobrando depois do fim.
    const validadeSegundos = Math.min(duracaoPadrao, restanteSessao);

    const accessToken = await this.jwt.signAsync(
      {
        sub: req.user.id,
        email: req.user.email,
        // Perfis do BANCO (o guard acabou de lê-los), nunca os do token antigo:
        // renovar não pode ressuscitar papel que o admin tirou no meio da sessão.
        papeis: req.user.papeis,
        inicioSessao,
      },
      {
        expiresIn: validadeSegundos,
        issuer: JWT_ISSUER(),
        audience: JWT_AUDIENCE_PAINEL(),
      },
    );

    return {
      accessToken,
      expiraEm: new Date(
        (Math.floor(agora / 1000) + validadeSegundos) * 1000,
      ).toISOString(),
      /** Quando a sessão acaba de vez, mesmo renovando. `null` = sem teto. */
      sessaoExpiraEm: teto
        ? new Date(inicioSessao * 1000 + teto).toISOString()
        : null,
    };
  }

  /** Conta própria — sem `@RequerPermissao` de propósito. */
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
      // Contas criadas antes do campo existir caem no `criadoEm`: a senha do
      // cadastro É a senha em uso, então essa é a última alteração de fato.
      senhaAlteradaEm: usuario.senhaAlteradaEm ?? usuario.criadoEm,
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
            bloqueadoManual: usuario.saldo.saldoBloqueadoManual.toString(),
          }
        : null,
    };
  }

  /**
   * Conta própria — sem `@RequerPermissao` de propósito (igual `/auth/me` e
   * `/auth/totp`). Step-up TOTP obrigatório para persistir alteração.
   */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  async atualizarPerfil(@Req() req: { user: { id: string } }, @Body() body: unknown) {
    const parsed = atualizarPerfilSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
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

  /**
   * Tema do painel — **sem step-up 2FA**, ao contrário do resto do perfil.
   *
   * Claro/escuro é preferência visual: não move dinheiro, não muda acesso e
   * não expõe dado. Enquanto ia junto no `PATCH /auth/me`, alternar o tema
   * pedia o código do autenticador — quem estava sem o celular não conseguia
   * nem deixar a tela mais legível.
   *
   * A rota aceita SÓ `temaPreferido` (`atualizarTemaSchema`): não há como
   * usá-la para gravar telefone ou nome fantasia driblando o step-up.
   */
  @Patch('me/tema')
  @UseGuards(JwtAuthGuard)
  async atualizarTema(
    @Req() req: { user: { id: string } },
    @Body() body: unknown,
  ) {
    const parsed = atualizarTemaSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const usuario = await this.prisma.usuario.update({
      where: { id: BigInt(req.user.id) },
      data: { temaPreferido: parsed.data.temaPreferido },
      select: { temaPreferido: true },
    });
    return { temaPreferido: usuario.temaPreferido };
  }
}
