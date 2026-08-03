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
  PAPEIS,
  SITUACAO_DOCUMENTO,
  TIPOS_DOCUMENTO,
  validarDocumentoSchema,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { abrirArquivo, salvarArquivo } from '../common/storage.util';
import { reavaliarSituacoes } from './onboarding.util';

type AdminReq = { user: { id: string; papeis: string[] } };

function assertAdmin(req: AdminReq) {
  if (!req.user.papeis.includes(PAPEIS.ADMINISTRADOR)) {
    throw new BadRequestException('Somente ADMINISTRADOR');
  }
}

function mapDoc(d: {
  idPublico?: string;
  id: bigint;
  tipoDocumento: string;
  nomeArquivo: string;
  tipoMime: string | null;
  tamanhoBytes: bigint | null;
  situacao: string;
  motivoInvalidacao: string | null;
  enviadoEm: Date;
  validadoEm: Date | null;
}) {
  return {
    id: d.id.toString(),
    tipoDocumento: d.tipoDocumento,
    nomeArquivo: d.nomeArquivo,
    tipoMime: d.tipoMime,
    tamanhoBytes: d.tamanhoBytes ? Number(d.tamanhoBytes) : null,
    situacao: d.situacao,
    motivoInvalidacao: d.motivoInvalidacao,
    enviadoEm: d.enviadoEm.toISOString(),
    validadoEm: d.validadoEm ? d.validadoEm.toISOString() : null,
  };
}

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminDocumentosController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('usuarios/:idPublico/documentos')
  async listarDocsUsuario(
    @Param('idPublico') idPublico: string,
    @Req() req: AdminReq,
  ) {
    assertAdmin(req);
    const usuario = await this.prisma.usuario.findUnique({
      where: { idPublico },
      include: { documentos: { orderBy: { enviadoEm: 'desc' } } },
    });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');
    return {
      idPublico: usuario.idPublico,
      situacao: usuario.situacao,
      documentos: usuario.documentos.map(mapDoc),
    };
  }

  @Get('empresas/:idPublico/documentos')
  async listarDocsEmpresa(
    @Param('idPublico') idPublico: string,
    @Req() req: AdminReq,
  ) {
    assertAdmin(req);
    const empresa = await this.prisma.empresa.findUnique({
      where: { idPublico },
      include: { documentos: { orderBy: { enviadoEm: 'desc' } } },
    });
    if (!empresa) throw new NotFoundException('Empresa não encontrada');
    return {
      idPublico: empresa.idPublico,
      situacao: empresa.situacao,
      documentos: empresa.documentos.map(mapDoc),
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
  async subirDocUsuario(
    @Param('idPublico') idPublico: string,
    @Body() body: { tipoDocumento?: string },
    @Req() req: AdminReq,
    @UploadedFile() arquivo?: Express.Multer.File,
  ) {
    assertAdmin(req);
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

  @Get('documentos/:escopo/:id/arquivo')
  async baixar(
    @Param('escopo') escopo: string,
    @Param('id') id: string,
    @Req() req: AdminReq,
  ): Promise<StreamableFile> {
    assertAdmin(req);
    const doc = await this.carregarDoc(escopo, id);
    return abrirArquivo(doc.caminhoArquivo);
  }

  @Post('documentos/:escopo/:id/validar')
  async validar(
    @Param('escopo') escopo: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AdminReq,
  ) {
    assertAdmin(req);
    const parsed = validarDocumentoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
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
      let usuarioId: bigint;
      if (this.escopoUsuario(escopo)) {
        const doc = await tx.documentoUsuario.update({
          where: { id: BigInt(id) },
          data,
        });
        usuarioId = doc.usuarioId;
      } else {
        const doc = await tx.documentoEmpresa.update({
          where: { id: BigInt(id) },
          data,
          include: { empresa: { select: { usuarioProprietarioId: true } } },
        });
        usuarioId = doc.empresa.usuarioProprietarioId;
      }
      await reavaliarSituacoes(tx, usuarioId);
    });
    return { ok: true, id, situacao };
  }

  private escopoUsuario(escopo: string): boolean {
    if (escopo === 'usuario') return true;
    if (escopo === 'empresa') return false;
    throw new BadRequestException('escopo deve ser usuario ou empresa');
  }

  private async carregarDoc(escopo: string, id: string) {
    const doc = this.escopoUsuario(escopo)
      ? await this.prisma.documentoUsuario.findUnique({ where: { id: BigInt(id) } })
      : await this.prisma.documentoEmpresa.findUnique({ where: { id: BigInt(id) } });
    if (!doc) throw new NotFoundException('Documento não encontrado');
    return doc;
  }
}
