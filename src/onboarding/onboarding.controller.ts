import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as argon2 from 'argon2';
import {
  onboardingCredenciaisSchema,
  SITUACAO_DOCUMENTO,
  SITUACAO_USUARIO,
  TIPOS_DOCUMENTO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { salvarArquivo } from '../common/storage.util';
import { montarStatusOnboarding, reavaliarSituacoes } from './onboarding.util';
import { Throttle } from '../common/ip-throttle.guard';

const MIMES_PERMITIDOS = ['application/pdf', 'image/jpeg', 'image/png'];
const TAMANHO_MAXIMO_BYTES = 10 * 1024 * 1024; // 10MB
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
      limits: { fileSize: TAMANHO_MAXIMO_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!MIMES_PERMITIDOS.includes(file.mimetype)) {
          cb(
            new BadRequestException(
              `Tipo de arquivo não permitido: ${file.mimetype}`,
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
      alvo?: string;
      tipoDocumento?: string;
      empresaIdPublico?: string;
    },
    @UploadedFile() arquivo?: Express.Multer.File,
  ) {
    const usuario = await this.autenticar(body?.email, body?.senha);

    if (!arquivo) {
      throw new BadRequestException('Arquivo ausente (campo "arquivo").');
    }
    const alvo = (body.alvo ?? '').toUpperCase();
    if (alvo !== 'USUARIO' && alvo !== 'EMPRESA') {
      throw new BadRequestException('alvo deve ser USUARIO ou EMPRESA.');
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
    // Cota anti-abuso do canal público.
    const [docsUsuario, docsEmpresas] = await Promise.all([
      this.prisma.documentoUsuario.count({ where: { usuarioId: usuario.id } }),
      this.prisma.documentoEmpresa.count({
        where: { empresa: { usuarioProprietarioId: usuario.id } },
      }),
    ]);
    if (docsUsuario + docsEmpresas >= MAX_DOCUMENTOS_POR_CONTA) {
      throw new BadRequestException(
        'Limite de documentos atingido. Fale com o suporte para reenviar.',
      );
    }

    if (alvo === 'USUARIO') {
      const salvo = await salvarArquivo('usuarios', usuario.id, arquivo);
      await this.prisma.$transaction(async (tx) => {
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
    } else {
      const empresa = await this.prisma.empresa.findUnique({
        where: { idPublico: body.empresaIdPublico ?? '' },
      });
      if (!empresa || empresa.usuarioProprietarioId !== usuario.id) {
        throw new BadRequestException('Empresa não encontrada para este usuário.');
      }
      const salvo = await salvarArquivo('empresas', empresa.id, arquivo);
      await this.prisma.$transaction(async (tx) => {
        await tx.documentoEmpresa.create({
          data: {
            empresaId: empresa.id,
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
    }

    return montarStatusOnboarding(this.prisma, usuario.id);
  }

}
