import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { money, PERMISSOES } from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';

const putSchema = z.object({
  ativo: z.boolean(),
  offsetMin: z.number().int().min(0).max(100),
  offsetMax: z.number().int().min(0).max(100),
  toleranciaValor: z.number().finite().nonnegative(),
  contencaoAtiva: z.boolean(),
  percentualContencaoDia: z.number().finite().min(0).max(100),
});

@Controller('admin/med-automatico')
@UseGuards(JwtAuthGuard)
export class AdminMedAutomaticoController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequerPermissao(PERMISSOES.ADMIN_MED_AUTOMATICO_VER)
  async obter() {
    const params =
      (await this.prisma.parametroMedAutomatico.findUnique({ where: { id: 1 } })) ??
      (await this.prisma.parametroMedAutomatico.create({ data: { id: 1 } }));

    return {
      ativo: params.ativo,
      offsetMin: params.offsetMin,
      offsetMax: params.offsetMax,
      toleranciaValor: Number(params.toleranciaValor),
      contencaoAtiva: params.contencaoAtiva,
      percentualContencaoDia: Number(params.percentualContencaoDia),
    };
  }

  @Put()
  @RequerPermissao(PERMISSOES.ADMIN_MED_AUTOMATICO_EDITAR)
  async salvar(@Body() body: unknown) {
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const d = parsed.data;
    if (d.offsetMin > d.offsetMax) {
      throw new BadRequestException('offsetMin não pode ser maior que offsetMax');
    }

    await this.prisma.parametroMedAutomatico.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        ativo: d.ativo,
        offsetMin: d.offsetMin,
        offsetMax: d.offsetMax,
        toleranciaValor: money(d.toleranciaValor).toFixed(2),
        contencaoAtiva: d.contencaoAtiva,
        percentualContencaoDia: money(d.percentualContencaoDia).toFixed(4),
      },
      update: {
        ativo: d.ativo,
        offsetMin: d.offsetMin,
        offsetMax: d.offsetMax,
        toleranciaValor: money(d.toleranciaValor).toFixed(2),
        contencaoAtiva: d.contencaoAtiva,
        percentualContencaoDia: money(d.percentualContencaoDia).toFixed(4),
      },
    });

    return this.obter();
  }
}
