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
import { randomUUID } from 'node:crypto';
import { TipoIntegracao } from '@prisma/client';
import {
  appIntegracao,
  CATALOGO_INTEGRACOES,
  criarIntegracaoSchema,
  editarIntegracaoSchema,
  eventosPadraoDoApp,
  EventoIntegracao,
  PERMISSOES,
  SITUACAO_ENVIO_INTEGRACAO,
  STATUS_REMOTO_PEDIDO,
} from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard, type UsuarioAutenticado } from '../auth/jwt-auth.guard';
import { RequerPermissao } from '../auth/permissoes.decorator';
import { decryptText, encryptText } from '../common/crypto.util';
import { QueuesService } from '../queues/queues.service';
import { getRastreio } from '../common/request-context';
import { UtmifyClient } from './utmify/utmify.client';
import { ErroEnvioIntegracao, PedidoVenda } from './tipos';

type LinhaIntegracao = {
  id: bigint;
  idPublico: string;
  tipo: string;
  nome: string;
  eventos: unknown;
  credenciaisCriptografadas: string | null;
  modoTeste: boolean;
  ativo: boolean;
  criadoEm: Date;
};

/**
 * Apps que o LOJISTA conecta na própria conta. Escopo de dados é sempre o
 * titular do JWT — não existe id de conta na rota.
 */
