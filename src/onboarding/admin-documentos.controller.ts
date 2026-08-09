import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  PERMISSOES,
  SITUACAO_DOCUMENTO,
  TIPOS_DOCUMENTO,
  validarDocumentoSchema,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { abrirArquivo, salvarArquivo } from '../common/storage.util';
import { assertStepUpTotp } from '../common/step-up-totp';
import { mapDocumentoAdmin, reavaliarSituacoes } from './onboarding.util';

type AdminReq = { user: { id: string } };

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminDocumentosController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('usuarios/:idPublico/documentos')
  @RequerPermissao(PERMISSOES.ADMIN_APROVACOES_VER)
  async listarDocsUsuario(@Param('idPublico') idPublico: string) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { idPublico },
      include: { documentos: { orderBy: { enviadoEm: 'desc' } } },
    });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');
    return {
      idPublico: usuario.idPublico,
      situacao: usuario.situacao,
      documentos: usuario.documentos.map(mapDocumentoAdmin),
    };
  }

  /**
   * Upload feito pela VPay (ex.: contrato de prestação de serviço assinado).
   * Entra direto como VALIDO, validado pelo admin que subiu.
   */
  @Post('usuarios/:idPublico/documentos')
  @UseInterceptors(
    FileInterceptor('arquivo', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  @RequerPermissao(PERMISSOES.ADMIN_APROVACOES_APROVAR)
  async subirDocUsuario(
    @Param('idPublico') idPublico: string,
    @Body() body: { tipoDocumento?: string; codigoTotp?: string },
    @Req() req: AdminReq,
    @UploadedFile() arquivo?: Express.Multer.File,
  ) {
    await assertStepUpTotp(this.prisma, req.user.id, body?.codigoTotp);
    if (!arquivo) throw new BadRequestException('Arquivo ausente (campo "arquivo").');
    const tipoDocumento = body.tipoDocumento ?? TIPOS_DOCUMENTO.CONTRATO_PRESTACAO_SERVICO;
    if (!(Object.values(TIPOS_DOCUMENTO) as string[]).includes(tipoDocumento)) {
      throw new BadRequestException(`tipoDocumento inválido: ${tipoDocumento}`);
    }
    const usuario = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    const salvo = await salvarArquivo('usuarios', usuario.id, arquivo);
    const doc = await this.prisma.documentoUsuario.create({
      data: {
        usuarioId: usuario.id,
        tipoDocumento,
        nomeArquivo: salvo.nomeArquivo,
        caminhoArquivo: salvo.caminhoArquivo,
        tipoMime: salvo.tipoMime,
        tamanhoBytes: BigInt(salvo.tamanhoBytes),
        hashArquivo: salvo.hashArquivo,
        situacao: SITUACAO_DOCUMENTO.VALIDO,
        validadoPorUsuarioId: BigInt(req.user.id),
        validadoEm: new Date(),
      },
    });
    return { ok: true, id: doc.id.toString(), tipoDocumento };
  }

  @Get('documentos/:id/arquivo')
  @RequerPermissao(PERMISSOES.ADMIN_APROVACOES_VER)
  async baixar(@Param('id') id: string): Promise<StreamableFile> {
    const doc = await this.prisma.documentoUsuario.findUnique({
      where: { id: BigInt(id) },
    });
    if (!doc) throw new NotFoundException('Documento não encontrado');
    return await abrirArquivo(doc.caminhoArquivo);
  }

  @Post('documentos/:id/validar')
  @RequerPermissao(PERMISSOES.ADMIN_APROVACOES_APROVAR)
  async validar(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AdminReq,
  ) {
    const parsed = validarDocumentoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    const { situacao, motivo } = parsed.data;

    const data = {
      situacao,
      // trim: window.prompt devolve '' quando o analista confirma vazio, e ''
      // com ?? passaria adiante sem motivo nenhum.
      motivoInvalidacao:
        situacao === SITUACAO_DOCUMENTO.INVALIDO
          ? (motivo?.trim() || 'Documento inválido')
          : null,
      validadoPorUsuarioId: BigInt(req.user.id),
      validadoEm: new Date(),
    };

    // Invalidar um documento obrigatório precisa devolver a conta para PENDENTE:
    // sem isto ela seguiria na fila de aprovação sem a documentação exigida.
    await this.prisma.$transaction(async (tx) => {
      const doc = await tx.documentoUsuario.update({
        where: { id: BigInt(id) },
        data,
      });
      await reavaliarSituacoes(tx, doc.usuarioId);
    });
    return { ok: true, id, situacao };
  }
}
