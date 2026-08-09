import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  CATALOGO_PERMISSOES,
  descricaoPermissao,
  PAPEIS,
  PERFIS_SISTEMA,
  permissaoExiste,
  PERMISSOES,
  ROTULO_ACAO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import {
  assertStepUpFromBody,
  assertStepUpTotp,
} from '../common/step-up-totp';

type AdminReq = {
  user: { id: string; papeis: string[]; permissoes: string[] };
  ip?: string;
};

/**
 * Um perfil nunca pode conceder mais poder do que o ator já tem.
 *
 * Sem esta regra, `admin.perfis.editar` valia superusuário: bastava marcar o
 * catálogo inteiro num perfil qualquer (inclusive o próprio, ou o CLIENTE, que
 * todo lojista carrega) para ganhar `escopo.global`, `admin.tesouraria.executar`
 * e `admin.med.decidir`. Como as permissões são reresolvidas no banco a cada
 * request, a concessão passava a valer na requisição seguinte, com o MESMO
 * token — a proteção que existia cobria só o perfil chamado ADMINISTRADOR.
 *
 * ADMINISTRADOR passa direto porque `permissoesEfetivas` já lhe devolve
 * TODAS_PERMISSOES.
 */
function assertPodeConceder(ator: AdminReq['user'], codigos: string[]) {
  if (ator.papeis.includes(PAPEIS.ADMINISTRADOR)) return;
  const alem = codigos.filter((c) => !ator.permissoes.includes(c));
  if (alem.length) {
    throw new BadRequestException(
      'Você não pode conceder permissões que o seu próprio perfil não tem: ' +
        alem.join(', '),
    );
  }
}

/**
 * Nome do perfil é identidade (vai no JWT e é o que `usuarios_papeis` referencia),
 * então é normalizado para um slug estável. O rótulo bonito fica na descrição.
 */
const ACENTOS = /[̀-ͯ]/g;

const nomeSchema = z
  .string()
  .trim()
  .min(2, 'Nome muito curto')
  .max(50, 'Nome muito longo')
  .transform((s) =>
    s
      .normalize('NFD')
      .replace(ACENTOS, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, ''),
  )
  .refine((s) => /^[A-Z][A-Z0-9_]{1,49}$/.test(s), {
    message: 'Nome deve começar com letra e usar apenas letras, números e _',
  });

const permissoesSchema = z
  .array(z.string())
  .max(200)
  .refine((codigos) => codigos.every(permissaoExiste), {
    message: 'Permissão desconhecida no catálogo',
  });

const criarPerfilSchema = z.object({
  nome: nomeSchema,
  descricao: z.string().trim().max(255).optional(),
  ativo: z.boolean().optional(),
  permissoes: permissoesSchema,
  codigoTotp: z.string().regex(/^\d{6}$/),
});