@Controller('painel/integracoes')
@UseGuards(JwtAuthGuard)
export class IntegracoesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueuesService,
    private readonly utmify: UtmifyClient,
  ) {}

  /** Apps disponíveis para conectar. A tela é desenhada a partir daqui. */
  @Get('catalogo')
  @RequerPermissao(PERMISSOES.INTEGRACOES_VER)
  catalogo() {
    return CATALOGO_INTEGRACOES;
  }

  @Get()
  @RequerPermissao(PERMISSOES.INTEGRACOES_VER)
  async listar(@Req() req: { user: UsuarioAutenticado }) {
    const usuarioId = BigInt(req.user.id);
    const rows = await this.prisma.integracaoUsuario.findMany({
      where: { usuarioId },
      orderBy: { id: 'desc' },
    });

    // Último envio de cada integração: é o que diz, na listagem, se a ligação
    // está de pé. Sem isso o lojista só descobre que parou quando dá falta da
    // venda no relatório da campanha.
    const ultimos = await Promise.all(
      rows.map((i) =>
        this.prisma.envioIntegracao.findFirst({
          where: { integracaoId: i.id },
          orderBy: { id: 'desc' },
          select: { situacao: true, statusRemoto: true, enviadoEm: true, criadoEm: true },
        }),
      ),
    );

    return rows.map((i, idx) => ({
      ...this.mapIntegracao(i),
      ultimoEnvio: ultimos[idx]
        ? {
            situacao: ultimos[idx]!.situacao,
            status: ultimos[idx]!.statusRemoto,
            em: ultimos[idx]!.enviadoEm ?? ultimos[idx]!.criadoEm,
          }
        : null,
    }));
  }

  /** Resposta pública: sem ids internos e sem a credencial. */
  private mapIntegracao(i: LinhaIntegracao) {
    return {
      id: i.idPublico,
      tipo: i.tipo,
      nome: i.nome,
      eventos: (i.eventos as string[]) ?? [],
      // Só se EXISTE, nunca o valor. App sem credencial devolve `false` e a
      // tela não pede o campo.
      temCredencial: !!i.credenciaisCriptografadas,
      modoTeste: i.modoTeste,
      ativo: i.ativo,
      criadoEm: i.criadoEm,
    };
  }

  private async acharDoTitular(idPublico: string, usuarioId: bigint) {
    const integracao = await this.prisma.integracaoUsuario.findFirst({
      where: { idPublico, usuarioId },
    });
    if (!integracao) throw new NotFoundException('Integração não encontrada');
    return integracao;
  }

  @Post()
  @RequerPermissao(PERMISSOES.INTEGRACOES_CRIAR)
  async criar(@Req() req: { user: UsuarioAutenticado }, @Body() body: unknown) {
    const parsed = criarIntegracaoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const criado = await this.prisma.integracaoUsuario.create({
      data: {
        usuarioId: BigInt(req.user.id),
        tipo: parsed.data.tipo as TipoIntegracao,
        nome: parsed.data.nome,
        // App sem credencial grava NULO — não string vazia cifrada, que faria
        // o painel dizer "configurada" para o que não existe.
        credenciaisCriptografadas: parsed.data.credencial
          ? encryptText(parsed.data.credencial)
          : null,
        // Lista vazia significaria "todos os eventos", e nem todo app deve
        // nascer assinando tudo (a Xtracky pode descartar o 2º envio do mesmo
        // pedido). Sem escolha explícita, vale o padrão do catálogo.
        eventos: parsed.data.eventos.length
          ? parsed.data.eventos
          : eventosPadraoDoApp(parsed.data.tipo),
        modoTeste: parsed.data.modoTeste,
        ativo: parsed.data.ativo,
      },
    });
    return this.mapIntegracao(criado);
  }

  @Put(':id')
  @RequerPermissao(PERMISSOES.INTEGRACOES_EDITAR)
  async editar(
    @Param('id') id: string,
    @Req() req: { user: UsuarioAutenticado },
    @Body() body: unknown,
  ) {
    const parsed = editarIntegracaoSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const atual = await this.acharDoTitular(id, BigInt(req.user.id));

    // As mesmas regras da criação, agora com o app vindo da linha (a edição não
    // recebe `tipo`, e trocar de app não é permitido).
    const app = appIntegracao(atual.tipo);
    if (app && !app.credencial && parsed.data.credencial?.trim()) {
      throw new BadRequestException(
        `${app.nome} não usa credencial — deixe o campo em branco.`,
      );
    }
    if (app && parsed.data.modoTeste && !app.suportaTeste) {
      throw new BadRequestException(
        `${app.nome} não tem envio de teste: todo envio vira conversão real.`,
      );
    }

    const atualizado = await this.prisma.integracaoUsuario.update({
      where: { id: atual.id },
      data: {
        nome: parsed.data.nome,
        eventos: parsed.data.eventos,
        modoTeste: parsed.data.modoTeste,
        ativo: parsed.data.ativo,
        // Credencial em branco = manter a atual: ela nunca volta pela API, e
        // exigir redigitar o token só para renomear a integração levaria o
        // lojista a colar um valor errado.
        ...(parsed.data.credencial
          ? { credenciaisCriptografadas: encryptText(parsed.data.credencial) }
          : {}),
      },
    });
    return this.mapIntegracao(atualizado);
  }

  @Delete(':id')
  @RequerPermissao(PERMISSOES.INTEGRACOES_EXCLUIR)
  async remover(@Param('id') id: string, @Req() req: { user: UsuarioAutenticado }) {
    const atual = await this.acharDoTitular(id, BigInt(req.user.id));
    // Soft delete: `envios_integracao` referencia esta linha e é o histórico de
    // o que já foi para o app. Apagar violaria a FK e sumiria com o rastro.
    await this.prisma.integracaoUsuario.update({
      where: { id: atual.id },
      data: { ativo: false },
    });
    return { ok: true };
  }

  /**
   * Envia um pedido FICTÍCIO marcado como teste. O app valida credencial e
   * payload e não grava nada — é a forma de o lojista conferir a ligação sem
   * esperar uma venda de verdade nem sujar o relatório dele.
   *
   * Só existe para app com `suportaTeste`. Num app sem esse recurso (Xtracky),
   * o botão criaria uma conversão REAL na conta do lojista e queimaria o par
   * `orderId + LeadId` do dedupe deles, que não volta atrás.
   */
  @Post(':id/testar')
  @RequerPermissao(PERMISSOES.INTEGRACOES_EDITAR)
  async testar(@Param('id') id: string, @Req() req: { user: UsuarioAutenticado }) {
    const integracao = await this.acharDoTitular(id, BigInt(req.user.id));
    const app = appIntegracao(integracao.tipo);
    if (!app?.suportaTeste) {
      throw new BadRequestException(
        `${app?.nome ?? integracao.tipo} não tem envio de teste: qualquer chamada ` +
          'geraria uma conversão real na sua conta.',
      );
    }
    if (!integracao.credenciaisCriptografadas) {
      throw new BadRequestException('Integração sem credencial cadastrada.');
    }

    let token: string;
    try {
      token = decryptText(integracao.credenciaisCriptografadas);
    } catch {
      throw new BadRequestException(
        'Não foi possível ler a credencial guardada — cadastre o token novamente.',
      );
    }

    try {
      const r = await this.utmify.enviar({
        token,
        pedido: IntegracoesController.pedidoDeTeste(),
        status: STATUS_REMOTO_PEDIDO.WAITING_PAYMENT,
        // Sempre teste, independente do `modoTeste` da integração: este botão
        // jamais pode criar um pedido de mentira no relatório do lojista.
        teste: true,
      });
      return { ok: true, statusHttp: r.statusHttp, resposta: r.corpoResposta };
    } catch (e) {
      const msg = e instanceof ErroEnvioIntegracao ? e.message : String(e);
      throw new BadRequestException(msg);
    }
  }

  /** Venda de mentira, com o mesmo formato de uma real. */
  private static pedidoDeTeste(): PedidoVenda {
    const agora = new Date();
    return {
      idPedido: randomUUID(),
      referenciaExterna: 'teste-integracao',
      criadoEm: agora,
      pagoEm: null,
      devolvidoEm: null,
      cliente: {
        nome: 'Teste de integração',
        email: 'teste@vpay.com.br',
        telefone: null,
        documento: null,
      },
      itens: [
        {
          id: '0',
          titulo: 'Teste de integração',
          quantidade: 1,
          valorUnitarioCentavos: 100,
        },
      ],
      valorBrutoCentavos: 100,
      tarifaCentavos: 10,
      liquidoLojistaCentavos: 90,
      rastreio: { utm_source: 'vpay', utm_campaign: 'teste-de-integracao' },
    };
  }

  /** Histórico de envios desta integração. */
  @Get(':id/envios')
  @RequerPermissao(PERMISSOES.INTEGRACOES_VER)
  async envios(
    @Param('id') id: string,
    @Req() req: { user: UsuarioAutenticado },
    @Query() q: { page?: string; limit?: string; situacao?: string },
  ) {
    const integracao = await this.acharDoTitular(id, BigInt(req.user.id));
    const pagina = Math.max(1, Number(q.page) || 1);
    const limite = Math.min(100, Math.max(5, Number(q.limit) || 10));
    const where = {
      integracaoId: integracao.id,
      ...(q.situacao ? { situacao: { in: q.situacao.split(',') } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.envioIntegracao.count({ where }),
      this.prisma.envioIntegracao.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (pagina - 1) * limite,
        take: limite,
        include: {
          transacao: { select: { idTransacaoPublico: true, referenciaExterna: true } },
        },
      }),
    ]);

    return {
      pagina,
      limite,
      total,
      itens: rows.map((e) => ({
        id: e.id.toString(),
        idTransacao: e.transacao.idTransacaoPublico,
        referenciaExterna: e.transacao.referenciaExterna,
        status: e.statusRemoto,
        situacao: e.situacao,
        numeroTentativa: e.numeroTentativa,
        statusHttp: e.statusHttp,
        mensagemErro: e.mensagemErro,
        latenciaMs: e.latenciaMs,
        em: e.enviadoEm ?? e.criadoEm,
      })),
    };
  }

  /**
   * Reenvia um envio que falhou. Não recria nada: repete o POST para o app com
   * o estado ATUAL da venda, na mesma linha de histórico (soma tentativa).
   */
  @Post(':id/envios/:envioId/reenviar')
  @RequerPermissao(PERMISSOES.INTEGRACOES_EDITAR)
  async reenviar(
    @Param('id') id: string,
    @Param('envioId') envioId: string,
    @Req() req: { user: UsuarioAutenticado },
  ) {
    const integracao = await this.acharDoTitular(id, BigInt(req.user.id));
    const envio = await this.prisma.envioIntegracao.findFirst({
      where: { id: BigInt(envioId), integracaoId: integracao.id },
      select: { id: true, situacao: true },
    });
    if (!envio) throw new NotFoundException('Envio não encontrado');
    if (envio.situacao === SITUACAO_ENVIO_INTEGRACAO.SUCESSO) {
      throw new BadRequestException('Este envio já foi entregue com sucesso.');
    }

    await this.prisma.envioIntegracao.update({
      where: { id: envio.id },
      data: { situacao: SITUACAO_ENVIO_INTEGRACAO.PENDENTE },
    });
    await this.queues.enqueueIntegracaoEnvio({
      envioId: envio.id.toString(),
      identificadorRastreio: getRastreio(),
    });
    return { ok: true };
  }

  /** Eventos que o lojista pode assinar, para os chips do formulário. */
  @Get('eventos')
  @RequerPermissao(PERMISSOES.INTEGRACOES_VER)
  eventos(): EventoIntegracao[] {
    return CATALOGO_INTEGRACOES.flatMap((a) => a.eventos).filter(
      (ev, i, todos) => todos.indexOf(ev) === i,
    );
  }
}
