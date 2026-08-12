import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  chavePixValida,
  criarChavePixSchema,
  decidirChavePixSchema,
  editarChavePixAdminSchema,
  isCnpj,
  isCpf,
  normalizarChavePixCadastro,
  ORIGEM_HISTORICO_CHAVE_PIX,
  PERMISSOES,
  revogarChavePixSchema,
  SITUACAO_CHAVE_PIX,
  SITUACOES_CHAVE_PIX_RECADASTRAVEIS,
  SITUACAO_USUARIO,
  TIPOS_CHAVE_PIX,
  TIPOS_EMAIL,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { JwtAuthGuard, type UsuarioAutenticado } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import {
  assertStepUpFromBody,
  assertStepUpTotp,
} from '../common/step-up-totp';

type Req = { user: UsuarioAutenticado };

/** Viva = ainda pode sacar ou está na fila. Inativa/revogada/reprovada não conta. */
const SITUACOES_CHAVE_VIVA = [
  SITUACAO_CHAVE_PIX.PENDENTE,
  SITUACAO_CHAVE_PIX.APROVADA,
] as const;

function mapOutraConta(o: {
  situacao: string;
  usuario: { idPublico: string; nomeRazaoSocial: string; cpfCnpj: string };
}) {
  return {
    idPublico: o.usuario.idPublico,
    nome: o.usuario.nomeRazaoSocial,
    cpfCnpj: o.usuario.cpfCnpj,
    situacao: o.situacao,
  };
}

function mapChave(c: {
  idPublico: string;
  apelido: string | null;
  chave: string;
  tipoChave: string;
  nomeTitular: string | null;
  documentoTitular: string | null;
  situacao: string;
  motivoReprovacao: string | null;
  aprovadaEm: Date | null;
  criadoEm: Date;
}) {
  return {
    idPublico: c.idPublico,
    apelido: c.apelido,
    chave: c.chave,
    tipoChave: c.tipoChave,
    nomeTitular: c.nomeTitular,
    documentoTitular: c.documentoTitular,
    situacao: c.situacao,
    motivoReprovacao: c.motivoReprovacao,
    aprovadaEm: c.aprovadaEm,
    criadoEm: c.criadoEm,
  };
}

/**
 * Chaves PIX de saque do cliente. O cliente cadastra; o saque pelo painel só é
 * liberado depois que um ADMINISTRADOR aprova a chave.
 */
@Controller('painel/chaves-pix')
@UseGuards(JwtAuthGuard)
export class ChavesPixController {
  constructor(private readonly prisma: PrismaService) {}

