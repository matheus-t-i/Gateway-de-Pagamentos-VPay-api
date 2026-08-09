import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTokenGuard,
  assertEscopo,
  assertSaqueViaApiPermitido,
} from '../api-credentials/api-token.guard';
import { RateLimitService } from '../api-credentials/rate-limit.service';
import {
  JwtAuthGuard,
  temEscopoGlobal,
  type UsuarioAutenticado,
} from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ReenvioWebhookService } from '../queues/reenvio-webhook.service';
import {
  criarCobrancaPixSchema,
  criarSaquePixSchema,
  depositoPainelSchema,
  ESCOPOS_API,
  PERMISSOES,
  saquePainelSchema,
  SITUACAO_CHAVE_PIX,
  SITUACAO_USUARIO,
} from '../shared';
import {
  assertStepUpFromBody,
  assertStepUpTotp,
} from '../common/step-up-totp';
import { PixService } from './pix.service';

type ApiCredReq = {
  apiCredential: {
    id: string;
    usuarioId: string;
    escopos: string[];
    temIpAllowlist?: boolean;
  };
  ip?: string;
  headers: Record<string, string | undefined>;
};

@Controller('v1/pix')
export class PixApiController {
  constructor(
    private readonly pix: PixService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * Idempotência é por `referenciaExterna`, DENTRO do serviço: repetir a mesma
   * referência com os mesmos dados devolve a mesma transação. Não existe mais
   * header `idempotency-key` — a proteção contra retentativa duplicada não
   * pode depender de o lojista lembrar de um header opcional.
   */
  @Post('cobrancas')
  @UseGuards(ApiTokenGuard)
  async criarCobranca(@Req() req: ApiCredReq, @Body() body: unknown) {
    assertEscopo(req.apiCredential, ESCOPOS_API.PIX_COBRANCA_CRIAR);
    await this.rateLimit.enforceCredential(req.apiCredential.id, req.ip ?? '');
    const parsed = criarCobrancaPixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const { idInterno, ...resposta } = await this.pix.criarCobranca({
      usuarioId: BigInt(req.apiCredential.usuarioId),
      credencialApiId: BigInt(req.apiCredential.id),
      input: parsed.data,
    });
    void idInterno;
    return resposta;
  }

  @Post('saques')
  @UseGuards(ApiTokenGuard)
  async criarSaque(@Req() req: ApiCredReq, @Body() body: unknown) {
    // Regra de negócio: saque via API exige escopo + IP liberado na credencial.
    assertSaqueViaApiPermitido(req.apiCredential);
    await this.rateLimit.enforceCredential(req.apiCredential.id, req.ip ?? '');
    const parsed = criarSaquePixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const { idInterno, ...resposta } = await this.pix.criarSaque({
      usuarioId: BigInt(req.apiCredential.usuarioId),
      credencialApiId: BigInt(req.apiCredential.id),
      input: parsed.data,
    });
    void idInterno;
    return resposta;
  }

  @Get('transacoes/:idTransacao')
  @UseGuards(ApiTokenGuard)
  async detalheApi(
    @Param('idTransacao') idTransacao: string,
    @Req() req: ApiCredReq,
  ) {
    // `transacoes.ler` existia no catálogo e era gravado na credencial, mas
    // nenhuma rota o verificava: uma credencial só de escrita (a que o lojista
    // entrega ao checkout de terceiro) conseguia ler detalhe de transação —
    // nome e endereço do pagador, tarifa e liquidação — violando em silêncio o
    // menor privilégio que o painel prometeu.
    assertEscopo(req.apiCredential, ESCOPOS_API.TRANSACOES_LER);
    await this.rateLimit.enforceCredential(req.apiCredential.id, req.ip ?? '');
    return this.pix.detalhe(idTransacao, BigInt(req.apiCredential.usuarioId));
  }
}

@Controller('painel/transacoes')
@UseGuards(JwtAuthGuard)
export class PixPainelController {
  constructor(
    private readonly pix: PixService,
    private readonly prisma: PrismaService,
    private readonly reenvioWebhook: ReenvioWebhookService,
  ) {}

