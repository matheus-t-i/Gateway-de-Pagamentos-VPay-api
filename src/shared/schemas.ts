import { z } from 'zod';
import { TEMAS } from './enums';
import { documentoValidoPara, isCnpj, isCpf, normalizarDocumento } from './documento';

export const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(8),
  /** Código do app autenticador — exigido quando a conta tem 2FA ativo. */
  codigoTotp: z.string().regex(/^\d{6}$/).optional(),
});

/**
 * Dados COMPLEMENTARES da primeira empresa. Documento e razão social são
 * sempre derivados da pessoa — nunca informados pelo cliente.
 */
export const dadosEmpresaSchema = z.object({
  nomeFantasia: z.string().max(255).optional(),
  email: z.string().email().optional(),
  telefone: z.string().max(20).optional(),
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

export const cadastroUsuarioSchema = z
  .object({
    tipoPessoa: z.enum(['PF', 'PJ']),
    // Aceita máscara: normalizamos antes de validar (CPF 11 / CNPJ 14 alfanumérico).
    cpfCnpj: z.string().transform(normalizarDocumento),
    nomeRazaoSocial: z.string().min(2).max(255),
    nomeFantasia: z.string().max(255).optional(),
    email: z.string().email(),
    telefone: z.string().max(20).optional(),
    senha: z.string().min(8).max(128),
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
    // Dados complementares da 1ª empresa (documento/razão social são derivados).
    empresa: dadosEmpresaSchema.optional(),
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

/** Reverificação de credenciais no onboarding público (sem JWT). */
export const onboardingCredenciaisSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(8),
});

export const validarDocumentoSchema = z.object({
  situacao: z.enum(['VALIDO', 'INVALIDO']),
  motivo: z.string().max(500).optional(),
});

export const reprovarCadastroSchema = z.object({
  motivo: z.string().min(3).max(500),
});

export const TIPOS_CHAVE_PIX = ['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA'] as const;

/** Cadastro de chave PIX de saque (precisa de aprovação do administrador). */
export const criarChavePixSchema = z.object({
  apelido: z.string().max(100).optional(),
  chave: z.string().min(1).max(255),
  tipoChave: z.enum(TIPOS_CHAVE_PIX),
  nomeTitular: z.string().max(255).optional(),
  documentoTitular: z.string().max(20).optional(),
});

export const decidirChavePixSchema = z.object({
  situacao: z.enum(['APROVADA', 'REPROVADA']),
  motivo: z.string().max(500).optional(),
});

/** Saque pelo PAINEL: escolhe uma chave já cadastrada e aprovada. */
export const saquePainelSchema = z.object({
  valor: z.string().regex(/^\d+(\.\d{1,2})?$/),
  chavePixIdPublico: z.string().uuid(),
  referenciaExterna: z.string().max(255).optional(),
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
});

/** Empresa ADICIONAL (a primeira é criada automaticamente): sempre PJ. */
export const criarEmpresaSchema = z.object({
  cnpj: z
    .string()
    .transform(normalizarDocumento)
    .refine(isCnpj, 'CNPJ inválido (14 caracteres, aceita o padrão alfanumérico).'),
  razaoSocial: z.string().min(2).max(255),
  nomeFantasia: z.string().max(255).optional(),
  email: z.string().email().optional(),
  telefone: z.string().max(20).optional(),
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

export const pagadorCobrancaSchema = z.object({
  nome: z.string().max(255).optional(),
  documento: z.string().max(20).optional(),
  email: z.string().email().optional(),
  telefone: z.string().max(20).optional(),
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
    pagador: pagadorCobrancaSchema.optional(),
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
 * própria conta. Não é uma venda, então não exige itens nem dados do pagador.
 */
export const depositoPainelSchema = z.object({
  valor: z.string().regex(/^\d+(\.\d{1,2})?$/),
  referenciaExterna: z.string().max(255).optional(),
  urlCallback: z.string().url().max(500).optional(),
  expiracaoSegundos: z.number().int().positive().max(86400).optional(),
});

export const criarSaquePixSchema = z.object({
  valor: z.string().regex(/^\d+(\.\d{1,2})?$/),
  chavePix: z.string().min(1).max(255),
  tipoChavePix: z.enum(['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA']),
  referenciaExterna: z.string().max(255).optional(),
  /** Mesma regra do cash-in: callback específico desta operação. */
  urlCallback: z.string().url().max(500).optional(),
  nomeBeneficiario: z.string().max(255).optional(),
  documentoBeneficiario: z.string().max(20).optional(),
});

export const criarCredencialApiSchema = z.object({
  nome: z.string().min(1).max(100),
  escopos: z.array(z.string()).default([]),
  ipsPermitidos: z.array(z.string()).default([]),
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

export type LoginInput = z.infer<typeof loginSchema>;
export type CadastroUsuarioInput = z.infer<typeof cadastroUsuarioSchema>;
export type CriarCobrancaPixInput = z.infer<typeof criarCobrancaPixSchema>;
export type DepositoPainelInput = z.infer<typeof depositoPainelSchema>;
export type ItemCobrancaInput = z.infer<typeof itemCobrancaSchema>;
export type EnderecoPagadorInput = z.infer<typeof enderecoPagadorSchema>;
export type CriarSaquePixInput = z.infer<typeof criarSaquePixSchema>;