  private async conta(user: Req['user']) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: BigInt(user.id) },
    });
    if (!usuario) throw new NotFoundException('Conta não encontrada');
    return usuario;
  }

  /**
   * Outras contas que já têm esta chave viva. Só devolve as do MESMO titular
   * (CPF/CNPJ ou responsável iguais) — nome de conta alheia não vaza para o
   * lojista. O analista vê o cruzamento completo em `/admin/chaves-pix`.
   */
  @Get('ocorrencias')
  @RequerPermissao(PERMISSOES.CHAVES_PIX_VER)
  async ocorrencias(
    @Req() req: Req,
    @Query('chave') chaveBruta: string | undefined,
    @Query('tipoChave') tipoChave: string | undefined,
  ) {
    if (!tipoChave || !TIPOS_CHAVE_PIX.includes(tipoChave as never)) {
      throw new BadRequestException('tipoChave inválido');
    }
    const chave = normalizarChavePixCadastro(tipoChave, chaveBruta ?? '');
    if (!chavePixValida(tipoChave, chave)) {
      return { outrasContas: [] as ReturnType<typeof mapOutraConta>[] };
    }
    const eu = await this.conta(req.user);
    const irmas = await this.prisma.chavePixUsuario.findMany({
      where: {
        chave,
        usuarioId: { not: eu.id },
        situacao: { in: [...SITUACOES_CHAVE_VIVA] as never[] },
      },
      include: {
        usuario: {
          select: {
            idPublico: true,
            nomeRazaoSocial: true,
            cpfCnpj: true,
            cpfResponsavel: true,
          },
        },
      },
    });
    const meusDocs = [eu.cpfCnpj, eu.cpfResponsavel].filter(Boolean);
    return {
      outrasContas: irmas
        .filter((o) => {
          const docs = [o.usuario.cpfCnpj, o.usuario.cpfResponsavel].filter(
            Boolean,
          );
          return docs.some((d) => meusDocs.includes(d));
        })
        .map(mapOutraConta),
    };
  }

  @Get()
  @RequerPermissao(PERMISSOES.CHAVES_PIX_VER)
  async listar(@Req() req: Req) {
    const rows = await this.prisma.chavePixUsuario.findMany({
      where: {
        usuarioId: BigInt(req.user.id),
        situacao: {
          in: [
            SITUACAO_CHAVE_PIX.PENDENTE,
            SITUACAO_CHAVE_PIX.APROVADA,
            SITUACAO_CHAVE_PIX.REPROVADA,
          ] as never[],
        },
      },
      orderBy: { criadoEm: 'desc' },
    });
    return rows.map(mapChave);
  }

  /**
   * Cadastra a chave — ou RECADASTRA uma que já saiu de circulação.
   *
   * Recadastro reutiliza a MESMA linha (a unique é `usuarioId + chave`): sem
   * isso, uma chave reprovada/revogada/removida travava para sempre em 409 e o
   * cliente não tinha como pedir análise de novo. Reaproveitar a linha também
   * preserva a trilha em `historicos_chave_pix`, que é o que avisa o analista
   * de que aquela chave JÁ passou por aqui — e por que saiu.
   */
  @Post()
  @RequerPermissao(PERMISSOES.CHAVES_PIX_CRIAR)
  async criar(@Body() body: unknown, @Req() req: Req) {
    const parsed = criarChavePixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);
    const usuario = await this.conta(req.user);
    if (usuario.situacao !== SITUACAO_USUARIO.ATIVO) {
      throw new BadRequestException('Conta não está ativa.');
    }

    const dados = {
      apelido: parsed.data.apelido,
      tipoChave: parsed.data.tipoChave,
      nomeTitular: parsed.data.nomeTitular,
      documentoTitular: parsed.data.documentoTitular,
    };

    const existente = await this.prisma.chavePixUsuario.findUnique({
      where: { usuarioId_chave: { usuarioId: usuario.id, chave: parsed.data.chave } },
    });

    if (existente) {
      if (existente.situacao === SITUACAO_CHAVE_PIX.PENDENTE) {
        throw new BadRequestException(
          'Esta chave já está aguardando análise nesta conta.',
        );
      }
      if (existente.situacao === SITUACAO_CHAVE_PIX.APROVADA) {
        throw new BadRequestException(
          'Esta chave já está cadastrada e aprovada nesta conta.',
        );
      }
      if (!SITUACOES_CHAVE_PIX_RECADASTRAVEIS.includes(existente.situacao)) {
        throw new BadRequestException(
          `Chave em situação ${existente.situacao} não pode ser recadastrada.`,
        );
      }

      const reaberta = await this.prisma.$transaction(async (tx) => {
        const c = await tx.chavePixUsuario.update({
          where: { id: existente.id },
          data: {
            ...dados,
            situacao: SITUACAO_CHAVE_PIX.PENDENTE,
            // Zera a decisão anterior: ela vale para o ciclo que terminou, e
            // fica preservada no histórico.
            motivoReprovacao: null,
            aprovadaPorUsuarioId: null,
            aprovadaEm: null,
            criadoPorUsuarioId: BigInt(req.user.id),
          },
        });
        await tx.historicoChavePix.create({
          data: {
            chavePixId: existente.id,
            situacaoAnterior: existente.situacao,
            novaSituacao: SITUACAO_CHAVE_PIX.PENDENTE,
            motivo: 'Recadastro solicitado pelo cliente',
            usuarioAtorId: BigInt(req.user.id),
            origem: ORIGEM_HISTORICO_CHAVE_PIX.CLIENTE,
          },
        });
        return c;
      });
      return { ...mapChave(reaberta), recadastro: true };
    }

    const criada = await this.prisma.chavePixUsuario.create({
      data: {
        usuarioId: usuario.id,
        chave: parsed.data.chave,
        ...dados,
        // Nasce PENDENTE: saque só é liberado após aprovação do administrador.
        situacao: SITUACAO_CHAVE_PIX.PENDENTE,
        criadoPorUsuarioId: BigInt(req.user.id),
      },
    });
    return { ...mapChave(criada), recadastro: false };
  }

  /**
   * O cliente tira a própria chave de circulação. Vai para REVOGADA — a mesma
   * fila do admin — com origem CLIENTE, para o analista ver quem cortou.
   * Não desfaz saque já pago. Recadastro da mesma chave continua permitido.
   */
  @Delete(':chaveIdPublico')
  @RequerPermissao(PERMISSOES.CHAVES_PIX_EXCLUIR)
  async remover(
    @Param('chaveIdPublico') chaveIdPublico: string,
    @Req() req: Req,
    @Body() body: unknown,
  ) {
    await assertStepUpFromBody(this.prisma, req.user.id, body);
    const chave = await this.prisma.chavePixUsuario.findFirst({
      where: {
        idPublico: chaveIdPublico,
        usuarioId: BigInt(req.user.id),
        situacao: {
          in: [
            SITUACAO_CHAVE_PIX.PENDENTE,
            SITUACAO_CHAVE_PIX.APROVADA,
            SITUACAO_CHAVE_PIX.REPROVADA,
          ] as never[],
        },
      },
    });
    if (!chave) throw new NotFoundException('Chave não encontrada');

    await this.prisma.$transaction(async (tx) => {
      await tx.chavePixUsuario.update({
        where: { id: chave.id },
        data: {
          situacao: SITUACAO_CHAVE_PIX.REVOGADA,
          motivoReprovacao: 'Removida pelo próprio cliente',
        },
      });
      await tx.historicoChavePix.create({
        data: {
          chavePixId: chave.id,
          situacaoAnterior: chave.situacao,
          novaSituacao: SITUACAO_CHAVE_PIX.REVOGADA,
          motivo: 'Removida pelo próprio cliente',
          usuarioAtorId: BigInt(req.user.id),
          origem: ORIGEM_HISTORICO_CHAVE_PIX.CLIENTE,
        },
      });
    });
    return { ok: true };
  }
}

