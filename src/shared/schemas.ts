import { z } from 'zod';
import { TEMAS } from './enums';
import { appIntegracao, EVENTOS_INTEGRACAO, TIPO_INTEGRACAO } from './integracoes';
import { normalizarIpOuCidr } from './rede';
import {
  documentoValidoPara,
  isCnpj,
  isCpf,
  normalizarDocumento,
} from './documento';
import {
  chavePixValida,
  mensagemChavePixInvalida,
  normalizarChavePixCadastro,
  TIPOS_CHAVE_PIX,
} from './chave-pix';
import { violacoesSenha } from './senha';

export const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(8),
  /** Código do app autenticador — exigido quando a conta tem 2FA ativo. */
  codigoTotp: z.string().regex(/^\d{6}$/).optional(),
  /**
   * Token do Cloudflare Turnstile. Em produção a API exige; em development/test
   * sem TURNSTILE_SECRET_KEY o desafio é ignorado (fail-open).
   */
  turnstileToken: z.string().min(1).max(2048).optional(),
});

export const enderecoSchema = z.object({
  cep: z.string().min(8).max(9),
  logradouro: z.string().min(2).max(255),
  numero: z.string().min(1).max(20),
  complemento: z.string().max(100).optional(),
  bairro: z.string().min(2).max(100),
  cidade: z.string().min(2).max(100),
  uf: z.string().length(2),
});

/**
 * Telefone BR com DDD. Aceita máscara; grava só dígitos.
 * 10 = fixo, 11 = celular; 12–13 cobrem +55.
 */
export const telefoneObrigatorioSchema = z
  .string({ required_error: 'Informe o telefone' })
  .min(1, 'Informe o telefone')
  .max(20)
  .transform((s) => s.replace(/\D/g, ''))
  .refine((d) => d.length >= 10 && d.length <= 13, {
    message: 'Telefone deve ter DDD e número (10 ou 11 dígitos).',
  });

export const cadastroUsuarioSchema = z
  .object({
    tipoPessoa: z.enum(['PF', 'PJ']),
    // Aceita máscara: normalizamos antes de validar (CPF 11 / CNPJ 14 alfanumérico).
    cpfCnpj: z.string().transform(normalizarDocumento),
    nomeRazaoSocial: z.string().min(2).max(255),
    nomeFantasia: z.string().max(255).optional(),
    email: z.string().email(),
    telefone: telefoneObrigatorioSchema,
    senha: z
      .string()
      .min(8)
      .max(128)
      .superRefine((senha, ctx) => {
        for (const msg of violacoesSenha(senha)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
        }
      }),
    // Obrigatórios do cadastro (PF e PJ): endereço completo + média de faturamento.
    endereco: enderecoSchema,
    faturamentoMensalMedio: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, 'Faturamento inválido (ex.: 15000.00)'),
    /**
     * Responsável pessoa física. Obrigatório para PJ — toda PJ tem um CPF que
     * responde por ela, e são os documentos DELE que são exigidos.
     */
    responsavel: z
      .object({
        cpf: z.string().transform(normalizarDocumento),
        nome: z.string().min(2).max(255),
      })
      .optional(),
    // Assinatura eletrônica: os dois aceites são obrigatórios para concluir o cadastro.
    aceites: z.object(
      {
        termosUso: z.literal(true, {
          errorMap: () => ({ message: 'Aceite dos Termos de Uso é obrigatório' }),
        }),
        contratoIntermediacao: z.literal(true, {
          errorMap: () => ({
            message: 'Aceite do Contrato de Intermediação é obrigatório',
          }),
        }),
        // Geolocalização opcional (app mobile, quando autorizada).
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
      },
      { required_error: 'Marque o aceite dos dois documentos para concluir o cadastro' },
    ),
  })
  .superRefine((data, ctx) => {
    if (!documentoValidoPara(data.tipoPessoa, data.cpfCnpj)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cpfCnpj'],
        message:
          data.tipoPessoa === 'PF'
            ? 'CPF inválido (11 dígitos).'
            : 'CNPJ inválido (14 caracteres; o novo padrão aceita letras nas 12 primeiras posições).',
      });
    }
    if (data.tipoPessoa === 'PJ') {
      if (!data.responsavel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['responsavel'],
          message: 'Informe o CPF e o nome do responsável pela empresa.',
        });
      } else if (!isCpf(data.responsavel.cpf)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['responsavel', 'cpf'],
          message: 'CPF do responsável inválido (11 dígitos).',
        });
      }
    }
  });

