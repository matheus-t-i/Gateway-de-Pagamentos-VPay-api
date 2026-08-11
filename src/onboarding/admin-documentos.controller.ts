import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Logger,
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
  MIMES_DOCUMENTO_PERMITIDOS,
  PERMISSOES,
  SITUACAO_DOCUMENTO,
  TAMANHO_MAX_UPLOAD_BYTES,
  TIPOS_DOCUMENTO,
  validarArquivoDocumento,
  validarDocumentoSchema,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { ErroStorage, abrirArquivo, salvarArquivo } from '../common/storage.util';
import { assertStepUpTotp } from '../common/step-up-totp';
import { mapDocumentoAdmin, reavaliarSituacoes } from './onboarding.util';

type AdminReq = { user: { id: string } };

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminDocumentosController {
  private readonly log = new Logger(AdminDocumentosController.name);

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
    FileInterceptor('arquivo', {
      limits: { fileSize: TAMANHO_MAX_UPLOAD_BYTES },
      fileFilter: (_req, file, cb) => {
        if (
          !(MIMES_DOCUMENTO_PERMITIDOS as readonly string[]).includes(
            file.mimetype,
          )
        ) {
          cb(
            new BadRequestException(
              `Tipo de arquivo não permitido${file.mimetype ? ` (${file.mimetype})` : ''}. Envie apenas PDF, PNG ou JPEG.`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
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
    try {
      validarArquivoDocumento(arquivo);
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Arquivo inválido.',
      );
    }
    const tipoDocumento = body.tipoDocumento ?? TIPOS_DOCUMENTO.CONTRATO_PRESTACAO_SERVICO;
    if (!(Object.values(TIPOS_DOCUMENTO) as string[]).includes(tipoDocumento)) {
      throw new BadRequestException(`tipoDocumento inválido: ${tipoDocumento}`);
    }
    const usuario = await this.prisma.usuario.findUnique({ where: { idPublico } });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    let salvo: Awaited<ReturnType<typeof salvarArquivo>>;
    try {
      salvo = await salvarArquivo('usuarios', usuario.id, arquivo);
    } catch (e) {
      if (e instanceof ErroStorage) {
        // O motivo real vai para o log da plataforma; o admin recebe uma
        // mensagem que diz onde olhar, em vez de "Internal server error".
        this.log.error(`upload de documento falhou: ${e.message}`, e.causa);
        throw new InternalServerErrorException(
          'Falha ao gravar o documento no armazenamento. Verifique a configuração do bucket (STORAGE_DRIVER/S3_*) e tente de novo.',
        );
      }
      throw e;
    }
    /**
     * `reavaliarSituacoes` no MESMO commit, como no `validar`: quando a VPay
     * sobe a documentação que faltava (o cliente mandou por e-mail, WhatsApp,
     * presencial), a conta precisa sair de `PENDENTE` para `EM_ANALISE`. Sem
     * isso ela ficava `PENDENTE` com a documentação completa — e como o botão
     * de aprovação normal só aparece em `EM_ANALISE`, o admin era empurrado
     * para a ativação por EXCEÇÃO tendo todos os documentos na mão.
     *
     * Conta já ATIVA não é afetada: nenhum dos ramos da reavaliação casa com
     * ela (é o caso de quem foi ativado sem documentação e recebe os arquivos
     * depois).
     */
    const doc = await this.prisma.$transaction(async (tx) => {
      const criado = await tx.documentoUsuario.create({
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
      await reavaliarSituacoes(tx, usuario.id);
      return criado;
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