/** Fila de aprovação de chaves PIX (gestor/administrador). */
@Controller('admin/chaves-pix')
@UseGuards(JwtAuthGuard)
export class AdminChavesPixController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
  ) {}

  @Get()
  @RequerPermissao(PERMISSOES.ADMIN_CHAVES_PIX_VER)
  async listar(
    @Query('situacao') situacao: string | undefined,
    @Query('compartilhada') compartilhada: string | undefined,
  ) {
    const validas: string[] = Object.values(SITUACAO_CHAVE_PIX);
    // Lista separada por vírgula, mesma convenção de /admin/usuarios.
    const filtro = situacao
      ? situacao.split(',').map((s) => s.trim())
      : [SITUACAO_CHAVE_PIX.PENDENTE];
    const invalida = filtro.find((s) => !validas.includes(s));
    if (invalida) {
      throw new BadRequestException(`situacao inválida: ${invalida}`);
    }
    const soCompartilhadas =
      compartilhada === '1' || compartilhada === 'true';

    const rows = await this.prisma.chavePixUsuario.findMany({
      where: { situacao: { in: filtro as never[] } },
      orderBy: { criadoEm: 'desc' },
      take: 200,
      include: {
        usuario: {
          select: {
            id: true,
            idPublico: true,
            nomeRazaoSocial: true,
            cpfCnpj: true,
            situacao: true,
          },
        },
        // Trilha de decisões: é o que responde "por que essa chave saiu antes?"
        // sem o dono ter de perguntar ao analista.
        historicos: {
          orderBy: { criadoEm: 'desc' },
          take: 10,
          include: { usuarioAtor: { select: { nomeRazaoSocial: true } } },
        },
      },
    });

    /**
     * A MESMA chave PIX em contas diferentes é legítima — um cliente pode ter
     * mais de uma empresa —, então não bloqueamos. Mas o analista precisa VER
     * isso antes de aprovar: uma chave que já está aprovada noutra conta é o
     * sinal que separa "mesmo dono, duas empresas" de tentativa de desvio.
     */
    const chaves = Array.from(new Set(rows.map((c) => c.chave)));
    const irmas = chaves.length
      ? await this.prisma.chavePixUsuario.findMany({
          where: {
            chave: { in: chaves },
            situacao: { in: [...SITUACOES_CHAVE_VIVA] as never[] },
          },
          include: {
            usuario: {
              select: { idPublico: true, nomeRazaoSocial: true, cpfCnpj: true },
            },
          },
        })
      : [];

    const lista = rows.map((c) => ({
      ...mapChave(c),
      cliente: {
        idPublico: c.usuario.idPublico,
        nome: c.usuario.nomeRazaoSocial,
        cpfCnpj: c.usuario.cpfCnpj,
        situacao: c.usuario.situacao,
      },
      // Recadastro de verdade: a chave já saiu da fila (aprovada/reprovada/
      // revogada/inativa) e o cliente mandou de novo — o histórico ganha um
      // PENDENTE. Só ter APROVADA no histórico é o ciclo normal, não reentrada.
      recadastro: c.historicos.some(
        (h) => h.novaSituacao === SITUACAO_CHAVE_PIX.PENDENTE,
      ),
      historico: c.historicos.map((h) => ({
        situacaoAnterior: h.situacaoAnterior,
        novaSituacao: h.novaSituacao,
        motivo: h.motivo,
        ator: h.usuarioAtor?.nomeRazaoSocial ?? null,
        origem: h.origem,
        criadoEm: h.criadoEm,
      })),
      // Quem tirou de circulação: a situação é a mesma (REVOGADA); a origem
      // é que separa admin de cliente. Histórico já vem do mais novo.
      revogacao: (() => {
        const h = c.historicos.find(
          (x) =>
            x.novaSituacao === SITUACAO_CHAVE_PIX.REVOGADA ||
            x.novaSituacao === SITUACAO_CHAVE_PIX.INATIVA,
        );
        if (h) {
          return {
            origem: h.origem,
            ator: h.usuarioAtor?.nomeRazaoSocial ?? null,
            motivo: h.motivo,
            em: h.criadoEm,
          };
        }
        // Remoção antiga do cliente, antes de gravar origem no histórico.
        if (c.situacao === SITUACAO_CHAVE_PIX.INATIVA) {
          return {
            origem: ORIGEM_HISTORICO_CHAVE_PIX.CLIENTE,
            ator: null,
            motivo: 'Removida pelo próprio cliente',
            em: c.atualizadoEm,
          };
        }
        return null;
      })(),
      outrasContas: irmas
        .filter((o) => o.chave === c.chave && o.usuarioId !== c.usuario.id)
        .map(mapOutraConta),
    }));
    return soCompartilhadas
      ? lista.filter((c) => c.outrasContas.length > 0)
      : lista;
  }

  /**
   * Corrige titular/documento/apelido de uma chave viva (PENDENTE ou APROVADA).
   * A chave em si não muda — isso seria outro destino. Situação também não:
   * completar um cadastro incompleto não pode virar desativação.
   */
  @Patch(':chaveIdPublico')
  @RequerPermissao(PERMISSOES.ADMIN_CHAVES_PIX_APROVAR)
  async editar(
    @Param('chaveIdPublico') chaveIdPublico: string,
    @Body() body: unknown,
    @Req() req: Req,
  ) {
    const parsed = editarChavePixAdminSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);

    const chave = await this.prisma.chavePixUsuario.findUnique({
      where: { idPublico: chaveIdPublico },
    });
    if (!chave) throw new NotFoundException('Chave não encontrada');
    if (
      chave.situacao !== SITUACAO_CHAVE_PIX.PENDENTE &&
      chave.situacao !== SITUACAO_CHAVE_PIX.APROVADA
    ) {
      throw new BadRequestException(
        `Só é possível editar chave pendente ou aprovada (situação atual: ${chave.situacao}).`,
      );
    }

    const doc = parsed.data.documentoTitular;
    if (
      (chave.tipoChave === 'CPF' || chave.tipoChave === 'CNPJ') &&
      doc !== chave.chave
    ) {
      throw new BadRequestException(
        'Quando a chave é CPF ou CNPJ, o documento do titular tem que ser o mesmo.',
      );
    }
    if (!isCpf(doc) && !isCnpj(doc)) {
      throw new BadRequestException(
        'Documento do titular deve ser um CPF (11) ou CNPJ (14) válido.',
      );
    }

    const anteriores = {
      apelido: chave.apelido,
      nomeTitular: chave.nomeTitular,
      documentoTitular: chave.documentoTitular,
    };
    const novos = {
      apelido: parsed.data.apelido,
      nomeTitular: parsed.data.nomeTitular,
      documentoTitular: doc,
    };

    const atualizada = await this.prisma.$transaction(async (tx) => {
      const c = await tx.chavePixUsuario.update({
        where: { id: chave.id },
        data: novos,
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAfetadoId: chave.usuarioId,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: 'CHAVE_PIX_EDITAR',
          nomeTabela: 'chaves_pix_usuarios',
          chaveRegistro: chave.id.toString(),
          dadosAnteriores: anteriores as never,
          dadosNovos: novos as never,
        },
      });
      return c;
    });

    return mapChave(atualizada);
  }

  @Post(':chaveIdPublico/decidir')
  @RequerPermissao(PERMISSOES.ADMIN_CHAVES_PIX_APROVAR)
  async decidir(
    @Param('chaveIdPublico') chaveIdPublico: string,
    @Body() body: unknown,
    @Req() req: Req,
  ) {
    const parsed = decidirChavePixSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);

    const chave = await this.prisma.chavePixUsuario.findUnique({
      where: { idPublico: chaveIdPublico },
      include: { usuario: { select: { email: true, nomeRazaoSocial: true } } },
    });
    if (!chave) throw new NotFoundException('Chave não encontrada');
    if (chave.situacao !== SITUACAO_CHAVE_PIX.PENDENTE) {
      throw new BadRequestException(
        `Chave já analisada (situação atual: ${chave.situacao}).`,
      );
    }
    if (parsed.data.situacao === SITUACAO_CHAVE_PIX.REPROVADA && !parsed.data.motivo) {
      throw new BadRequestException('Informe o motivo da reprovação.');
    }

    const atualizada = await this.prisma.$transaction(async (tx) => {
      const c = await tx.chavePixUsuario.update({
        where: { id: chave.id },
        data: {
          situacao: parsed.data.situacao,
          motivoReprovacao:
            parsed.data.situacao === SITUACAO_CHAVE_PIX.REPROVADA
              ? parsed.data.motivo
              : null,
          aprovadaPorUsuarioId: BigInt(req.user.id),
          aprovadaEm: new Date(),
        },
      });
      await tx.historicoChavePix.create({
        data: {
          chavePixId: chave.id,
          situacaoAnterior: chave.situacao,
          novaSituacao: parsed.data.situacao,
          motivo: parsed.data.motivo,
          usuarioAtorId: BigInt(req.user.id),
          origem: ORIGEM_HISTORICO_CHAVE_PIX.ADMIN,
        },
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAfetadoId: chave.usuarioId,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: `CHAVE_PIX_${parsed.data.situacao}`,
          nomeTabela: 'chaves_pix_usuarios',
          chaveRegistro: chave.id.toString(),
        },
      });
      return c;
    });

    // O cliente precisa saber: sem chave aprovada ele não consegue sacar.
    await this.queues.enqueueEmail({
      tipo:
        parsed.data.situacao === SITUACAO_CHAVE_PIX.APROVADA
          ? TIPOS_EMAIL.CHAVE_PIX_APROVADA
          : TIPOS_EMAIL.CHAVE_PIX_REPROVADA,
      para: chave.usuario.email,
      nome: chave.usuario.nomeRazaoSocial,
      dados: {
        chave: chave.chave,
        ...(parsed.data.motivo ? { motivo: parsed.data.motivo } : {}),
      },
    });

    return mapChave(atualizada);
  }

  /**
   * Tira de circulação uma chave que estava APROVADA — o freio de mão do admin
   * quando algo acontece com a conta ou com a chave.
   *
   * Não desfaz saque nenhum: quem já saiu, saiu. O efeito é para a frente —
   * `PixCashOutProcessor` reconfere a situação da chave ANTES de mandar dinheiro,
   * então um saque em voo criado com esta chave falha em vez de ser pago.
   *
   * Justificativa é obrigatória (`revogarChavePixSchema`) e fica no histórico.
   */
  @Post(':chaveIdPublico/revogar')
  @RequerPermissao(PERMISSOES.ADMIN_CHAVES_PIX_APROVAR)
  async revogar(
    @Param('chaveIdPublico') chaveIdPublico: string,
    @Body() body: unknown,
    @Req() req: Req,
  ) {
    const parsed = revogarChavePixSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        'Informe a justificativa da revogação (mínimo 5 caracteres) e o codigoTotp.',
      );
    }
    await assertStepUpTotp(this.prisma, req.user.id, parsed.data.codigoTotp);

    const chave = await this.prisma.chavePixUsuario.findUnique({
      where: { idPublico: chaveIdPublico },
      include: { usuario: { select: { email: true, nomeRazaoSocial: true } } },
    });
    if (!chave) throw new NotFoundException('Chave não encontrada');
    if (chave.situacao !== SITUACAO_CHAVE_PIX.APROVADA) {
      throw new BadRequestException(
        `Só é possível revogar chave APROVADA (situação atual: ${chave.situacao}).`,
      );
    }

    const atualizada = await this.prisma.$transaction(async (tx) => {
      const c = await tx.chavePixUsuario.update({
        where: { id: chave.id },
        data: {
          situacao: SITUACAO_CHAVE_PIX.REVOGADA,
          // Reaproveita a coluna de motivo: é a "última decisão" da chave, e é o
          // que a listagem mostra ao lado do badge.
          motivoReprovacao: parsed.data.motivo,
          aprovadaPorUsuarioId: BigInt(req.user.id),
          aprovadaEm: new Date(),
        },
      });
      await tx.historicoChavePix.create({
        data: {
          chavePixId: chave.id,
          situacaoAnterior: chave.situacao,
          novaSituacao: SITUACAO_CHAVE_PIX.REVOGADA,
          motivo: parsed.data.motivo,
          usuarioAtorId: BigInt(req.user.id),
          origem: ORIGEM_HISTORICO_CHAVE_PIX.ADMIN,
        },
      });
      await tx.registroAuditoria.create({
        data: {
          usuarioAfetadoId: chave.usuarioId,
          usuarioAtorId: BigInt(req.user.id),
          origem: 'PAINEL',
          operacao: 'ACAO_NEGOCIO',
          acao: `CHAVE_PIX_${SITUACAO_CHAVE_PIX.REVOGADA}`,
          nomeTabela: 'chaves_pix_usuarios',
          chaveRegistro: chave.id.toString(),
          dadosAnteriores: { situacao: chave.situacao } as never,
          dadosNovos: {
            situacao: SITUACAO_CHAVE_PIX.REVOGADA,
            motivo: parsed.data.motivo,
          } as never,
        },
      });
      return c;
    });

    // Sem aviso, o cliente só descobriria no saque recusado.
    await this.queues.enqueueEmail({
      tipo: TIPOS_EMAIL.CHAVE_PIX_REVOGADA,
      para: chave.usuario.email,
      nome: chave.usuario.nomeRazaoSocial,
      dados: { chave: chave.chave, motivo: parsed.data.motivo },
    });

    return mapChave(atualizada);
  }
}