/**
 * Correção cadastral pelo admin. E-mail NÃO entra: é o identificador único da
 * conta (login, JWT, callbacks) e não se troca por esta rota — se vier no
 * body, o Zod descarta.
 */
export const editarDadosCadastraisAdminSchema = z
  .object({
    tipoPessoa: z.enum(['PF', 'PJ']),
    cpfCnpj: z.string().transform(normalizarDocumento),
    nomeRazaoSocial: z.string().trim().min(2).max(255),
    nomeFantasia: z.string().trim().max(255).optional().nullable(),
    telefone: telefoneObrigatorioSchema,
    endereco: z.object({
      cep: z
        .string()
        .transform((s) => s.replace(/\D/g, ''))
        .pipe(z.string().length(8, 'CEP deve ter 8 dígitos')),
      logradouro: z.string().trim().min(2).max(255),
      numero: z.string().trim().min(1).max(20),
      complemento: z.string().trim().max(100).optional().nullable(),
      bairro: z.string().trim().min(2).max(100),
      cidade: z.string().trim().min(2).max(100),
      uf: z
        .string()
        .trim()
        .transform((s) => s.toUpperCase())
        .pipe(z.string().length(2, 'UF deve ter 2 letras')),
    }),
    faturamentoMensalMedio: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, 'Faturamento inválido (ex.: 15000.00)')
      .nullable()
      .optional(),
    responsavel: z
      .object({
        cpf: z.string().transform(normalizarDocumento),
        nome: z.string().trim().min(2).max(255),
      })
      .optional(),
    codigoTotp: z.string().regex(/^\d{6}$/),
  })
  .superRefine((data, ctx) => {
    if (!documentoValidoPara(data.tipoPessoa, data.cpfCnpj)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cpfCnpj'],
        message:
          data.tipoPessoa === 'PF'
            ? 'CPF inválido (11 dígitos).'
            : 'CNPJ inválido (14 caracteres; o novo padrão aceita letras nas 12 primeiras posições).',
      });
    }
    if (data.tipoPessoa === 'PJ') {
      if (!data.responsavel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['responsavel'],
          message: 'Informe o CPF e o nome do responsável pela empresa.',
        });
      } else if (!isCpf(data.responsavel.cpf)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['responsavel', 'cpf'],
          message: 'CPF do responsável inválido (11 dígitos).',
        });
      }
    }
  });

/** Reverificação de credenciais no onboarding público (sem JWT). */
export const onboardingCredenciaisSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(8),
});

