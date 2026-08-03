import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { criarCredencialApiSchema, PAPEIS, SITUACAO_EMPRESA } from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('empresas/:empresaIdPublico/credenciais')
@UseGuards(JwtAuthGuard)
export class CredenciaisController {
  constructor(private readonly prisma: PrismaService) {}

  private async getEmpresaOwned(idPublico: string, userId: string, papeis: string[]) {
    const empresa = await this.prisma.empresa.findUnique({ where: { idPublico } });
    if (!empresa) throw new BadRequestException('Empresa não encontrada');
    const isAdmin = papeis.includes(PAPEIS.ADMINISTRADOR);
    if (!isAdmin && empresa.usuarioProprietarioId.toString() !== userId) {
      throw new BadRequestException('Sem acesso');
    }
    if (empresa.situacao !== SITUACAO_EMPRESA.ATIVA && !isAdmin) {
      throw new BadRequestException('Empresa não ativa');
    }
    return empresa;
  }

  @Get()
  async listar(
    @Param('empresaIdPublico') empresaIdPublico: string,
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    const empresa = await this.getEmpresaOwned(
      empresaIdPublico,
      req.user.id,
      req.user.papeis,
    );
    const list = await this.prisma.credencialApi.findMany({
      where: { empresaId: empresa.id },
      include: { ipsPermitidos: true },
      orderBy: { criadoEm: 'desc' },
    });
    return list.map((c) => ({
      id: c.id.toString(),
      nome: c.nome,
      chavePublica: c.chavePublica,
      escopos: c.escopos,
      ativo: c.ativo,
      ipsPermitidos: c.ipsPermitidos.map((i) => i.ipOuCidr),
      criadoEm: c.criadoEm,
    }));
  }

  @Post()
  async criar(
    @Param('empresaIdPublico') empresaIdPublico: string,
    @Req() req: { user: { id: string; papeis: string[] } },
    @Body() body: unknown,
  ) {
    const parsed = criarCredencialApiSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const empresa = await this.getEmpresaOwned(
      empresaIdPublico,
      req.user.id,
      req.user.papeis,
    );
    const secret = randomBytes(32).toString('hex');
    const chavePublica = `vp_${randomBytes(16).toString('hex')}`;
    const segredoHash = await argon2.hash(secret);

    const cred = await this.prisma.credencialApi.create({
      data: {
        usuarioId: empresa.usuarioProprietarioId,
        empresaId: empresa.id,
        criadoPorUsuarioId: BigInt(req.user.id),
        nome: parsed.data.nome,
        chavePublica,
        segredoHash,
        escopos: parsed.data.escopos,
        ipsPermitidos: {
          create: parsed.data.ipsPermitidos.map((ip) => ({ ipOuCidr: ip })),
        },
      },
    });

    return {
      id: cred.id.toString(),
      nome: cred.nome,
      chavePublica,
      segredo: secret,
      aviso: 'O segredo é exibido apenas uma vez',
    };
  }

  @Delete(':id')
  async revogar(
    @Param('empresaIdPublico') empresaIdPublico: string,
    @Param('id') id: string,
    @Req() req: { user: { id: string; papeis: string[] } },
  ) {
    const empresa = await this.getEmpresaOwned(
      empresaIdPublico,
      req.user.id,
      req.user.papeis,
    );
    await this.prisma.credencialApi.updateMany({
      where: { id: BigInt(id), empresaId: empresa.id },
      data: { ativo: false, revogadoEm: new Date() },
    });
    return { ok: true };
  }
}
