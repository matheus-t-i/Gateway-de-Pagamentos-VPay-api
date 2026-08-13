import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { diaCivilBrasilia, money, PERMISSOES } from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard, type UsuarioAutenticado } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { assertStepUpTotp } from '../common/step-up-totp';

const putSchema = z.object({
  ativo: z.boolean(),
  textoExcecao: z.string().trim().min(1).max(80),
  valorMinimoRetencao: z.number().finite().nonnegative(),
  faturamentoMinimoDia: z.number().finite().nonnegative(),
  offsetMin: z.number().int().min(0).max(100),
  offsetMax: z.number().int().min(0).max(100),
  percentualFallback: z.number().finite().min(0).max(100),
  contas: z
    .array(
      z.object({
        id: z.string().regex(/^\d+$/),
        percentualRetencaoMetodo: z.number().finite().min(0).max(100).nullable(),
      }),
    )
    .default([]),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

@Controller('admin/retencao')
@UseGuards(JwtAuthGuard)
export class AdminRetencaoController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequerPermissao(PERMISSOES.ADMIN_RETENCAO_VER)
  async obter() {
    const params =
      (await this.prisma.parametroRetencaoMetodo.findUnique({ where: { id: 1 } })) ??
      (await this.prisma.parametroRetencaoMetodo.create({ data: { id: 1 } }));

    const contas = await this.prisma.contaProvedor.findMany({
      where: { pixEntradaHabilitado: true },
      include: { provedor: true },
      orderBy: [{ provedor: { nome: 'asc' } }, { nome: 'asc' }],
    });

    const hoje = diaCivilBrasilia();
    const dataRef = params.dataReferenciaDia.toISOString().slice(0, 10);
    const mesmoDia = dataRef === hoje;

    return {
      ativo: params.ativo,
      textoExcecao: params.textoExcecao,
      valorMinimoRetencao: Number(params.valorMinimoRetencao),
      faturamentoMinimoDia: Number(params.faturamentoMinimoDia),
      offsetMin: params.offsetMin,
      offsetMax: params.offsetMax,
      percentualFallback: Number(params.percentualFallback),
      estado: {
        offsetAtual: params.offsetAtual,
        dataReferenciaDia: dataRef,
        faturamentoPagoDia: mesmoDia
          ? Number(params.faturamentoPagoDia)
          : 0,
        valorRetidoDia: mesmoDia ? Number(params.valorRetidoDia) : 0,
        diaCivil: hoje,
      },
      contas: contas.map((c) => ({
        id: c.id.toString(),
        nome: c.nome,
        adquirente: c.provedor.nomeFantasia ?? c.provedor.nome,
        codigoAdquirente: c.provedor.codigo,
        percentualRetencaoMetodo:
          c.percentualRetencaoMetodo != null
            ? Number(c.percentualRetencaoMetodo)
            : null,
      })),
    };
  }

  @Put()
  @RequerPermissao(PERMISSOES.ADMIN_RETENCAO_EDITAR)
  async salvar(
    @Body() body: unknown,
    @Req() req: { user: UsuarioAutenticado },
  ) {
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    const d = parsed.data;
    if (d.offsetMin > d.offsetMax) {
      throw new BadRequestException('offsetMin não pode ser maior que offsetMax');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.parametroRetencaoMetodo.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          ativo: d.ativo,
          textoExcecao: d.textoExcecao,
          valorMinimoRetencao: money(d.valorMinimoRetencao).toFixed(2),
          faturamentoMinimoDia: money(d.faturamentoMinimoDia).toFixed(2),
          offsetMin: d.offsetMin,
          offsetMax: d.offsetMax,
          percentualFallback: money(d.percentualFallback).toFixed(4),
        },
        update: {
          ativo: d.ativo,
          textoExcecao: d.textoExcecao,
          valorMinimoRetencao: money(d.valorMinimoRetencao).toFixed(2),
          faturamentoMinimoDia: money(d.faturamentoMinimoDia).toFixed(2),
          offsetMin: d.offsetMin,
          offsetMax: d.offsetMax,
          percentualFallback: money(d.percentualFallback).toFixed(4),
        },
      });

      for (const c of d.contas) {
        await tx.contaProvedor.update({
          where: { id: BigInt(c.id) },
          data: {
            percentualRetencaoMetodo:
              c.percentualRetencaoMetodo == null
                ? null
                : money(c.percentualRetencaoMetodo).toFixed(4),
          },
        });
      }
    });

    return this.obter();
  }
}