export const validarDocumentoSchema = z.object({
  situacao: z.enum(['VALIDO', 'INVALIDO']),
  motivo: z.string().max(500).optional(),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

export const reprovarCadastroSchema = z.object({
  motivo: z.string().min(3).max(500),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

/** Cadastro de chave PIX de saque (precisa de aprovação do administrador). */
export const criarChavePixSchema = z
  .object({
    apelido: z.string().max(100).optional(),
    chave: z.string().min(1).max(255),
    tipoChave: z.enum(TIPOS_CHAVE_PIX),
    /** Liquidante confere nome+documento no DICT — sem isso o saque quebra depois do débito. */
    nomeTitular: z.string().trim().min(2, 'Informe o nome do titular').max(255),
    documentoTitular: z.string().min(1, 'Informe o CPF ou CNPJ do titular').max(20),
    codigoTotp: z.string().regex(/^\d{6}$/),
  })
  .superRefine((v, ctx) => {
    const chave = normalizarChavePixCadastro(v.tipoChave, v.chave);
    if (!chavePixValida(v.tipoChave, chave)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chave'],
        message: mensagemChavePixInvalida(v.tipoChave),
      });
    }
    const doc = normalizarDocumento(v.documentoTitular);
    if (!isCpf(doc) && !isCnpj(doc)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentoTitular'],
        message: 'Documento do titular deve ser um CPF (11) ou CNPJ (14) válido.',
      });
      return;
    }
    if (v.tipoChave === 'CPF' || v.tipoChave === 'CNPJ') {
      if (chave !== doc) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentoTitular'],
          message:
            'Quando a chave é CPF ou CNPJ, o documento do titular tem que ser o mesmo.',
        });
      }
    }
  })
  .transform((v) => ({
    ...v,
    chave: normalizarChavePixCadastro(v.tipoChave, v.chave),
    documentoTitular: normalizarDocumento(v.documentoTitular),
  }));

export const decidirChavePixSchema = z.object({
  situacao: z.enum(['APROVADA', 'REPROVADA']),
  motivo: z.string().max(500).optional(),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

/**
 * Correção cadastral da chave pelo admin (titular/documento/apelido).
 * Não muda a chave nem o tipo — isso seria outra chave. Situação também não
 * muda: para cortar o saque, use revogar.
 */
export const editarChavePixAdminSchema = z
  .object({
    apelido: z.string().trim().max(100).optional().nullable(),
    nomeTitular: z.string().trim().min(2, 'Informe o nome do titular').max(255),
    documentoTitular: z.string().min(1, 'Informe o CPF ou CNPJ do titular').max(20),
    codigoTotp: z.string().regex(/^\d{6}$/),
  })
  .superRefine((v, ctx) => {
    const doc = normalizarDocumento(v.documentoTitular);
    if (!isCpf(doc) && !isCnpj(doc)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentoTitular'],
        message: 'Documento do titular deve ser um CPF (11) ou CNPJ (14) válido.',
      });
    }
  })
  .transform((v) => ({
    ...v,
    apelido: v.apelido?.trim() || null,
    documentoTitular: normalizarDocumento(v.documentoTitular),
  }));

/**
 * Revogação de chave já APROVADA. A justificativa é OBRIGATÓRIA e mínima de 5
 * caracteres: o dono do negócio precisa entender depois por que o acesso foi
 * cortado sem ter de perguntar ao analista que cortou.
 */
