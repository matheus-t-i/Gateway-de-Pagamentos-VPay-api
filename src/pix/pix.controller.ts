import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  criarCobrancaPixSchema,
  criarSaquePixSchema,
  depositoPainelSchema,
  ESCOPOS_API,
  PAPEIS,
  saquePainelSchema,
  SITUACAO_CHAVE_PIX,
  SITUACAO_EMPRESA,
} from '../shared';
import { PixService } from './pix.service';

type ApiCredReq = {
  apiCredential: {
    id: string;
    usuarioId: string;
    empresaId: string;
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

    const empresaId = BigInt(req.apiCredential.empresaId);
    const chave = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
    if (chave) {
      const existing = await this.idem.getExisting(empresaId, chave);
      if (existing?.corpoResposta) {
        return existing.corpoResposta;
      }
    }

    const { idInterno, ...resposta } = await this.pix.criarCobranca({
      empresaId,
      usuarioId: BigInt(req.apiCredential.usuarioId),
      credencialApiId: BigInt(req.apiCredential.id),
      input: parsed.data,
    });

    if (chave) {
      await this.idem.save({
        empresaId,
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

    const empresaId = BigInt(req.apiCredential.empresaId);
    const chave = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
    if (chave) {
      const existing = await this.idem.getExisting(empresaId, chave);
      if (existing?.corpoResposta) return existing.corpoResposta;
    }

    const { idInterno, ...resposta } = await this.pix.criarSaque({
      empresaId,
      usuarioId: BigInt(req.apiCredential.usuarioId),
      credencialApiId: BigInt(req.apiCredential.id),
      input: parsed.data,
    });

    if (chave) {
      await this.idem.save({
        empresaId,
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
    return this.pix.detalhe(idTransacao, BigInt(req.apiCredential.empresaId));
  }
}

@Controller('painel/transacoes')
@UseGuards(JwtAuthGuard)
export class PixPainelController {
  constructor(
    private readonly pix: PixService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async listar(
    @Req() req: { user: { id: string; papeis: string[] } },
    @Headers('x-empresa-id') empresaIdPublico?: string,
  ) {
    if (!empresaIdPublico) throw new BadRequestException('Header x-empresa-id obrigatório');
    const empresa = await this.prisma.empresa.findUnique({
      where: { idPublico: empresaIdPublico },
    });
    if (!empresa) throw new BadRequestException('Empresa não encontrada');
    const isAdmin = req.user.papeis.includes(PAPEIS.ADMINISTRADOR);
    if (!isAdmin && empresa.usuarioProprietarioId.toString() !== req.user.id) {
      throw new BadRequestException('Sem acesso');
    }
    return this.pix.listar(empresa.id);
  }

  /**
   * Depósito pelo PAINEL (JWT). Gera uma cobrança PIX (copia-e-cola) para o
   * lojista receber/adicionar saldo. Não usa credencial de API — o dono ou um
   * administrador cria direto pelo painel. Reaproveita a mesma lógica de
   * cobrança da API pública (ledger, tarifas e liberação idênticos).
   *
   * Usa schema PRÓPRIO: não é uma venda, então não exige itens nem dados do
   * pagador — quem deposita é o próprio lojista.
   */
  @Post('cobrancas')
  async depositoPainel(
    @Req() req: { user: { id: string; papeis: string[] } },
    @Body() body: unknown,
    @Headers('x-empresa-id') empresaIdPublico?: string,
  ) {
    const parsed = depositoPainelSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    if (!empresaIdPublico) {
      throw new BadRequestException('Header x-empresa-id obrigatório');
    }

    const empresa = await this.prisma.empresa.findUnique({
      where: { idPublico: empresaIdPublico },
    });
    if (!empresa) throw new BadRequestException('Empresa não encontrada');
    const isAdmin = req.user.papeis.includes(PAPEIS.ADMINISTRADOR);
    if (!isAdmin && empresa.usuarioProprietarioId.toString() !== req.user.id) {
      throw new BadRequestException('Sem acesso');
    }
    if (empresa.situacao !== SITUACAO_EMPRESA.ATIVA) {
      throw new BadRequestException('Empresa não está ativa.');
    }

    const { idInterno, ...resposta } = await this.pix.criarCobranca({
      empresaId: empresa.id,
      usuarioId: BigInt(req.user.id),
      input: parsed.data,
    });
    void idInterno;
    return resposta;
  }

  /**
   * Saque pelo PAINEL. Só permite chave PIX previamente cadastrada e APROVADA
   * pelo administrador — o cliente não digita chave livre aqui.
   */
  @Post('saques')
  async saquePainel(
    @Req() req: { user: { id: string; papeis: string[] } },
    @Body() body: unknown,
    @Headers('x-empresa-id') empresaIdPublico?: string,
  ) {
    const parsed = saquePainelSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    if (!empresaIdPublico) {
      throw new BadRequestException('Header x-empresa-id obrigatório');
    }

    const empresa = await this.prisma.empresa.findUnique({
      where: { idPublico: empresaIdPublico },
    });
    if (!empresa) throw new BadRequestException('Empresa não encontrada');
    const isAdmin = req.user.papeis.includes(PAPEIS.ADMINISTRADOR);
    if (!isAdmin && empresa.usuarioProprietarioId.toString() !== req.user.id) {
      throw new BadRequestException('Sem acesso');
    }
    if (empresa.situacao !== SITUACAO_EMPRESA.ATIVA) {
      throw new BadRequestException('Empresa não está ativa.');
    }

    const chave = await this.prisma.chavePixEmpresa.findUnique({
      where: { idPublico: parsed.data.chavePixIdPublico },
    });
    if (!chave || chave.empresaId !== empresa.id) {
      throw new BadRequestException('Chave PIX não encontrada para esta empresa.');
    }
    if (chave.situacao !== SITUACAO_CHAVE_PIX.APROVADA) {
      throw new BadRequestException(
        `Chave PIX não liberada para saque (situação: ${chave.situacao}). ` +
          'Aguarde a aprovação do administrador.',
      );
    }

    const { idInterno, ...resposta } = await this.pix.criarSaque({
      empresaId: empresa.id,
      usuarioId: empresa.usuarioProprietarioId,
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
  async detalhe(
    @Param('idPublico') idPublico: string,
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    const tx = await this.prisma.transacao.findUnique({
      where: { idTransacaoPublico: idPublico },
      include: { empresa: true },
    });
    if (!tx) throw new BadRequestException('Transação não encontrada');
    const isAdmin = req.user.papeis.includes(PAPEIS.ADMINISTRADOR);
    if (!isAdmin && tx.empresa.usuarioProprietarioId.toString() !== req.user.id) {
      throw new BadRequestException('Sem acesso');
    }
    return this.pix.detalhe(idPublico, tx.empresaId);
  }
}
