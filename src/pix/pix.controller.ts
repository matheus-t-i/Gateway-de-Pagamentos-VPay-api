import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiKeyGuard,
  assertEscopo,
  assertSaqueViaApiPermitido,
  IdempotencyInterceptor,
} from '../api-credentials/api-key.guard';
import { RateLimitService } from '../api-credentials/rate-limit.service';
import {
  JwtAuthGuard,
  temEscopoGlobal,
  type UsuarioAutenticado,
} from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { PrismaService } from '../prisma/prisma.service';
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
    private readonly idem: IdempotencyInterceptor,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post('cobrancas')
  @UseGuards(ApiKeyGuard)
  async criarCobranca(@Req() req: ApiCredReq, @Body() body: unknown) {
    assertEscopo(req.apiCredential, ESCOPOS_API.PIX_COBRANCA_CRIAR);
    await this.rateLimit.enforceCredential(req.apiCredential.id, req.ip ?? '');
    const parsed = criarCobrancaPixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const usuarioId = BigInt(req.apiCredential.usuarioId);
    const chave = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
    if (chave) {
      const existing = await this.idem.getExisting(usuarioId, chave);
      if (existing?.corpoResposta) {
        return existing.corpoResposta;
      }
    }

    const { idInterno, ...resposta } = await this.pix.criarCobranca({
      usuarioId,
      credencialApiId: BigInt(req.apiCredential.id),
      input: parsed.data,
    });

    if (chave) {
      await this.idem.save({
        usuarioId,
        credencialApiId: BigInt(req.apiCredential.id),
        chave,
        hash: this.idem.hashBody(body),
        transacaoId: BigInt(idInterno),
        status: 201,
        corpo: resposta,
      });
    }
    return resposta;
  }

  @Post('saques')
  @UseGuards(ApiKeyGuard)
  async criarSaque(@Req() req: ApiCredReq, @Body() body: unknown) {
    // Regra de negócio: saque via API exige escopo + IP liberado na credencial.
    assertSaqueViaApiPermitido(req.apiCredential);
    await this.rateLimit.enforceCredential(req.apiCredential.id, req.ip ?? '');
    const parsed = criarSaquePixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const usuarioId = BigInt(req.apiCredential.usuarioId);
    const chave = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
    if (chave) {
      const existing = await this.idem.getExisting(usuarioId, chave);
      if (existing?.corpoResposta) return existing.corpoResposta;
    }

    const { idInterno, ...resposta } = await this.pix.criarSaque({
      usuarioId,
      credencialApiId: BigInt(req.apiCredential.id),
      input: parsed.data,
    });

    if (chave) {
      await this.idem.save({
        usuarioId,
        credencialApiId: BigInt(req.apiCredential.id),
        chave,
        hash: this.idem.hashBody(body),
        transacaoId: BigInt(idInterno),
        status: 201,
        corpo: resposta,
      });
    }
    return resposta;
  }

  @Get('transacoes/:idTransacao')
  @UseGuards(ApiKeyGuard)
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

  @Get()
  @RequerPermissao(PERMISSOES.TRANSACOES_VER)
  async listar(@Req() req: { user: UsuarioAutenticado }) {
    return this.pix.listar(BigInt(req.user.id));
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
    const usuario = await this.contaAtiva(req.user);

    const { idInterno, ...resposta } = await this.pix.criarCobranca({
      usuarioId: usuario.id,
      input: {
        ...parsed.data,
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

    const { idInterno, ...resposta } = await this.pix.criarSaque({
      usuarioId: usuario.id,
      input: {
        valor: parsed.data.valor,
        chavePix: chave.chave,
        tipoChavePix: chave.tipoChave,
        referenciaExterna: parsed.data.referenciaExterna,
        nomeBeneficiario: chave.nomeTitular ?? undefined,
        documentoBeneficiario: chave.documentoTitular ?? undefined,
      },
    });
    void idInterno;
    return resposta;
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