export const revogarChavePixSchema = z.object({
  motivo: z.string().trim().min(5).max(500),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

/** Saque pelo PAINEL: escolhe uma chave já cadastrada e aprovada. */
export const saquePainelSchema = z.object({
  valor: z.string().regex(/^\d+(\.\d{1,2})?$/),
  chavePixIdPublico: z.string().uuid(),
  referenciaExterna: z.string().max(255).optional(),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

/** Escopos de credencial de API (verificados no guard). */
export const ESCOPOS_API = {
  PIX_COBRANCA_CRIAR: 'pix.cobranca.criar',
  PIX_SAQUE_CRIAR: 'pix.saque.criar',
  TRANSACOES_LER: 'transacoes.ler',
} as const;

export const atualizarPerfilSchema = z.object({
  telefone: z.string().max(20).optional(),
  nomeFantasia: z.string().max(255).optional(),
  temaPreferido: z.enum([TEMAS.PADRAO, TEMAS.CLARO, TEMAS.ESCURO]).optional(),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

/**
 * Escolha da adquirente de PIX in pelo próprio lojista, no painel.
 * Sem step-up 2FA: só troca a liquidante das próximas cobranças, dentro do
 * que o admin já liberou. Mutações de admin (ativar/inativar/remanejar)
 * continuam exigindo codigoTotp.
 */
export const escolherAdquirentePixEntradaSchema = z.object({
  adquirenteCodigo: z.string().min(2).max(50),
});

/** Endereço de entrega do pagador. Mesmo formato do endereço do cadastro. */
export const enderecoPagadorSchema = enderecoSchema.extend({
  pais: z.string().length(2).default('BR'),
});

/**
 * Item (produto/serviço) da cobrança. `tangivel` distingue produto físico —
 * que exige endereço de entrega — de digital/serviço.
 */
export const itemCobrancaSchema = z.object({
  titulo: z.string().min(1).max(255),
  quantidade: z.number().int().positive(),
  valorUnitario: z.number().nonnegative().finite(),
  tangivel: z.boolean(),
});

/**
 * Parâmetros de campanha do checkout do lojista. Todos opcionais: quem não faz
 * tráfego pago simplesmente não manda o bloco.
 *
 * Nomes LITERAIS (`utm_source`, `src`, `sck`) em vez de traduzidos: é o que o
 * lojista já tem em mãos, vindo da URL do anúncio e do pixel. Um `origem`/
 * `campanha` obrigaria todo integrador a manter um de-para só para falar com a
 * gente — e é assim que os apps de rastreio (Utmify e afins) esperam receber.
 *
 * `.max(255)` porque `utm_content` de campanha grande estoura fácil e o app de
 * destino trunca ou recusa — melhor recusar aqui, com mensagem.
 */
export const rastreioSchema = z.object({
  utm_source: z.string().max(255).optional(),
  utm_campaign: z.string().max(255).optional(),
  utm_medium: z.string().max(255).optional(),
  utm_content: z.string().max(255).optional(),
  utm_term: z.string().max(255).optional(),
  src: z.string().max(255).optional(),
  sck: z.string().max(255).optional(),
});

/**
 * Documento do pagador: CPF **ou** CNPJ, decidido pelo TAMANHO depois de
 * normalizar — 11 dígitos é CPF, 14 posições é CNPJ. O lojista não escolhe o
 * tipo, e não existe campo separado para isso.
 *
 * Aceita máscara na entrada (`123.456.789-00`) e o **CNPJ alfanumérico** da
 * Receita (12 posições `0-9A-Z` + 2 dígitos verificadores numéricos), porque
 * `normalizarDocumento` só remove o que não é `[0-9A-Z]` e sobe para maiúsculo.
 * Guardamos sempre normalizado.
 */
const documentoPagadorSchema = z
  .string()
  .min(11)
  .max(20)
  .transform(normalizarDocumento)
  .refine((v) => isCpf(v) || isCnpj(v), {
    message:
      'documento do pagador deve ser um CPF (11 dígitos) ou um CNPJ (14 posições, ' +
      'incluindo o formato alfanumérico). Máscara é aceita.',
  });

/**
 * Pagador da cobrança — OBRIGATÓRIO, com nome, documento, e-mail e telefone.
 *
 * Não é preciosismo nosso: as liquidantes recusam a cobrança sem identificação
 * (ver `ValorionPaymentProvider.createCharge`). Enquanto faltava campo aqui, a
 * cobrança era ACEITA com 201 e só quebrava lá dentro — o lojista recebia 503
 * genérico, sem saber o que faltava, e a venda ia para FALHA sem código PIX.
 */
export const pagadorCobrancaSchema = z.object({
  nome: z.string().min(2).max(255),
  documento: documentoPagadorSchema,
  email: z.string().email().max(255),
  telefone: telefoneObrigatorioSchema,
  endereco: enderecoPagadorSchema.optional(),
});

/**
 * Cobrança da API pública. `itens` é OBRIGATÓRIO (≥1) — é o que o lojista está
 * vendendo, e sem isso o relatório de cash-in não tem produto para mostrar.
 *
 * O `valor` da cobrança NÃO precisa bater com a soma dos itens: frete,
 * desconto e acréscimo não viram item.
 */
export const criarCobrancaPixSchema = z
  .object({
    valor: z.string().regex(/^\d+(\.\d{1,2})?$/),
    referenciaExterna: z.string().max(255).optional(),
    /**
     * Callback desta cobrança. Recebe os mesmos eventos dos webhooks do painel.
     * Se for igual à URL de um webhook cadastrado, a entrega sai uma vez só.
     */
    urlCallback: z.string().url().max(500).optional(),
    /** Obrigatório: a liquidante recusa a cobrança sem nome, documento, e-mail e telefone. */
    pagador: pagadorCobrancaSchema,
    /**
     * Origem da venda (utm_*). Não muda nada no PIX: é repassado aos apps que o
     * lojista conectou em `/desenvolvedores/integracoes` para que a venda seja
     * atribuída à campanha que a gerou. Sem isto, a venda chega no app sem origem.
     */
    rastreio: rastreioSchema.optional(),
    itens: z
      .array(itemCobrancaSchema)
      .min(1, 'Informe ao menos um item na cobrança.')
      .max(100, 'Máximo de 100 itens por cobrança.'),
    expiracaoSegundos: z.number().int().positive().max(86400).optional(),
  })
  .superRefine((data, ctx) => {
    // Produto físico precisa de entrega: sem endereço a venda não se completa.
    if (data.itens.some((i) => i.tangivel) && !data.pagador?.endereco) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pagador', 'endereco'],
        message:
          'Endereço do pagador é obrigatório quando algum item é tangível (produto físico).',
      });
    }
  });

/**
 * Depósito pelo PAINEL: o lojista gerando um PIX para adicionar saldo à
 * própria conta. O schema não pede itens — o controller monta um item
 * sintético (`itemDepositoInterno`) porque a Valorion exige `items ≥ 1`.
 */
export const depositoPainelSchema = z.object({
  valor: z.string().regex(/^\d+(\.\d{1,2})?$/),
  referenciaExterna: z.string().max(255).optional(),
  urlCallback: z.string().url().max(500).optional(),
  expiracaoSegundos: z.number().int().positive().max(86400).optional(),
  // Sem step-up 2FA: depósito interno só gera cobrança PIX para a própria
  // conta; saque e demais mutações críticas continuam exigindo codigoTotp.
});

export const criarSaquePixSchema = z
  .object({
    valor: z.string().regex(/^\d+(\.\d{1,2})?$/),
    chavePix: z.string().min(1).max(255),
    tipoChavePix: z.enum(TIPOS_CHAVE_PIX),
    referenciaExterna: z.string().max(255).optional(),
    /** Mesma regra do cash-in: callback específico desta operação. */
    urlCallback: z.string().url().max(500).optional(),
    /**
     * Beneficiário OBRIGATÓRIO: as liquidantes exigem nome e documento do dono
     * da chave para liquidar o PIX out. Enquanto eram opcionais, o saque sem
     * eles saía daqui com string vazia e só quebrava lá na adquirente, depois
     * de já ter debitado o saldo do lojista.
     */
    nomeBeneficiario: z.string().min(2).max(255),
    documentoBeneficiario: z.string().min(11).max(20),
  })
  .superRefine((v, ctx) => {
    const chave = normalizarChavePixCadastro(v.tipoChavePix, v.chavePix);
    if (!chavePixValida(v.tipoChavePix, chave)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chavePix'],
        message: mensagemChavePixInvalida(v.tipoChavePix),
      });
    }
    const doc = normalizarDocumento(v.documentoBeneficiario);
    if (!isCpf(doc) && !isCnpj(doc)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['documentoBeneficiario'],
        message: 'documentoBeneficiario deve ser um CPF (11) ou CNPJ (14) válido',
      });
      return;
    }
    // O documento tem que ser o DONO da chave. Quando a chave é o próprio
    // documento (CPF/CNPJ), dá para conferir aqui — divergência é erro de
    // integração e viraria PIX para a pessoa errada.
    if (v.tipoChavePix === 'CPF' || v.tipoChavePix === 'CNPJ') {
      if (normalizarDocumento(v.chavePix) !== doc) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['documentoBeneficiario'],
          message:
            'documentoBeneficiario precisa ser o mesmo documento da chavePix ' +
            `quando tipoChavePix é ${v.tipoChavePix}`,
        });
      }
    }
  })
  .transform((v) => ({
    ...v,
    chavePix: normalizarChavePixCadastro(v.tipoChavePix, v.chavePix),
    documentoBeneficiario: normalizarDocumento(v.documentoBeneficiario),
  }));

