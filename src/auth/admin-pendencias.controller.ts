import {
  Controller,
  ForbiddenException,
  Get,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  PERMISSOES,
  SITUACAO_CHAVE_PIX,
  SITUACAO_USUARIO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  JwtAuthGuard,
  temPermissao,
  type UsuarioAutenticado,
} from './jwt-auth.guard';

/**
 * Contagem de pendências para os badges do menu lateral do painel.
 *
 * Sem `@RequerPermissao` único de propósito: cada contagem é liberada pela
 * permissão de leitura da própria tela (Aprovações / Chaves PIX) — um perfil
 * que só enxerga uma delas recebe `null` na outra. Quem não tem nenhuma das
 * duas leva 403: a rota não fica aberta a qualquer autenticado.
 */
@Controller('admin/pendencias')
@UseGuards(JwtAuthGuard)
export class AdminPendenciasController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('contagem')
  async contagem(@Req() req: { user: UsuarioAutenticado }) {
    const veAprovacoes = temPermissao(req.user, PERMISSOES.ADMIN_APROVACOES_VER);
    const veChavesPix = temPermissao(req.user, PERMISSOES.ADMIN_CHAVES_PIX_VER);
    if (!veAprovacoes && !veChavesPix) {
      throw new ForbiddenException('Sem permissão para ver pendências.');
    }

    const [aprovacoes, chavesPix] = await Promise.all([
      veAprovacoes
        ? this.prisma.usuario.count({
            where: {
              situacao: {
                in: [
                  SITUACAO_USUARIO.PENDENTE,
                  SITUACAO_USUARIO.EM_ANALISE,
                ] as never[],
              },
            },
          })
        : Promise.resolve(null),
      veChavesPix
        ? this.prisma.chavePixUsuario.count({
            where: { situacao: SITUACAO_CHAVE_PIX.PENDENTE as never },
          })
        : Promise.resolve(null),
    ]);

    return { aprovacoes, chavesPix };
  }
}
