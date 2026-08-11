import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as argon2 from 'argon2';
import {
  MIMES_DOCUMENTO_PERMITIDOS,
  onboardingCredenciaisSchema,
  SITUACAO_DOCUMENTO,
  SITUACAO_USUARIO,
  TAMANHO_MAX_UPLOAD_BYTES,
  TIPOS_DOCUMENTO,
  validarArquivoDocumento,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { removerArquivo, salvarArquivo } from '../common/storage.util';
import { montarStatusOnboarding, reavaliarSituacoes } from './onboarding.util';
import { Throttle } from '../common/ip-throttle.guard';

const TIPOS_VALIDOS = Object.values(TIPOS_DOCUMENTO) as string[];
/**
 * Cota por conta no canal público (sem JWT). Sem isto, quem tem uma credencial
 * válida pode reenviar documentos indefinidamente e encher o disco do servidor.
 */
const MAX_DOCUMENTOS_POR_CONTA = 30;

/**
 * Onboarding público (sem JWT). Autoriza reverificando e-mail+senha (argon2) a
 * cada request. Conta APROVADA nunca passa por aqui — deve usar o login normal.
 * Nenhum endpoint aqui emite token.
 */
// Reverifica argon2 a cada request → alvo de brute force. Freio por IP.
@Throttle({ limit: 30, windowSec: 60 })
@Controller('onboarding')
export class OnboardingController {
  private readonly log = new Logger(OnboardingController.name);

  constructor(private readonly prisma: PrismaService) {}

  private async autenticar(email: unknown, senha: unknown) {
    const parsed = onboardingCredenciaisSchema.safeParse({ email, senha });
    if (!parsed.success) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const usuario = await this.prisma.usuario.findUnique({
      where: { email: parsed.data.email },
    });
    if (!usuario || usuario.contaBloqueada) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const ok = await argon2.verify(usuario.senhaHash, parsed.data.senha);
    if (!ok) {
      // Mesmo tratamento anti brute-force do login: registra a falha e bloqueia
      // a conta após 5 tentativas em 15 minutos (senão o onboarding viraria um
      // canal de força bruta sem lockout).
      await this.prisma.auditoriaAcesso.create({
        data: {
          usuarioId: usuario.id,
          emailInformado: parsed.data.email,
          sucesso: false,
          motivo: 'SENHA_INVALIDA_ONBOARDING',
        },
      });
      // Lockout temporário (janela deslizante) — nunca bloqueio permanente,
      // que permitiria derrubar a conta alheia só errando a senha.
      const falhas = await this.prisma.auditoriaAcesso.count({
        where: {
          usuarioId: usuario.id,
          sucesso: false,
          ocorridoEm: { gte: new Date(Date.now() - 15 * 60 * 1000) },
        },
      });
      if (falhas >= 5) {
        throw new UnauthorizedException(
          'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
        );
      }
      throw new UnauthorizedException('Credenciais inválidas');
    }
    if (usuario.situacao === SITUACAO_USUARIO.ATIVO) {
      throw new BadRequestException('Conta já ativa. Use o login.');
    }
    return usuario;
  }

  @Post('status')
  async status(@Body() body: { email?: string; senha?: string }) {
    const usuario = await this.autenticar(body?.email, body?.senha);
    return montarStatusOnboarding(this.prisma, usuario.id);
  }

  @Post('documentos')
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
  async enviarDocumento(
    @Body()
    body: {
      email?: string;
      senha?: string;
      tipoDocumento?: string;
    },
    @UploadedFile() arquivo?: Express.Multer.File,
  ) {
    const usuario = await this.autenticar(body?.email, body?.senha);

    if (!arquivo) {
      throw new BadRequestException('Arquivo ausente (campo "arquivo").');
    }
    try {
      validarArquivoDocumento(arquivo);
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Arquivo inválido.',
      );
    }
    const tipoDocumento = body.tipoDocumento ?? '';
    if (!TIPOS_VALIDOS.includes(tipoDocumento)) {
      throw new BadRequestException(`tipoDocumento inválido: ${tipoDocumento}`);
    }
    // O cliente não sobe o contrato de prestação de serviço — quem sobe é a VPay.
    if (tipoDocumento === TIPOS_DOCUMENTO.CONTRATO_PRESTACAO_SERVICO) {
      throw new BadRequestException(
        'Este documento é enviado pela equipe após a assinatura.',
      );
    }

    const existentes = await this.prisma.documentoUsuario.findMany({
      where: { usuarioId: usuario.id, tipoDocumento },
      select: { id: true, situacao: true, caminhoArquivo: true },
    });
    // Já tem PENDENTE/VALIDO → não cria segunda via. INVALIDO → substitui.
    if (
      existentes.some(
        (d) =>
          d.situacao === SITUACAO_DOCUMENTO.PENDENTE ||
          d.situacao === SITUACAO_DOCUMENTO.VALIDO,
      )
    ) {
      throw new BadRequestException(
        'Este documento já foi enviado. Aguarde a análise ou, se foi invalidado, use o reenvio.',
      );
    }
    const invalidos = existentes.filter(
      (d) => d.situacao === SITUACAO_DOCUMENTO.INVALIDO,
    );

    // Cota anti-abuso do canal público (reenvio de inválido não soma: apaga o antigo).
    const enviados = await this.prisma.documentoUsuario.count({
      where: { usuarioId: usuario.id },
    });
    const aposSubstituicao = enviados - invalidos.length + 1;
    if (aposSubstituicao > MAX_DOCUMENTOS_POR_CONTA) {
      throw new BadRequestException(
        'Limite de documentos atingido. Fale com o suporte para reenviar.',
      );
    }

    const salvo = await salvarArquivo('usuarios', usuario.id, arquivo);
    await this.prisma.$transaction(async (tx) => {
      if (invalidos.length > 0) {
        await tx.documentoUsuario.deleteMany({
          where: { id: { in: invalidos.map((d) => d.id) } },
        });
      }
      await tx.documentoUsuario.create({
        data: {
          usuarioId: usuario.id,
          tipoDocumento,
          nomeArquivo: salvo.nomeArquivo,
          caminhoArquivo: salvo.caminhoArquivo,
          tipoMime: salvo.tipoMime,
          tamanhoBytes: BigInt(salvo.tamanhoBytes),
          hashArquivo: salvo.hashArquivo,
          situacao: SITUACAO_DOCUMENTO.PENDENTE,
        },
      });
      await reavaliarSituacoes(tx, usuario.id);
    });

    // Depois do commit: apaga o binário antigo. Falha aqui não desfaz o reenvio.
    for (const antigo of invalidos) {
      try {
        await removerArquivo(antigo.caminhoArquivo);
      } catch (e) {
        this.log.warn(
          `falha ao apagar arquivo antigo do documento ${antigo.id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    return montarStatusOnboarding(this.prisma, usuario.id);
  }

}