const editarPerfilSchema = z.object({
  nome: nomeSchema.optional(),
  descricao: z.string().trim().max(255).nullable().optional(),
  ativo: z.boolean().optional(),
  permissoes: permissoesSchema.optional(),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

@Controller('admin/perfis')
@UseGuards(JwtAuthGuard)
export class PerfisController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Catálogo de permissões (recurso × ação) para o painel desenhar a matriz.
   * Fica no código, não no banco: a permissão só vale se existir uma rota que a
   * exija, então inventar linha nova no banco não criaria acesso nenhum.
   */
  @Get('catalogo')
  @RequerPermissao(PERMISSOES.ADMIN_PERFIS_VER)
  catalogo() {
    return {
      rotulosAcao: ROTULO_ACAO,
      recursos: CATALOGO_PERMISSOES,
      perfisSistema: PERFIS_SISTEMA,
    };
  }

  /** Listagem paginada + filtros. */
  @Get()
  @RequerPermissao(PERMISSOES.ADMIN_PERFIS_VER)
  async listar(@Query() q: Record<string, string>) {
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(1000, Math.max(5, Number(q.limit) || 10));
    const where: Record<string, unknown> = {};
    const busca = (q.busca ?? '').trim();
    if (busca) {
      where.OR = [
        { nome: { contains: busca, mode: 'insensitive' } },
        { descricao: { contains: busca, mode: 'insensitive' } },
      ];
    }
    if (q.situacao === 'ATIVO') where.ativo = true;
    if (q.situacao === 'INATIVO') where.ativo = false;

    const [total, papeis] = await Promise.all([
      this.prisma.papel.count({ where: where as never }),
      this.prisma.papel.findMany({
        where: where as never,
        orderBy: { nome: 'asc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: { _count: { select: { usuarios: true, permissoes: true } } },
      }),
    ]);

    return {
      pagina,
      limite,
      total,
      itens: papeis.map((p) => ({
        id: p.id.toString(),
        nome: p.nome,
        descricao: p.descricao,
        ativo: p.ativo,
        sistema: PERFIS_SISTEMA.includes(p.nome),
        totalUsuarios: p._count.usuarios,
        totalPermissoes: p._count.permissoes,
        criadoEm: p.criadoEm.toISOString(),
      })),
    };
  }

  @Get(':id')
  @RequerPermissao(PERMISSOES.ADMIN_PERFIS_VER)
  async detalhe(@Param('id') id: string) {
    const papel = await this.carregar(id);
    return {
      id: papel.id.toString(),
      nome: papel.nome,
      descricao: papel.descricao,
      ativo: papel.ativo,
      sistema: PERFIS_SISTEMA.includes(papel.nome),
      totalUsuarios: papel._count.usuarios,
      permissoes: papel.permissoes.map((pp) => pp.permissao.codigo),
    };
  }

  @Post()
  @RequerPermissao(PERMISSOES.ADMIN_PERFIS_CRIAR)
  async criar(@Body() body: unknown, @Req() req: AdminReq) {
    const parsed = criarPerfilSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    const { nome, descricao, ativo, permissoes } = parsed.data;

    assertPodeConceder(req.user, permissoes);

    const jaExiste = await this.prisma.papel.findUnique({ where: { nome } });
    if (jaExiste) throw new BadRequestException(`Já existe um perfil "${nome}".`);

    const ids = await this.idsDasPermissoes(permissoes);
    const criado = await this.prisma.$transaction(async (tx) => {
      const papel = await tx.papel.create({
        data: {
          nome,
          descricao: descricao || null,
          ativo: ativo ?? true,
          permissoes: { create: ids.map((permissaoId) => ({ permissaoId })) },
        },
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'PERFIL_CRIAR',
          nomeTabela: 'papeis',
          chaveRegistro: papel.id.toString(),
          enderecoIp: req.ip,
          dadosNovos: { nome, descricao, ativo: ativo ?? true, permissoes } as never,
        },
      });
      return papel;
    });

    return { id: criado.id.toString(), nome: criado.nome };
  }

  @Put(':id')
  @RequerPermissao(PERMISSOES.ADMIN_PERFIS_EDITAR)
  async editar(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AdminReq,
  ) {
    const parsed = editarPerfilSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    const papel = await this.carregar(id);
    const sistema = PERFIS_SISTEMA.includes(papel.nome);
    const dados = parsed.data;

    // Perfil de sistema: nome e situação são intocáveis. CLIENTE é vinculado por
    // NOME no cadastro e ADMINISTRADOR é a única saída de um lockout — renomear
    // ou inativar qualquer um dos dois quebra o sistema em silêncio.
    if (sistema && dados.nome && dados.nome !== papel.nome) {
      throw new BadRequestException(
        `O perfil ${papel.nome} é de sistema e não pode ser renomeado.`,
      );
    }
    if (sistema && dados.ativo === false) {
      throw new BadRequestException(
        `O perfil ${papel.nome} é de sistema e não pode ser inativado.`,
      );
    }
    if (papel.nome === PAPEIS.ADMINISTRADOR && dados.permissoes) {
      throw new BadRequestException(
        'O perfil ADMINISTRADOR sempre tem todas as permissões.',
      );
    }
    if (dados.permissoes) assertPodeConceder(req.user, dados.permissoes);
    if (dados.nome && dados.nome !== papel.nome) {
      const conflito = await this.prisma.papel.findUnique({
        where: { nome: dados.nome },
      });
      if (conflito) {
        throw new BadRequestException(`Já existe um perfil "${dados.nome}".`);
      }
    }

    const anteriores = papel.permissoes.map((pp) => pp.permissao.codigo);
    const ids = dados.permissoes
      ? await this.idsDasPermissoes(dados.permissoes)
      : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.papel.update({
        where: { id: papel.id },
        data: {
          nome: dados.nome ?? undefined,
          descricao: dados.descricao === undefined ? undefined : dados.descricao,
          ativo: dados.ativo ?? undefined,
        },
      });
      if (ids) {
        await tx.papelPermissao.deleteMany({ where: { papelId: papel.id } });
        if (ids.length) {
          await tx.papelPermissao.createMany({
            data: ids.map((permissaoId) => ({ papelId: papel.id, permissaoId })),
          });
        }
      }
      await tx.registroAuditoria.create({
        data: {
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'PERFIL_EDITAR',
          nomeTabela: 'papeis',
          chaveRegistro: papel.id.toString(),
          enderecoIp: req.ip,
          dadosAnteriores: {
            nome: papel.nome,
            descricao: papel.descricao,
            ativo: papel.ativo,
            permissoes: anteriores,
          } as never,
          dadosNovos: {
            nome: dados.nome ?? papel.nome,
            descricao:
              dados.descricao === undefined ? papel.descricao : dados.descricao,
            ativo: dados.ativo ?? papel.ativo,
            permissoes: dados.permissoes ?? anteriores,
          } as never,
        },
      });
    });

    return { ok: true };
  }

  @Delete(':id')
  @RequerPermissao(PERMISSOES.ADMIN_PERFIS_EXCLUIR)
  async excluir(
    @Param('id') id: string,
    @Req() req: AdminReq,
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
    const papel = await this.carregar(id);
    if (PERFIS_SISTEMA.includes(papel.nome)) {
      throw new BadRequestException(
        `O perfil ${papel.nome} é de sistema e não pode ser excluído.`,
      );
    }
    if (papel._count.usuarios > 0) {
      throw new BadRequestException(
        `Há ${papel._count.usuarios} usuário(s) com este perfil. ` +
          'Troque o perfil deles antes de excluir (ou apenas inative o perfil).',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.papelPermissao.deleteMany({ where: { papelId: papel.id } });
      await tx.papel.delete({ where: { id: papel.id } });
      await tx.registroAuditoria.create({
        data: {
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'PERFIL_EXCLUIR',
          nomeTabela: 'papeis',
          chaveRegistro: papel.id.toString(),
          enderecoIp: req.ip,
          dadosAnteriores: {
            nome: papel.nome,
            permissoes: papel.permissoes.map((pp) => pp.permissao.codigo),
          } as never,
        },
      });
    });

    return { ok: true };
  }

  private async carregar(id: string) {
    let papelId: bigint;
    try {
      papelId = BigInt(id);
    } catch {
      throw new NotFoundException('Perfil não encontrado');
    }
    const papel = await this.prisma.papel.findUnique({
      where: { id: papelId },
      include: {
        permissoes: { include: { permissao: true } },
        _count: { select: { usuarios: true } },
      },
    });
    if (!papel) throw new NotFoundException('Perfil não encontrado');
    return papel;
  }

  /**
   * Resolve códigos → ids, criando a linha que faltar. O catálogo vive no código
   * e a tabela é só o espelho; sem isto, um perfil só conseguiria receber as
   * permissões que o último `db:seed` tivesse gravado.
   */
  private async idsDasPermissoes(codigos: string[]): Promise<bigint[]> {
    if (!codigos.length) return [];
    const unicos = Array.from(new Set(codigos));
    const existentes = await this.prisma.permissao.findMany({
      where: { codigo: { in: unicos } },
    });
    const porCodigo = new Map(existentes.map((p) => [p.codigo, p.id]));
    const faltando = unicos.filter((c) => !porCodigo.has(c));
    for (const codigo of faltando) {
      const criada = await this.prisma.permissao.create({
        data: { codigo, descricao: descricaoPermissao(codigo).slice(0, 255) },
      });
      porCodigo.set(codigo, criada.id);
    }
    return unicos.map((c) => porCodigo.get(c) as bigint);
  }
}
