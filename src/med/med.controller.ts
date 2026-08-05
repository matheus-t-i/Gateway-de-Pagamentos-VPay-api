import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PERMISSOES } from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { MedService } from './med.service';

const receberSchema = z.object({
  idTransacaoPublico: z.string().uuid(),
  valorSolicitado: z.string().regex(/^\d+(\.\d{1,2})?$/),
  identificadorMedProvedor: z.string().max(255).optional(),
  motivo: z.string().max(500).optional(),
});

const decidirSchema = z.object({
  decisao: z.enum(['ACEITO', 'RECUSADO']),
  motivo: z.string().max(500).optional(),
});

type MedReq = { user: { id: string } };

@Controller('admin/med')
@UseGuards(JwtAuthGuard)
export class MedController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly med: MedService,
  ) {}

  @Get()
  @RequerPermissao(PERMISSOES.ADMIN_MED_VER)
  async listar(@Query('situacao') situacao?: string) {
    const casos = await this.prisma.casoMed.findMany({
      where: situacao ? { situacao } : undefined,
      orderBy: { recebidoEm: 'desc' },
      take: 200,
      include: {
        transacao: { select: { idTransacaoPublico: true, valorBruto: true } },
        usuario: { select: { nomeRazaoSocial: true, idPublico: true } },
      },
    });
    return casos.map((c) => ({
      idPublico: c.idPublico,
      situacao: c.situacao,
      modo: c.modoTratamentoAplicado,
      valorSolicitado: c.valorSolicitado.toString(),
      valorBloqueado: c.valorBloqueado.toString(),
      valorDebitado: c.valorDebitado.toString(),
      valorNaoCoberto: c.valorNaoCoberto.toString(),
      motivo: c.motivo,
      recebidoEm: c.recebidoEm,
      decididoEm: c.decididoEm,
      cliente: { nome: c.usuario.nomeRazaoSocial, idPublico: c.usuario.idPublico },
      transacao: {
        idTransacao: c.transacao.idTransacaoPublico,
        valorBruto: c.transacao.valorBruto.toString(),
      },
    }));
  }

  @Get(':idPublico')
  @RequerPermissao(PERMISSOES.ADMIN_MED_VER)
  async detalhe(@Param('idPublico') idPublico: string) {
    const c = await this.prisma.casoMed.findUnique({
      where: { idPublico },
      include: {
        transacao: { select: { idTransacaoPublico: true, valorBruto: true, criadoEm: true } },
        usuario: { select: { nomeRazaoSocial: true, idPublico: true } },
        historicos: { orderBy: { id: 'asc' } },
        devolucoes: true,
      },
    });
    if (!c) throw new NotFoundException('Caso não encontrado');
    return {
      idPublico: c.idPublico,
      situacao: c.situacao,
      modo: c.modoTratamentoAplicado,
      valorSolicitado: c.valorSolicitado.toString(),
      valorBloqueado: c.valorBloqueado.toString(),
      valorDebitado: c.valorDebitado.toString(),
      valorNaoCoberto: c.valorNaoCoberto.toString(),
      motivo: c.motivo,
      recebidoEm: c.recebidoEm,
      decididoEm: c.decididoEm,
      cliente: { nome: c.usuario.nomeRazaoSocial, idPublico: c.usuario.idPublico },
      transacao: {
        idTransacao: c.transacao.idTransacaoPublico,
        valorBruto: c.transacao.valorBruto.toString(),
        criadoEm: c.transacao.criadoEm,
      },
      historicos: c.historicos.map((h) => ({
        situacaoAnterior: h.situacaoAnterior,
        novaSituacao: h.novaSituacao,
        acao: h.acao,
        origem: h.origem,
        motivo: h.motivo,
        criadoEm: h.criadoEm,
      })),
      devolucoes: c.devolucoes.map((d) => ({
        idPublico: d.idDevolucaoPublico,
        valor: d.valor.toString(),
        situacao: d.situacao,
      })),
    };
  }

  /** Entrada manual (a via normal é o webhook da adquirente). */
  @Post('receber')
  @RequerPermissao(PERMISSOES.ADMIN_MED_DECIDIR)
  async receber(@Req() req: MedReq, @Body() body: unknown) {
    const parsed = receberSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.med.receber({
      ...parsed.data,
      origem: 'ADMINISTRADOR',
      usuarioAtorId: BigInt(req.user.id),
    });
  }

  @Post(':idPublico/decidir')
  @RequerPermissao(PERMISSOES.ADMIN_MED_DECIDIR)
  async decidir(
    @Param('idPublico') idPublico: string,
    @Req() req: MedReq,
    @Body() body: unknown,
  ) {
    const parsed = decidirSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.med.decidir({
      idPublico,
      decisao: parsed.data.decisao,
      motivo: parsed.data.motivo,
      usuarioAtorId: BigInt(req.user.id),
    });
  }
}