/**
 * Allowlist de IP da credencial. Cada entrada é normalizada e recusada se não
 * for IP/CIDR válido — entrada inválida nunca casa com IP nenhum e derrubaria a
 * credencial sem explicar o motivo. Duplicatas somem na normalização.
 */
const ipsPermitidosSchema = z
  .array(z.string())
  .default([])
  .transform((lista, ctx) => {
    const normalizados: string[] = [];
    for (const bruto of lista) {
      if (!bruto.trim()) continue;
      const ip = normalizarIpOuCidr(bruto);
      if (!ip) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `IP ou faixa inválida: "${bruto.trim()}" (ex.: 203.0.113.10, 198.51.100.0/24, 2804:14c::/64).`,
        });
        continue;
      }
      if (!normalizados.includes(ip)) normalizados.push(ip);
    }
    return normalizados;
  });

export const criarCredencialApiSchema = z.object({
  nome: z.string().min(1).max(100),
  /**
   * Só escopo do catálogo. Com `z.string()` solto, um nome errado
   * ("transacoes.lerr") era gravado calado e o lojista via na tela um escopo
   * que nenhuma rota jamais consultaria.
   */
  escopos: z
    .array(z.enum(Object.values(ESCOPOS_API) as [string, ...string[]]))
    .default([]),
  ipsPermitidos: ipsPermitidosSchema,
  /** Exige HMAC(METHOD+PATH+TS+NONCE+SHA256(body)) em toda chamada Bearer. */
  exigirAssinaturaHmac: z.boolean().optional().default(false),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

/**
 * Edição de credencial já emitida: nome e allowlist de IP.
 *
 * O par chave/segredo NÃO é editável — trocar segredo é emitir outra chave.
 * `escopos` também fica de fora: ampliar poder de uma credencial que já está
 * circulando é criação de acesso, não ajuste de cadastro.
 */
export const editarCredencialApiSchema = z.object({
  nome: z.string().min(1).max(100),
  ipsPermitidos: ipsPermitidosSchema,
  exigirAssinaturaHmac: z.boolean().optional(),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

/**
 * Rotação do segredo. `diasJanela` é por quanto tempo o segredo ANTIGO
 * continua aceito em paralelo — o suficiente para o lojista atualizar a frota
 * sem parar de vender.
 *
 * Teto de 30 dias: janela longa demais anula o motivo de rotacionar, que é
 * justamente encurtar a vida de um segredo possivelmente vazado. `0` encerra o
 * antigo na hora, para quando a rotação é resposta a incidente.
 */
export const rotacionarCredencialApiSchema = z.object({
  diasJanela: z.number().int().min(0).max(30).default(7),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

export const configuracaoWebhookSchema = z
  .object({
    nome: z.string().min(1).max(100),
    urlDestino: z.string().url(),
    tiposEvento: z.array(z.string()).default([]),
    ativo: z.boolean().default(true),
    /**
     * Header de validação de origem: o lojista escolhe o nome (ex.:
     * `x-key-token`) e o valor, e confere os dois ao receber o callback.
     */
    nomeHeaderAutenticacao: z
      .string()
      .max(100)
      .regex(
        /^[A-Za-z0-9-]+$/,
        'Nome de header inválido (use apenas letras, números e hífen).',
      )
      .optional(),
    segredoAutenticacao: z.string().min(8).max(255).optional(),
    codigoTotp: z.string().regex(/^\d{6}$/),
  })
  .superRefine((data, ctx) => {
    // Um sem o outro não autentica nada: header sem valor não vai no request e
    // valor sem header não tem onde ir.
    if (data.nomeHeaderAutenticacao && !data.segredoAutenticacao) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segredoAutenticacao'],
        message: 'Informe o valor da credencial para o header de autenticação.',
      });
    }
    if (data.segredoAutenticacao && !data.nomeHeaderAutenticacao) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nomeHeaderAutenticacao'],
        message: 'Informe o nome do header (ex.: x-key-token).',
      });
    }
  });