  /** A conta é sempre a do JWT — não existe conta de terceiro no painel do cliente. */
  private async contaAtiva(user: UsuarioAutenticado) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: BigInt(user.id) },
    });
    if (!usuario) throw new BadRequestException('Conta não encontrada');
    if (usuario.situacao !== SITUACAO_USUARIO.ATIVO) {
      throw new BadRequestException('Conta não está ativa.');
    }
    return usuario;
  }

  /**
   * Uma página do extrato. Paginação e filtros SERVER-SIDE (`direcao`,
   * `situacao`, período, busca) — o painel tem uma tela por sentido:
   * Transações (ENTRADA) e Transferências (SAIDA).
   */
  @Get()
  @RequerPermissao(PERMISSOES.TRANSACOES_VER)
  async listar(
    @Req() req: { user: UsuarioAutenticado },
    @Query() q: Record<string, string>,
  ) {
    return this.pix.listar(BigInt(req.user.id), q);
  }

  /**
   * Contagem e totais do MESMO filtro da listagem. Rota separada porque é a
   * consulta cara (varre o conjunto filtrado inteiro): assim o painel a refaz
   * só quando o filtro muda, e paginar continua custando uma página.
   */
  @Get('resumo')
  @RequerPermissao(PERMISSOES.TRANSACOES_VER)
  async resumo(
    @Req() req: { user: UsuarioAutenticado },
    @Query() q: Record<string, string>,
  ) {
    return this.pix.resumo(BigInt(req.user.id), q);
  }

  /**
   * Depósito pelo PAINEL (JWT). Gera uma cobrança PIX (copia-e-cola) para o
   * lojista receber/adicionar saldo. Não usa credencial de API — o dono cria
   * direto pelo painel. Reaproveita a mesma lógica de cobrança da API pública
   * (ledger, tarifas e liberação idênticos).
   *
   * Usa schema PRÓPRIO: não é uma venda, então não exige itens nem dados do
   * pagador — quem deposita é o próprio lojista.
   */
  @Post('cobrancas')
  @RequerPermissao(PERMISSOES.TRANSACOES_CRIAR)
  async depositoPainel(
    @Req() req: { user: UsuarioAutenticado },
    @Body() body: unknown,
  ) {
    const parsed = depositoPainelSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    const usuario = await this.contaAtiva(req.user);
    const { codigoTotp: _c, ...dados } = parsed.data;

    const { idInterno, ...resposta } = await this.pix.criarCobranca({
      usuarioId: usuario.id,
      input: {
        ...dados,
        // Quem deposita é o próprio titular — liquidantes reais (ex.:
        // Valorion) exigem nome/e-mail/CPF do pagador; para PJ vai o CPF do
        // responsável, já que CNPJ não é aceito como documento do pagador.
        pagador: {
          nome: usuario.nomeResponsavel ?? usuario.nomeRazaoSocial,
          documento: usuario.cpfResponsavel ?? usuario.cpfCnpj,
          email: usuario.email,
          telefone: usuario.telefone ?? undefined,
        },
      },
    });
    void idInterno;
    return resposta;
  }

  /**
   * Saque pelo PAINEL. Só permite chave PIX previamente cadastrada e APROVADA
   * pelo administrador — o cliente não digita chave livre aqui.
   */
  @Post('saques')
  @RequerPermissao(PERMISSOES.TRANSACOES_CRIAR)
  async saquePainel(
    @Req() req: { user: UsuarioAutenticado },
    @Body() body: unknown,
  ) {
    const parsed = saquePainelSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    const usuario = await this.contaAtiva(req.user);

    const chave = await this.prisma.chavePixUsuario.findUnique({
      where: { idPublico: parsed.data.chavePixIdPublico },
    });
    if (!chave || chave.usuarioId !== usuario.id) {
      throw new BadRequestException('Chave PIX não encontrada para esta conta.');
    }
    if (chave.situacao !== SITUACAO_CHAVE_PIX.APROVADA) {
      throw new BadRequestException(
        `Chave PIX não liberada para saque (situação: ${chave.situacao}). ` +
          'Aguarde a aprovação do administrador.',
      );
    }
    // A liquidante exige nome + documento do dono da chave. `nomeTitular` e
    // `documentoTitular` são opcionais no cadastro, então uma chave antiga
    // aprovada sem esses dados chegaria na adquirente incompleta — e só
    // quebraria lá, com o saldo do lojista já debitado.
    if (!chave.nomeTitular || !chave.documentoTitular) {
      throw new BadRequestException(
        'A chave PIX está sem titular/documento cadastrados. Peça ao ' +
          'administrador para completar o cadastro da chave antes do saque.',
      );
    }

    const { idInterno, ...resposta } = await this.pix.criarSaque({
      usuarioId: usuario.id,
      input: {
        valor: parsed.data.valor,
        chavePix: chave.chave,
        tipoChavePix: chave.tipoChave,
        referenciaExterna: parsed.data.referenciaExterna,
        nomeBeneficiario: chave.nomeTitular,
        documentoBeneficiario: chave.documentoTitular,
      },
    });
    void idInterno;
    return resposta;
  }

  /**
   * Reenvia o callback desta transação para os webhooks da própria conta.
   * Restrito ao dono (quem tem escopo global usa a tela de admin) — sem isso,
   * um cliente dispararia callback de transação alheia só chutando o id.
   */
  @Post(':idPublico/reenviar-webhook')
  @RequerPermissao(PERMISSOES.TRANSACOES_EXECUTAR)
  async reenviarWebhook(
    @Param('idPublico') idPublico: string,
    @Req() req: { user: UsuarioAutenticado; ip?: string },
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
    return this.reenvioWebhook.solicitar({
      idTransacaoPublico: idPublico,
      usuarioIdRestricao: BigInt(req.user.id),
      atorId: BigInt(req.user.id),
      enderecoIp: req.ip,
    });
  }

  @Get(':idPublico')
  @RequerPermissao(PERMISSOES.TRANSACOES_VER)
  async detalhe(
    @Param('idPublico') idPublico: string,
    @Req() req: { user: UsuarioAutenticado },
  ) {
    const tx = await this.prisma.transacao.findUnique({
      where: { idTransacaoPublico: idPublico },
    });
    if (!tx) throw new BadRequestException('Transação não encontrada');
    if (!temEscopoGlobal(req.user) && tx.usuarioId.toString() !== req.user.id) {
      throw new BadRequestException('Sem acesso');
    }
    return this.pix.detalhe(idPublico, tx.usuarioId);
  }
}
