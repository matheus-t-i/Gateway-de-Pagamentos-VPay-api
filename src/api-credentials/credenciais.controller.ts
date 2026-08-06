import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import {
  criarCredencialApiSchema,
  editarCredencialApiSchema,
  PERMISSOES,
  SITUACAO_USUARIO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  JwtAuthGuard,
  temEscopoGlobal,
  type UsuarioAutenticado,
} from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';

/**
 * Credenciais de API da CONTA do usuário logado. Não recebe id de conta na URL:
 * a credencial é sempre do titular do JWT — não existe conta de terceiro para
 * um cliente administrar.
 */
@Controller('painel/credenciais')
@UseGuards(JwtAuthGuard)
export class CredenciaisController {
  constructor(private readonly prisma: PrismaService) {}

  private async contaAtiva(user: UsuarioAutenticado) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: BigInt(user.id) },
    });
    if (!usuario) throw new BadRequestException('Conta não encontrada');
    if (usuario.situacao !== SITUACAO_USUARIO.ATIVO && !temEscopoGlobal(user)) {
      throw new BadRequestException('Conta não ativa');
    }
    return usuario;
  }

  @Get()
  @RequerPermissao(PERMISSOES.CHAVES_API_VER)
  async listar(@Req() req: { user: UsuarioAutenticado }) {
    const usuario = await this.contaAtiva(req.user);
    const list = await this.prisma.credencialApi.findMany({
      where: { usuarioId: usuario.id },
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
  @RequerPermissao(PERMISSOES.CHAVES_API_CRIAR)
  async criar(@Req() req: { user: UsuarioAutenticado }, @Body() body: unknown) {
    const parsed = criarCredencialApiSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const usuario = await this.contaAtiva(req.user);
    const secret = randomBytes(32).toString('hex');
    const chavePublica = `vp_${randomBytes(16).toString('hex')}`;
    const segredoHash = await argon2.hash(secret);

    const cred = await this.prisma.credencialApi.create({
      data: {
        usuarioId: usuario.id,
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

  /**
   * Edita uma credencial já emitida: nome e allowlist de IP.
   *
   * A allowlist é **substituída** pela lista enviada (a tela manda o conjunto
   * final), dentro de uma transação — remover os IPs antigos e falhar ao gravar
   * os novos deixaria a credencial aberta para qualquer origem.
   *
   * Credencial revogada não é editada: liberar IP para uma chave morta só
   * confunde quem lê a listagem depois.
   */
  @Put(':id')
  @RequerPermissao(PERMISSOES.CHAVES_API_EDITAR)
  async editar(
    @Param('id') id: string,
    @Req() req: { user: UsuarioAutenticado },
    @Body() body: unknown,
  ) {
    const parsed = editarCredencialApiSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const usuario = await this.contaAtiva(req.user);

    const cred = await this.prisma.credencialApi.findFirst({
      where: { id: BigInt(id), usuarioId: usuario.id },
    });
    if (!cred) throw new BadRequestException('Credencial não encontrada');
    if (!cred.ativo || cred.revogadoEm) {
      throw new BadRequestException('Credencial revogada não pode ser editada.');
    }

    const atualizada = await this.prisma.$transaction(async (tx) => {
      await tx.ipPermitidoApi.deleteMany({ where: { credencialApiId: cred.id } });
      if (parsed.data.ipsPermitidos.length) {
        await tx.ipPermitidoApi.createMany({
          data: parsed.data.ipsPermitidos.map((ip) => ({
            credencialApiId: cred.id,
            ipOuCidr: ip,
          })),
        });
      }
      return tx.credencialApi.update({
        where: { id: cred.id },
        data: { nome: parsed.data.nome },
        include: { ipsPermitidos: true },
      });
    });

    return {
      id: atualizada.id.toString(),
      nome: atualizada.nome,
      chavePublica: atualizada.chavePublica,
      escopos: atualizada.escopos,
      ativo: atualizada.ativo,
      ipsPermitidos: atualizada.ipsPermitidos.map((i) => i.ipOuCidr),
      criadoEm: atualizada.criadoEm,
    };
  }

  @Delete(':id')
  @RequerPermissao(PERMISSOES.CHAVES_API_EXCLUIR)
  async revogar(@Param('id') id: string, @Req() req: { user: UsuarioAutenticado }) {
    const usuario = await this.contaAtiva(req.user);
    await this.prisma.credencialApi.updateMany({
      where: { id: BigInt(id), usuarioId: usuario.id },
      data: { ativo: false, revogadoEm: new Date() },
    });
    return { ok: true };
  }
}