/**
 * App conectado pelo lojista (`/desenvolvedores/integracoes`).
 *
 * `credencial` é o token do app (Utmify: `x-api-token`). Quem decide se ela é
 * obrigatória é o CATÁLOGO, não o schema: a Xtracky não tem credencial nenhuma,
 * e um `min(8)` fixo obrigaria o lojista a inventar lixo para conseguir salvar.
 * Na edição é sempre opcional — omitir mantém a guardada, que nunca volta pela
 * API e não teria como ser redigitada só para trocar o nome da integração.
 */
const baseIntegracaoSchema = z.object({
  nome: z.string().min(1).max(100),
  eventos: z
    .array(z.enum(Object.values(EVENTOS_INTEGRACAO) as [string, ...string[]]))
    .default([]),
  modoTeste: z.boolean().default(false),
  ativo: z.boolean().default(true),
  credencial: z.string().min(8).max(500).optional(),
  codigoTotp: z.string().regex(/^\d{6}$/),
});

export const criarIntegracaoSchema = baseIntegracaoSchema
  .extend({
    tipo: z.enum(Object.values(TIPO_INTEGRACAO) as [string, ...string[]]),
  })
  .superRefine((data, ctx) => {
    const app = appIntegracao(data.tipo);
    if (app?.credencial && !data.credencial?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credencial'],
        message: `Informe a ${app.credencial.rotulo} — ${app.nome} exige credencial.`,
      });
    }
    // App sem credencial não guarda segredo: aceitar um aqui criaria a ilusão
    // de que ele é usado em alguma chamada.
    if (app && !app.credencial && data.credencial?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credencial'],
        message: `${app.nome} não usa credencial — deixe o campo em branco.`,
      });
    }
    if (app && data.modoTeste && !app.suportaTeste) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modoTeste'],
        message: `${app.nome} não tem envio de teste: todo envio vira conversão real.`,
      });
    }
  });

/**
 * `tipo` fica de fora da edição de propósito: trocar o app de uma integração
 * manteria o histórico de envios de um app apontando para outro. Para mudar de
 * app, cadastra-se outra integração.
 */
export const editarIntegracaoSchema = baseIntegracaoSchema;

export type LoginInput = z.infer<typeof loginSchema>;
export type CadastroUsuarioInput = z.infer<typeof cadastroUsuarioSchema>;
export type EditarDadosCadastraisAdminInput = z.infer<
  typeof editarDadosCadastraisAdminSchema
>;
export type CriarCobrancaPixInput = z.infer<typeof criarCobrancaPixSchema>;
export type DepositoPainelInput = z.infer<typeof depositoPainelSchema>;
export type ItemCobrancaInput = z.infer<typeof itemCobrancaSchema>;

/** Item sintético do depósito interno — não tangível, qtd 1, valor da cobrança. */
export const TITULO_ITEM_DEPOSITO_INTERNO = 'Depósito interno';

export function itemDepositoInterno(valor: string): ItemCobrancaInput {
  return {
    titulo: TITULO_ITEM_DEPOSITO_INTERNO,
    quantidade: 1,
    valorUnitario: Number(valor),
    tangivel: false,
  };
}
export type EnderecoPagadorInput = z.infer<typeof enderecoPagadorSchema>;
export type CriarSaquePixInput = z.infer<typeof criarSaquePixSchema>;
