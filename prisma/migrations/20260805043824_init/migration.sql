-- CreateEnum
CREATE TYPE "TipoPessoa" AS ENUM ('PF', 'PJ');

-- CreateEnum
CREATE TYPE "TemaPreferido" AS ENUM ('PADRAO', 'CLARO', 'ESCURO');

-- CreateEnum
CREATE TYPE "SituacaoUsuario" AS ENUM ('PENDENTE', 'EM_ANALISE', 'ATIVO', 'REPROVADO', 'SUSPENSO', 'BLOQUEADO', 'ENCERRADO');

-- CreateEnum
CREATE TYPE "SituacaoDocumento" AS ENUM ('PENDENTE', 'VALIDO', 'INVALIDO', 'EXPIRADO');

-- CreateEnum
CREATE TYPE "SituacaoAnalise" AS ENUM ('PENDENTE', 'EM_ANALISE', 'APROVADA', 'REPROVADA');

-- CreateEnum
CREATE TYPE "SituacaoProvedor" AS ENUM ('ATIVO', 'INATIVO', 'SUSPENSO');

-- CreateEnum
CREATE TYPE "DisponibilidadeAdquirente" AS ENUM ('TODOS', 'ESPECIFICOS');

-- CreateEnum
CREATE TYPE "DirecaoTransacao" AS ENUM ('ENTRADA', 'SAIDA');

-- CreateEnum
CREATE TYPE "SituacaoTransacao" AS ENUM ('PENDENTE', 'PROCESSANDO', 'AGUARDANDO_PAGAMENTO', 'LIQUIDADA', 'CONCLUIDA', 'FALHA', 'CANCELADA', 'DEVOLVIDA');

-- CreateEnum
CREATE TYPE "TipoSaldo" AS ENUM ('DISPONIVEL', 'PENDENTE_LIBERACAO', 'RESERVADO', 'BLOQUEADO_MED');

-- CreateEnum
CREATE TYPE "TipoMovimento" AS ENUM ('CREDITO', 'DEBITO');

-- CreateEnum
CREATE TYPE "NaturezaMovimentacao" AS ENUM ('RECEBIMENTO', 'TARIFA', 'RESERVA', 'LIBERACAO', 'SAIDA', 'DEVOLUCAO_PIX', 'BLOQUEIO_MED', 'DESBLOQUEIO_MED', 'DEBITO_MED', 'AJUSTE');

-- CreateEnum
CREATE TYPE "ModoTratamentoMed" AS ENUM ('BLOQUEAR_SALDO', 'DEBITAR_IMEDIATAMENTE', 'ANALISE_MANUAL');

-- CreateEnum
CREATE TYPE "BaseCalculoReserva" AS ENUM ('VALOR_BRUTO', 'VALOR_LIQUIDO_EMPRESA');

-- CreateEnum
CREATE TYPE "TipoLiberacao" AS ENUM ('SALDO_PRINCIPAL', 'RESERVA');

-- CreateEnum
CREATE TYPE "SituacaoLiberacao" AS ENUM ('AGENDADA', 'PROCESSANDO', 'LIBERADA', 'CANCELADA', 'BLOQUEADA_MED', 'FALHA');

-- CreateEnum
CREATE TYPE "SituacaoChavePix" AS ENUM ('PENDENTE', 'APROVADA', 'REPROVADA', 'INATIVA');

-- CreateEnum
CREATE TYPE "TipoChavePix" AS ENUM ('CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "tipo_pessoa" "TipoPessoa" NOT NULL,
    "cpf_cnpj" VARCHAR(14) NOT NULL,
    "nome_razao_social" VARCHAR(255) NOT NULL,
    "nome_fantasia" VARCHAR(255),
    "cpf_responsavel" VARCHAR(14),
    "nome_responsavel" VARCHAR(255),
    "email" VARCHAR(255) NOT NULL,
    "telefone" VARCHAR(20),
    "senha_hash" VARCHAR(255) NOT NULL,
    "situacao" "SituacaoUsuario" NOT NULL DEFAULT 'PENDENTE',
    "conta_bloqueada" BOOLEAN NOT NULL DEFAULT false,
    "forcar_troca_senha" BOOLEAN NOT NULL DEFAULT false,
    "tema_preferido" "TemaPreferido" NOT NULL DEFAULT 'PADRAO',
    "segredo_totp_criptografado" TEXT,
    "totp_habilitado" BOOLEAN NOT NULL DEFAULT false,
    "totp_ativado_em" TIMESTAMPTZ,
    "ultimo_acesso_em" TIMESTAMPTZ,
    "ativado_por_usuario_id" BIGINT,
    "ativado_em" TIMESTAMPTZ,
    "motivo_reprovacao" TEXT,
    "endereco" JSONB,
    "faturamento_mensal_medio" DECIMAL(15,2),
    "metadados" JSONB NOT NULL DEFAULT '{}',
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aceites_documentos_legais" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "documento" VARCHAR(80) NOT NULL,
    "versao" VARCHAR(20) NOT NULL,
    "endereco_ip" VARCHAR(45),
    "agente_usuario" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "aceito_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aceites_documentos_legais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chaves_pix_usuarios" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "apelido" VARCHAR(100),
    "chave" VARCHAR(255) NOT NULL,
    "tipo_chave" "TipoChavePix" NOT NULL,
    "nome_titular" VARCHAR(255),
    "documento_titular" VARCHAR(14),
    "situacao" "SituacaoChavePix" NOT NULL DEFAULT 'PENDENTE',
    "motivo_reprovacao" TEXT,
    "aprovada_por_usuario_id" BIGINT,
    "aprovada_em" TIMESTAMPTZ,
    "criado_por_usuario_id" BIGINT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chaves_pix_usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documentos_usuarios" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "tipo_documento" VARCHAR(60) NOT NULL,
    "nome_arquivo" VARCHAR(255) NOT NULL,
    "caminho_arquivo" VARCHAR(500) NOT NULL,
    "tipo_mime" VARCHAR(100),
    "tamanho_bytes" BIGINT,
    "hash_arquivo" VARCHAR(128),
    "situacao" "SituacaoDocumento" NOT NULL DEFAULT 'PENDENTE',
    "motivo_invalidacao" TEXT,
    "enviado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validado_por_usuario_id" BIGINT,
    "validado_em" TIMESTAMPTZ,

    CONSTRAINT "documentos_usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analises_cadastro_usuarios" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "situacao" "SituacaoAnalise" NOT NULL DEFAULT 'PENDENTE',
    "observacoes" TEXT,
    "analisado_por_usuario_id" BIGINT,
    "analisado_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "analises_cadastro_usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historicos_situacoes_usuarios" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "situacao_anterior" VARCHAR(30),
    "nova_situacao" VARCHAR(30) NOT NULL,
    "motivo" TEXT,
    "usuario_ator_id" BIGINT,
    "endereco_ip" VARCHAR(45),
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historicos_situacoes_usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "papeis" (
    "id" BIGSERIAL NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "descricao" VARCHAR(255),
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "papeis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissoes" (
    "id" BIGSERIAL NOT NULL,
    "codigo" VARCHAR(100) NOT NULL,
    "descricao" VARCHAR(255) NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuarios_papeis" (
    "usuario_id" BIGINT NOT NULL,
    "papel_id" BIGINT NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_papeis_pkey" PRIMARY KEY ("usuario_id","papel_id")
);

-- CreateTable
CREATE TABLE "papeis_permissoes" (
    "papel_id" BIGINT NOT NULL,
    "permissao_id" BIGINT NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "papeis_permissoes_pkey" PRIMARY KEY ("papel_id","permissao_id")
);

-- CreateTable
CREATE TABLE "tokens_redefinicao_senha" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expira_em" TIMESTAMPTZ NOT NULL,
    "usado_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tokens_redefinicao_senha_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auditorias_acesso" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT,
    "email_informado" VARCHAR(255),
    "endereco_ip" VARCHAR(45),
    "agente_usuario" TEXT,
    "sucesso" BOOLEAN NOT NULL,
    "motivo" TEXT,
    "ocorrido_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditorias_acesso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credenciais_api" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "criado_por_usuario_id" BIGINT,
    "nome" VARCHAR(100) NOT NULL,
    "chave_publica" VARCHAR(150) NOT NULL,
    "segredo_hash" VARCHAR(255) NOT NULL,
    "escopos" JSONB NOT NULL DEFAULT '[]',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "expira_em" TIMESTAMPTZ,
    "revogado_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "credenciais_api_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ips_permitidos_api" (
    "id" BIGSERIAL NOT NULL,
    "credencial_api_id" BIGINT NOT NULL,
    "ip_ou_cidr" VARCHAR(50) NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ips_permitidos_api_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registros_acesso_api" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT,
    "credencial_api_id" BIGINT,
    "endereco_ip" VARCHAR(45),
    "metodo" VARCHAR(10) NOT NULL,
    "caminho" VARCHAR(500) NOT NULL,
    "status_http" INTEGER NOT NULL,
    "latencia_ms" INTEGER,
    "identificador_rastreio" VARCHAR(100),
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registros_acesso_api_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provedores_pagamento" (
    "id" BIGSERIAL NOT NULL,
    "codigo" VARCHAR(50) NOT NULL,
    "nome" VARCHAR(255) NOT NULL,
    "nome_fantasia" VARCHAR(120),
    "tem_med" BOOLEAN NOT NULL DEFAULT false,
    "observacao_cliente" TEXT,
    "disponibilidade_pix_entrada" "DisponibilidadeAdquirente" NOT NULL DEFAULT 'ESPECIFICOS',
    "situacao" "SituacaoProvedor" NOT NULL DEFAULT 'ATIVO',
    "permite_pix_entrada" BOOLEAN NOT NULL DEFAULT false,
    "permite_pix_saida" BOOLEAN NOT NULL DEFAULT false,
    "exige_assinatura_webhook" BOOLEAN NOT NULL DEFAULT false,
    "segredo_webhook_hash" TEXT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "provedores_pagamento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liberacoes_adquirente_usuario" (
    "id" BIGSERIAL NOT NULL,
    "provedor_pagamento_id" BIGINT NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "liberado_por_usuario_id" BIGINT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liberacoes_adquirente_usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ips_permitidos_webhook_provedor" (
    "id" BIGSERIAL NOT NULL,
    "provedor_pagamento_id" BIGINT NOT NULL,
    "ip_ou_cidr" VARCHAR(50) NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ips_permitidos_webhook_provedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contas_provedor" (
    "id" BIGSERIAL NOT NULL,
    "provedor_pagamento_id" BIGINT NOT NULL,
    "usuario_id" BIGINT,
    "nome" VARCHAR(100) NOT NULL,
    "identificador_conta_externa" VARCHAR(255),
    "chave_unica_conta" VARCHAR(500) NOT NULL,
    "credenciais_criptografadas" TEXT NOT NULL,
    "pix_entrada_habilitado" BOOLEAN NOT NULL DEFAULT false,
    "pix_saida_habilitado" BOOLEAN NOT NULL DEFAULT false,
    "ticket_minimo_pix_entrada" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "ticket_maximo_pix_entrada" DECIMAL(19,2),
    "ticket_minimo_pix_saida" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "ticket_maximo_pix_saida" DECIMAL(19,2),
    "situacao" "SituacaoProvedor" NOT NULL DEFAULT 'ATIVO',
    "metadados" JSONB NOT NULL DEFAULT '{}',
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contas_provedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custos_pix_contas_provedor" (
    "conta_provedor_id" BIGINT NOT NULL,
    "custo_pix_entrada_percentual" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "custo_pix_entrada_fixo" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "custo_pix_saida_percentual" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "custo_pix_saida_fixo" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "atualizado_por_usuario_id" BIGINT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "custos_pix_contas_provedor_pkey" PRIMARY KEY ("conta_provedor_id")
);

-- CreateTable
CREATE TABLE "configuracoes_padrao_pix_usuarios" (
    "id" BIGSERIAL NOT NULL,
    "nome" VARCHAR(120) NOT NULL,
    "descricao" TEXT,
    "tipo_pessoa" "TipoPessoa",
    "padrao_sistema" BOOLEAN NOT NULL DEFAULT false,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "conta_provedor_pix_entrada_id" BIGINT NOT NULL,
    "conta_provedor_pix_saida_id" BIGINT NOT NULL,
    "taxa_pix_entrada_percentual" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "taxa_pix_entrada_fixa" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxa_pix_saida_percentual" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "taxa_pix_saida_fixa" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "ticket_minimo_pix_entrada" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "ticket_maximo_pix_entrada" DECIMAL(19,2) NOT NULL,
    "ticket_minimo_pix_saida" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "ticket_maximo_pix_saida" DECIMAL(19,2),
    "permitir_pix_saida_via_api" BOOLEAN NOT NULL DEFAULT false,
    "dias_liberacao_saldo" INTEGER NOT NULL DEFAULT 0,
    "percentual_reserva" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "base_calculo_reserva" "BaseCalculoReserva" NOT NULL DEFAULT 'VALOR_LIQUIDO_EMPRESA',
    "dias_retencao_reserva" INTEGER NOT NULL DEFAULT 0,
    "modo_tratamento_med" "ModoTratamentoMed" NOT NULL DEFAULT 'BLOQUEAR_SALDO',
    "permite_saldo_negativo" BOOLEAN NOT NULL DEFAULT false,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "configuracoes_padrao_pix_usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuracoes_pix_usuarios" (
    "usuario_id" BIGINT NOT NULL,
    "configuracao_padrao_origem_id" BIGINT,
    "conta_provedor_pix_entrada_id" BIGINT NOT NULL,
    "conta_provedor_pix_saida_id" BIGINT NOT NULL,
    "adquirente_pix_entrada_trocada_em" TIMESTAMPTZ,
    "taxa_pix_entrada_percentual" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "taxa_pix_entrada_fixa" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "taxa_pix_saida_percentual" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "taxa_pix_saida_fixa" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "ticket_minimo_pix_entrada" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "ticket_maximo_pix_entrada" DECIMAL(19,2) NOT NULL,
    "ticket_minimo_pix_saida" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "ticket_maximo_pix_saida" DECIMAL(19,2),
    "permitir_pix_saida_via_api" BOOLEAN NOT NULL DEFAULT false,
    "dias_liberacao_saldo" INTEGER NOT NULL DEFAULT 0,
    "percentual_reserva" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "base_calculo_reserva" "BaseCalculoReserva" NOT NULL DEFAULT 'VALOR_LIQUIDO_EMPRESA',
    "dias_retencao_reserva" INTEGER NOT NULL DEFAULT 0,
    "modo_tratamento_med" "ModoTratamentoMed" NOT NULL DEFAULT 'BLOQUEAR_SALDO',
    "permite_saldo_negativo" BOOLEAN NOT NULL DEFAULT false,
    "atualizado_por_usuario_id" BIGINT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "configuracoes_pix_usuarios_pkey" PRIMARY KEY ("usuario_id")
);

-- CreateTable
CREATE TABLE "transacoes" (
    "id" BIGSERIAL NOT NULL,
    "id_transacao_publico" UUID NOT NULL,
    "id_transacao_privado" UUID NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "credencial_api_id" BIGINT,
    "conta_provedor_id" BIGINT,
    "transacao_origem_id" BIGINT,
    "referencia_externa" VARCHAR(255),
    "url_callback" TEXT,
    "direcao" "DirecaoTransacao" NOT NULL,
    "moeda" VARCHAR(3) NOT NULL DEFAULT 'BRL',
    "valor_bruto" DECIMAL(19,2) NOT NULL,
    "tarifa_pix_percentual_aplicada" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "tarifa_pix_fixa_aplicada" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "valor_tarifa_pix" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "custo_pix_provedor_percentual_aplicado" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "custo_pix_provedor_fixo_aplicado" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "valor_custo_pix_provedor" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "valor_liquidacao_empresa" DECIMAL(19,2) NOT NULL,
    "valor_reserva" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "valor_disponivel_previsto" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "valor_margem_bruta" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "modo_cobranca_tarifa_aplicado" VARCHAR(40) NOT NULL DEFAULT 'AUTOMATICO_POR_DIRECAO',
    "dias_liberacao_saldo_aplicado" INTEGER NOT NULL DEFAULT 0,
    "percentual_reserva_aplicado" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "base_calculo_reserva_aplicada" "BaseCalculoReserva" NOT NULL DEFAULT 'VALOR_LIQUIDO_EMPRESA',
    "dias_retencao_reserva_aplicado" INTEGER NOT NULL DEFAULT 0,
    "liberar_saldo_em" TIMESTAMPTZ,
    "liberar_reserva_em" TIMESTAMPTZ,
    "situacao" "SituacaoTransacao" NOT NULL DEFAULT 'PENDENTE',
    "metadados" JSONB NOT NULL DEFAULT '{}',
    "liquidado_em" TIMESTAMPTZ,
    "concluido_em" TIMESTAMPTZ,
    "primeiro_med_recebido_em" TIMESTAMPTZ,
    "falhou_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "transacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transacoes_pix" (
    "transacao_id" BIGINT NOT NULL,
    "txid" VARCHAR(35),
    "identificador_fim_a_fim" VARCHAR(255),
    "nome_pagador" VARCHAR(255),
    "documento_pagador" VARCHAR(20),
    "email_pagador" VARCHAR(255),
    "telefone_pagador" VARCHAR(20),
    "nome_beneficiario" VARCHAR(255),
    "documento_beneficiario" VARCHAR(20),
    "endereco_pagador" JSONB,
    "chave_pix" VARCHAR(255),
    "tipo_chave_pix" VARCHAR(20),
    "pix_copia_cola" TEXT,
    "url_checkout" TEXT,
    "expira_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "transacoes_pix_pkey" PRIMARY KEY ("transacao_id")
);

-- CreateTable
CREATE TABLE "itens_cobranca" (
    "id" BIGSERIAL NOT NULL,
    "transacao_id" BIGINT NOT NULL,
    "titulo" VARCHAR(255) NOT NULL,
    "quantidade" INTEGER NOT NULL,
    "valor_unitario" DECIMAL(19,2) NOT NULL,
    "valor_total" DECIMAL(19,2) NOT NULL,
    "tangivel" BOOLEAN NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "itens_cobranca_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tentativas_transacoes" (
    "id" BIGSERIAL NOT NULL,
    "transacao_id" BIGINT NOT NULL,
    "conta_provedor_id" BIGINT NOT NULL,
    "numero_tentativa" INTEGER NOT NULL,
    "situacao" VARCHAR(30) NOT NULL,
    "id_transacao_liquidante" VARCHAR(255),
    "status_http" INTEGER,
    "codigo_erro" VARCHAR(100),
    "mensagem_erro" TEXT,
    "dados_requisicao" JSONB,
    "dados_resposta" JSONB,
    "latencia_ms" INTEGER,
    "iniciado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluido_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tentativas_transacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historicos_situacoes_transacoes" (
    "id" BIGSERIAL NOT NULL,
    "transacao_id" BIGINT NOT NULL,
    "situacao_anterior" VARCHAR(40),
    "nova_situacao" VARCHAR(40) NOT NULL,
    "origem" VARCHAR(30) NOT NULL,
    "motivo" TEXT,
    "metadados" JSONB NOT NULL DEFAULT '{}',
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historicos_situacoes_transacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chaves_idempotencia" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "credencial_api_id" BIGINT,
    "chave_idempotencia" VARCHAR(255) NOT NULL,
    "hash_requisicao" VARCHAR(255) NOT NULL,
    "transacao_id" BIGINT,
    "status_resposta" INTEGER,
    "corpo_resposta" JSONB,
    "expira_em" TIMESTAMPTZ NOT NULL,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chaves_idempotencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devolucoes_pix" (
    "id" BIGSERIAL NOT NULL,
    "id_devolucao_publico" UUID NOT NULL,
    "transacao_id" BIGINT NOT NULL,
    "caso_med_id" BIGINT,
    "solicitado_por_usuario_id" BIGINT,
    "referencia_externa" VARCHAR(255),
    "identificador_devolucao_provedor" VARCHAR(255),
    "valor" DECIMAL(19,2) NOT NULL,
    "motivo" TEXT,
    "situacao" VARCHAR(30) NOT NULL DEFAULT 'PENDENTE',
    "metadados" JSONB NOT NULL DEFAULT '{}',
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "devolucoes_pix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saldos_usuarios" (
    "usuario_id" BIGINT NOT NULL,
    "saldo_disponivel" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "saldo_pendente_liberacao" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "saldo_reservado" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "saldo_bloqueado_med" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "saldos_usuarios_pkey" PRIMARY KEY ("usuario_id")
);

-- CreateTable
CREATE TABLE "movimentacoes_saldo" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "transacao_id" BIGINT,
    "devolucao_pix_id" BIGINT,
    "caso_med_id" BIGINT,
    "movimentacao_relacionada_id" BIGINT,
    "chave_idempotencia" VARCHAR(255) NOT NULL,
    "tipo_saldo" "TipoSaldo" NOT NULL,
    "tipo_movimento" "TipoMovimento" NOT NULL,
    "natureza" "NaturezaMovimentacao" NOT NULL,
    "valor" DECIMAL(19,2) NOT NULL,
    "saldo_apos" DECIMAL(19,2) NOT NULL,
    "descricao" VARCHAR(500),
    "metadados" JSONB NOT NULL DEFAULT '{}',
    "ocorrido_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movimentacoes_saldo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liberacoes_saldo" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "transacao_id" BIGINT NOT NULL,
    "tipo_liberacao" "TipoLiberacao" NOT NULL,
    "valor" DECIMAL(19,2) NOT NULL,
    "liberar_em" TIMESTAMPTZ NOT NULL,
    "situacao" "SituacaoLiberacao" NOT NULL DEFAULT 'AGENDADA',
    "movimentacao_liberacao_id" BIGINT,
    "quantidade_tentativas" INTEGER NOT NULL DEFAULT 0,
    "ultimo_erro" TEXT,
    "processado_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "liberacoes_saldo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bloqueios_saldo" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "caso_med_id" BIGINT,
    "tipo" VARCHAR(30) NOT NULL,
    "valor_solicitado" DECIMAL(19,2) NOT NULL,
    "valor_bloqueado" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "valor_nao_coberto" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "motivo" TEXT,
    "situacao" VARCHAR(30) NOT NULL DEFAULT 'ATIVO',
    "criado_por_usuario_id" BIGINT,
    "bloqueado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "encerrado_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bloqueios_saldo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casos_med" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "transacao_id" BIGINT NOT NULL,
    "conta_provedor_id" BIGINT,
    "webhook_recebido_id" BIGINT,
    "identificador_med_provedor" VARCHAR(255),
    "chave_idempotencia" VARCHAR(255) NOT NULL,
    "valor_solicitado" DECIMAL(19,2) NOT NULL,
    "modo_tratamento_aplicado" "ModoTratamentoMed" NOT NULL,
    "valor_bloqueado" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "valor_debitado" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "valor_nao_coberto" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "situacao" VARCHAR(40) NOT NULL DEFAULT 'RECEBIDO',
    "motivo" TEXT,
    "prazo_resposta_em" TIMESTAMPTZ,
    "recebido_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidido_em" TIMESTAMPTZ,
    "decidido_por_usuario_id" BIGINT,
    "encerrado_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "casos_med_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historicos_casos_med" (
    "id" BIGSERIAL NOT NULL,
    "caso_med_id" BIGINT NOT NULL,
    "situacao_anterior" VARCHAR(40),
    "nova_situacao" VARCHAR(40) NOT NULL,
    "acao" VARCHAR(100) NOT NULL,
    "usuario_ator_id" BIGINT,
    "origem" VARCHAR(30) NOT NULL,
    "endereco_ip" VARCHAR(45),
    "motivo" TEXT,
    "dados" JSONB NOT NULL DEFAULT '{}',
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historicos_casos_med_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuracoes_webhook_usuario" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT NOT NULL,
    "nome" VARCHAR(100) NOT NULL,
    "url_destino" TEXT NOT NULL,
    "nome_header_autenticacao" VARCHAR(100),
    "segredo_criptografado" TEXT,
    "tipos_evento" JSONB NOT NULL DEFAULT '[]',
    "cabecalhos_criptografados" JSONB NOT NULL DEFAULT '{}',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "configuracoes_webhook_usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks_recebidos_provedor" (
    "id" BIGSERIAL NOT NULL,
    "provedor_pagamento_id" BIGINT NOT NULL,
    "conta_provedor_id" BIGINT,
    "usuario_id" BIGINT,
    "identificador_evento_externo" VARCHAR(255),
    "chave_idempotencia" VARCHAR(255) NOT NULL,
    "tipo_evento" VARCHAR(100) NOT NULL,
    "assinatura" VARCHAR(500),
    "conteudo" JSONB NOT NULL,
    "situacao" VARCHAR(30) NOT NULL DEFAULT 'RECEBIDO',
    "mensagem_erro" TEXT,
    "recebido_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processado_em" TIMESTAMPTZ,

    CONSTRAINT "webhooks_recebidos_provedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eventos_outbox" (
    "id" BIGSERIAL NOT NULL,
    "evento_uuid" UUID NOT NULL,
    "usuario_id" BIGINT,
    "tipo_agregado" VARCHAR(100) NOT NULL,
    "identificador_agregado" VARCHAR(100) NOT NULL,
    "tipo_evento" VARCHAR(150) NOT NULL,
    "conteudo" JSONB NOT NULL,
    "ocorrido_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publicado_redis_em" TIMESTAMPTZ,
    "quantidade_tentativas_publicacao" INTEGER NOT NULL DEFAULT 0,
    "ultimo_erro_publicacao" TEXT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eventos_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entregas_webhook" (
    "id" BIGSERIAL NOT NULL,
    "evento_outbox_id" BIGINT NOT NULL,
    "configuracao_webhook_id" BIGINT,
    "url_destino" TEXT,
    "usuario_id" BIGINT NOT NULL,
    "numero_tentativa" INTEGER NOT NULL,
    "situacao" VARCHAR(30) NOT NULL,
    "status_http" INTEGER,
    "corpo_resposta" TEXT,
    "mensagem_erro" TEXT,
    "latencia_ms" INTEGER,
    "solicitado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enviado_em" TIMESTAMPTZ,
    "proxima_tentativa_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entregas_webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registros_auditoria" (
    "id" BIGSERIAL NOT NULL,
    "usuario_afetado_id" BIGINT,
    "usuario_ator_id" BIGINT,
    "credencial_api_id" BIGINT,
    "origem" VARCHAR(30) NOT NULL,
    "operacao" VARCHAR(20) NOT NULL,
    "nome_tabela" VARCHAR(100),
    "chave_registro" VARCHAR(255),
    "acao" VARCHAR(150) NOT NULL,
    "dados_anteriores" JSONB,
    "dados_novos" JSONB,
    "campos_alterados" JSONB,
    "endereco_ip" VARCHAR(45),
    "agente_usuario" TEXT,
    "metodo_http" VARCHAR(10),
    "caminho_requisicao" VARCHAR(500),
    "identificador_requisicao" VARCHAR(100),
    "identificador_rastreio" VARCHAR(100),
    "sucesso" BOOLEAN NOT NULL DEFAULT true,
    "mensagem_erro" TEXT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registros_auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "politicas_limite_requisicoes" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT,
    "escopo" VARCHAR(30) NOT NULL,
    "caminho_rota" VARCHAR(500),
    "quantidade_maxima" INTEGER NOT NULL,
    "janela_segundos" INTEGER NOT NULL,
    "duracao_bloqueio_segundos" INTEGER NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "politicas_limite_requisicoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bloqueios_acesso" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT,
    "credencial_api_id" BIGINT,
    "tipo_alvo" VARCHAR(30) NOT NULL,
    "valor_alvo" VARCHAR(255) NOT NULL,
    "motivo" VARCHAR(500) NOT NULL,
    "origem" VARCHAR(30) NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "bloqueado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMPTZ,
    "desbloqueado_em" TIMESTAMPTZ,
    "criado_por_usuario_id" BIGINT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "bloqueios_acesso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eventos_seguranca" (
    "id" BIGSERIAL NOT NULL,
    "usuario_id" BIGINT,
    "credencial_api_id" BIGINT,
    "tipo_evento" VARCHAR(50) NOT NULL,
    "severidade" VARCHAR(20) NOT NULL,
    "endereco_ip" VARCHAR(45),
    "caminho" VARCHAR(500),
    "quantidade_detectada" INTEGER,
    "janela_segundos" INTEGER,
    "acao_aplicada" VARCHAR(100),
    "dados" JSONB NOT NULL DEFAULT '{}',
    "ocorrido_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eventos_seguranca_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saldos_adquirentes" (
    "conta_provedor_id" BIGINT NOT NULL,
    "moeda" VARCHAR(3) NOT NULL DEFAULT 'BRL',
    "saldo_disponivel" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "saldo_bloqueado" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "consultado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erro_ultima_consulta" TEXT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "saldos_adquirentes_pkey" PRIMARY KEY ("conta_provedor_id")
);

-- CreateTable
CREATE TABLE "gatilhos_saque_adquirente" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "conta_provedor_id" BIGINT NOT NULL,
    "nome" VARCHAR(120) NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ordem" INTEGER NOT NULL DEFAULT 0,
    "valor_gatilho" DECIMAL(19,2) NOT NULL,
    "valor_reserva" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "valor_minimo_payout" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "valor_maximo_payout" DECIMAL(19,2),
    "chave_pix" VARCHAR(255) NOT NULL,
    "tipo_chave_pix" "TipoChavePix" NOT NULL,
    "nome_titular" VARCHAR(255),
    "documento_titular" VARCHAR(20),
    "intervalo_minimo_minutos" INTEGER NOT NULL DEFAULT 60,
    "ultima_execucao_em" TIMESTAMPTZ,
    "criado_por_usuario_id" BIGINT,
    "atualizado_por_usuario_id" BIGINT,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "gatilhos_saque_adquirente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execucoes_gatilho_saque" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "gatilho_id" BIGINT NOT NULL,
    "conta_provedor_id" BIGINT NOT NULL,
    "chave_idempotencia" VARCHAR(255) NOT NULL,
    "origem" VARCHAR(20) NOT NULL DEFAULT 'AUTOMATICO',
    "saldo_observado" DECIMAL(19,2) NOT NULL,
    "valor_solicitado" DECIMAL(19,2) NOT NULL,
    "situacao" VARCHAR(30) NOT NULL DEFAULT 'PENDENTE',
    "id_transacao_liquidante" VARCHAR(255),
    "mensagem_erro" TEXT,
    "solicitado_por_usuario_id" BIGINT,
    "metadados" JSONB NOT NULL DEFAULT '{}',
    "concluido_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "execucoes_gatilho_saque_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contingencia_adquirente" (
    "id" BIGSERIAL NOT NULL,
    "conta_provedor_id" BIGINT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "observacao" VARCHAR(255),
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contingencia_adquirente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "falhas_adquirente" (
    "id" BIGSERIAL NOT NULL,
    "id_publico" UUID NOT NULL,
    "transacao_id" BIGINT,
    "conta_provedor_id" BIGINT NOT NULL,
    "usuario_id" BIGINT,
    "tipo" VARCHAR(30) NOT NULL,
    "ordem_tentativa" INTEGER NOT NULL DEFAULT 0,
    "mensagem" TEXT,
    "status_http" INTEGER,
    "codigo_erro" VARCHAR(100),
    "dados_requisicao" JSONB,
    "dados_resposta" JSONB,
    "latencia_ms" INTEGER,
    "resolvida_por_conta_provedor_id" BIGINT,
    "resolvida_em" TIMESTAMPTZ,
    "criado_em" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "falhas_adquirente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_id_publico_key" ON "usuarios"("id_publico");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_cpf_cnpj_key" ON "usuarios"("cpf_cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_email_key" ON "usuarios"("email");

-- CreateIndex
CREATE INDEX "usuarios_situacao_idx" ON "usuarios"("situacao");

-- CreateIndex
CREATE INDEX "aceites_documentos_legais_usuario_id_idx" ON "aceites_documentos_legais"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "chaves_pix_usuarios_id_publico_key" ON "chaves_pix_usuarios"("id_publico");

-- CreateIndex
CREATE INDEX "chaves_pix_usuarios_usuario_id_situacao_idx" ON "chaves_pix_usuarios"("usuario_id", "situacao");

-- CreateIndex
CREATE UNIQUE INDEX "chaves_pix_usuarios_usuario_id_chave_key" ON "chaves_pix_usuarios"("usuario_id", "chave");

-- CreateIndex
CREATE INDEX "documentos_usuarios_usuario_id_idx" ON "documentos_usuarios"("usuario_id");

-- CreateIndex
CREATE INDEX "historicos_situacoes_usuarios_usuario_id_idx" ON "historicos_situacoes_usuarios"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "papeis_nome_key" ON "papeis"("nome");

-- CreateIndex
CREATE UNIQUE INDEX "permissoes_codigo_key" ON "permissoes"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "tokens_redefinicao_senha_token_hash_key" ON "tokens_redefinicao_senha"("token_hash");

-- CreateIndex
CREATE INDEX "auditorias_acesso_usuario_id_sucesso_ocorrido_em_idx" ON "auditorias_acesso"("usuario_id", "sucesso", "ocorrido_em");

-- CreateIndex
CREATE UNIQUE INDEX "credenciais_api_chave_publica_key" ON "credenciais_api"("chave_publica");

-- CreateIndex
CREATE INDEX "credenciais_api_usuario_id_idx" ON "credenciais_api"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "credenciais_api_usuario_id_nome_key" ON "credenciais_api"("usuario_id", "nome");

-- CreateIndex
CREATE UNIQUE INDEX "ips_permitidos_api_credencial_api_id_ip_ou_cidr_key" ON "ips_permitidos_api"("credencial_api_id", "ip_ou_cidr");

-- CreateIndex
CREATE UNIQUE INDEX "provedores_pagamento_codigo_key" ON "provedores_pagamento"("codigo");

-- CreateIndex
CREATE INDEX "liberacoes_adquirente_usuario_usuario_id_idx" ON "liberacoes_adquirente_usuario"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "liberacoes_adquirente_usuario_provedor_pagamento_id_usuario_key" ON "liberacoes_adquirente_usuario"("provedor_pagamento_id", "usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "ips_permitidos_webhook_provedor_provedor_pagamento_id_ip_ou_key" ON "ips_permitidos_webhook_provedor"("provedor_pagamento_id", "ip_ou_cidr");

-- CreateIndex
CREATE UNIQUE INDEX "contas_provedor_chave_unica_conta_key" ON "contas_provedor"("chave_unica_conta");

-- CreateIndex
CREATE INDEX "contas_provedor_provedor_pagamento_id_idx" ON "contas_provedor"("provedor_pagamento_id");

-- CreateIndex
CREATE UNIQUE INDEX "configuracoes_padrao_pix_usuarios_nome_key" ON "configuracoes_padrao_pix_usuarios"("nome");

-- CreateIndex
CREATE INDEX "configuracoes_pix_usuarios_conta_provedor_pix_entrada_id_idx" ON "configuracoes_pix_usuarios"("conta_provedor_pix_entrada_id");

-- CreateIndex
CREATE UNIQUE INDEX "transacoes_id_transacao_publico_key" ON "transacoes"("id_transacao_publico");

-- CreateIndex
CREATE UNIQUE INDEX "transacoes_id_transacao_privado_key" ON "transacoes"("id_transacao_privado");

-- CreateIndex
CREATE INDEX "transacoes_usuario_id_idx" ON "transacoes"("usuario_id");

-- CreateIndex
CREATE INDEX "transacoes_situacao_idx" ON "transacoes"("situacao");

-- CreateIndex
CREATE INDEX "transacoes_criado_em_idx" ON "transacoes"("criado_em");

-- CreateIndex
CREATE INDEX "transacoes_usuario_id_criado_em_idx" ON "transacoes"("usuario_id", "criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "transacoes_usuario_id_referencia_externa_key" ON "transacoes"("usuario_id", "referencia_externa");

-- CreateIndex
CREATE INDEX "transacoes_pix_txid_idx" ON "transacoes_pix"("txid");

-- CreateIndex
CREATE INDEX "transacoes_pix_identificador_fim_a_fim_idx" ON "transacoes_pix"("identificador_fim_a_fim");

-- CreateIndex
CREATE INDEX "itens_cobranca_transacao_id_idx" ON "itens_cobranca"("transacao_id");

-- CreateIndex
CREATE INDEX "tentativas_transacoes_id_transacao_liquidante_idx" ON "tentativas_transacoes"("id_transacao_liquidante");

-- CreateIndex
CREATE UNIQUE INDEX "tentativas_transacoes_transacao_id_numero_tentativa_key" ON "tentativas_transacoes"("transacao_id", "numero_tentativa");

-- CreateIndex
CREATE INDEX "historicos_situacoes_transacoes_transacao_id_idx" ON "historicos_situacoes_transacoes"("transacao_id");

-- CreateIndex
CREATE UNIQUE INDEX "chaves_idempotencia_usuario_id_chave_idempotencia_key" ON "chaves_idempotencia"("usuario_id", "chave_idempotencia");

-- CreateIndex
CREATE UNIQUE INDEX "devolucoes_pix_id_devolucao_publico_key" ON "devolucoes_pix"("id_devolucao_publico");

-- CreateIndex
CREATE UNIQUE INDEX "movimentacoes_saldo_id_publico_key" ON "movimentacoes_saldo"("id_publico");

-- CreateIndex
CREATE UNIQUE INDEX "movimentacoes_saldo_chave_idempotencia_key" ON "movimentacoes_saldo"("chave_idempotencia");

-- CreateIndex
CREATE INDEX "movimentacoes_saldo_usuario_id_idx" ON "movimentacoes_saldo"("usuario_id");

-- CreateIndex
CREATE INDEX "movimentacoes_saldo_transacao_id_idx" ON "movimentacoes_saldo"("transacao_id");

-- CreateIndex
CREATE INDEX "movimentacoes_saldo_ocorrido_em_idx" ON "movimentacoes_saldo"("ocorrido_em");

-- CreateIndex
CREATE INDEX "liberacoes_saldo_situacao_liberar_em_idx" ON "liberacoes_saldo"("situacao", "liberar_em");

-- CreateIndex
CREATE UNIQUE INDEX "liberacoes_saldo_transacao_id_tipo_liberacao_key" ON "liberacoes_saldo"("transacao_id", "tipo_liberacao");

-- CreateIndex
CREATE UNIQUE INDEX "bloqueios_saldo_id_publico_key" ON "bloqueios_saldo"("id_publico");

-- CreateIndex
CREATE UNIQUE INDEX "casos_med_id_publico_key" ON "casos_med"("id_publico");

-- CreateIndex
CREATE UNIQUE INDEX "casos_med_chave_idempotencia_key" ON "casos_med"("chave_idempotencia");

-- CreateIndex
CREATE INDEX "casos_med_transacao_id_idx" ON "casos_med"("transacao_id");

-- CreateIndex
CREATE INDEX "casos_med_situacao_idx" ON "casos_med"("situacao");

-- CreateIndex
CREATE INDEX "historicos_casos_med_caso_med_id_idx" ON "historicos_casos_med"("caso_med_id");

-- CreateIndex
CREATE INDEX "configuracoes_webhook_usuario_usuario_id_idx" ON "configuracoes_webhook_usuario"("usuario_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_recebidos_provedor_chave_idempotencia_key" ON "webhooks_recebidos_provedor"("chave_idempotencia");

-- CreateIndex
CREATE UNIQUE INDEX "eventos_outbox_evento_uuid_key" ON "eventos_outbox"("evento_uuid");

-- CreateIndex
CREATE INDEX "eventos_outbox_publicado_redis_em_idx" ON "eventos_outbox"("publicado_redis_em");

-- CreateIndex
CREATE UNIQUE INDEX "entregas_webhook_evento_outbox_id_configuracao_webhook_id_n_key" ON "entregas_webhook"("evento_outbox_id", "configuracao_webhook_id", "numero_tentativa");

-- CreateIndex
CREATE INDEX "registros_auditoria_criado_em_idx" ON "registros_auditoria"("criado_em");

-- CreateIndex
CREATE INDEX "eventos_seguranca_ocorrido_em_idx" ON "eventos_seguranca"("ocorrido_em");

-- CreateIndex
CREATE UNIQUE INDEX "gatilhos_saque_adquirente_id_publico_key" ON "gatilhos_saque_adquirente"("id_publico");

-- CreateIndex
CREATE INDEX "gatilhos_saque_adquirente_conta_provedor_id_ativo_idx" ON "gatilhos_saque_adquirente"("conta_provedor_id", "ativo");

-- CreateIndex
CREATE UNIQUE INDEX "execucoes_gatilho_saque_id_publico_key" ON "execucoes_gatilho_saque"("id_publico");

-- CreateIndex
CREATE UNIQUE INDEX "execucoes_gatilho_saque_chave_idempotencia_key" ON "execucoes_gatilho_saque"("chave_idempotencia");

-- CreateIndex
CREATE INDEX "execucoes_gatilho_saque_gatilho_id_criado_em_idx" ON "execucoes_gatilho_saque"("gatilho_id", "criado_em");

-- CreateIndex
CREATE INDEX "execucoes_gatilho_saque_situacao_idx" ON "execucoes_gatilho_saque"("situacao");

-- CreateIndex
CREATE INDEX "execucoes_gatilho_saque_criado_em_idx" ON "execucoes_gatilho_saque"("criado_em");

-- CreateIndex
CREATE UNIQUE INDEX "contingencia_adquirente_conta_provedor_id_key" ON "contingencia_adquirente"("conta_provedor_id");

-- CreateIndex
CREATE UNIQUE INDEX "contingencia_adquirente_ordem_key" ON "contingencia_adquirente"("ordem");

-- CreateIndex
CREATE UNIQUE INDEX "falhas_adquirente_id_publico_key" ON "falhas_adquirente"("id_publico");

-- CreateIndex
CREATE INDEX "falhas_adquirente_criado_em_idx" ON "falhas_adquirente"("criado_em");

-- CreateIndex
CREATE INDEX "falhas_adquirente_conta_provedor_id_criado_em_idx" ON "falhas_adquirente"("conta_provedor_id", "criado_em");

-- CreateIndex
CREATE INDEX "falhas_adquirente_tipo_idx" ON "falhas_adquirente"("tipo");

-- CreateIndex
CREATE INDEX "falhas_adquirente_transacao_id_idx" ON "falhas_adquirente"("transacao_id");

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_ativado_por_usuario_id_fkey" FOREIGN KEY ("ativado_por_usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aceites_documentos_legais" ADD CONSTRAINT "aceites_documentos_legais_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chaves_pix_usuarios" ADD CONSTRAINT "chaves_pix_usuarios_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chaves_pix_usuarios" ADD CONSTRAINT "chaves_pix_usuarios_aprovada_por_usuario_id_fkey" FOREIGN KEY ("aprovada_por_usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentos_usuarios" ADD CONSTRAINT "documentos_usuarios_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analises_cadastro_usuarios" ADD CONSTRAINT "analises_cadastro_usuarios_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historicos_situacoes_usuarios" ADD CONSTRAINT "historicos_situacoes_usuarios_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuarios_papeis" ADD CONSTRAINT "usuarios_papeis_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuarios_papeis" ADD CONSTRAINT "usuarios_papeis_papel_id_fkey" FOREIGN KEY ("papel_id") REFERENCES "papeis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "papeis_permissoes" ADD CONSTRAINT "papeis_permissoes_papel_id_fkey" FOREIGN KEY ("papel_id") REFERENCES "papeis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "papeis_permissoes" ADD CONSTRAINT "papeis_permissoes_permissao_id_fkey" FOREIGN KEY ("permissao_id") REFERENCES "permissoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tokens_redefinicao_senha" ADD CONSTRAINT "tokens_redefinicao_senha_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auditorias_acesso" ADD CONSTRAINT "auditorias_acesso_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credenciais_api" ADD CONSTRAINT "credenciais_api_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ips_permitidos_api" ADD CONSTRAINT "ips_permitidos_api_credencial_api_id_fkey" FOREIGN KEY ("credencial_api_id") REFERENCES "credenciais_api"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registros_acesso_api" ADD CONSTRAINT "registros_acesso_api_credencial_api_id_fkey" FOREIGN KEY ("credencial_api_id") REFERENCES "credenciais_api"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liberacoes_adquirente_usuario" ADD CONSTRAINT "liberacoes_adquirente_usuario_provedor_pagamento_id_fkey" FOREIGN KEY ("provedor_pagamento_id") REFERENCES "provedores_pagamento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liberacoes_adquirente_usuario" ADD CONSTRAINT "liberacoes_adquirente_usuario_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ips_permitidos_webhook_provedor" ADD CONSTRAINT "ips_permitidos_webhook_provedor_provedor_pagamento_id_fkey" FOREIGN KEY ("provedor_pagamento_id") REFERENCES "provedores_pagamento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contas_provedor" ADD CONSTRAINT "contas_provedor_provedor_pagamento_id_fkey" FOREIGN KEY ("provedor_pagamento_id") REFERENCES "provedores_pagamento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contas_provedor" ADD CONSTRAINT "contas_provedor_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custos_pix_contas_provedor" ADD CONSTRAINT "custos_pix_contas_provedor_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuracoes_padrao_pix_usuarios" ADD CONSTRAINT "configuracoes_padrao_pix_usuarios_conta_provedor_pix_entra_fkey" FOREIGN KEY ("conta_provedor_pix_entrada_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuracoes_padrao_pix_usuarios" ADD CONSTRAINT "configuracoes_padrao_pix_usuarios_conta_provedor_pix_saida_fkey" FOREIGN KEY ("conta_provedor_pix_saida_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuracoes_pix_usuarios" ADD CONSTRAINT "configuracoes_pix_usuarios_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuracoes_pix_usuarios" ADD CONSTRAINT "configuracoes_pix_usuarios_configuracao_padrao_origem_id_fkey" FOREIGN KEY ("configuracao_padrao_origem_id") REFERENCES "configuracoes_padrao_pix_usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuracoes_pix_usuarios" ADD CONSTRAINT "configuracoes_pix_usuarios_conta_provedor_pix_entrada_id_fkey" FOREIGN KEY ("conta_provedor_pix_entrada_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuracoes_pix_usuarios" ADD CONSTRAINT "configuracoes_pix_usuarios_conta_provedor_pix_saida_id_fkey" FOREIGN KEY ("conta_provedor_pix_saida_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_credencial_api_id_fkey" FOREIGN KEY ("credencial_api_id") REFERENCES "credenciais_api"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes" ADD CONSTRAINT "transacoes_transacao_origem_id_fkey" FOREIGN KEY ("transacao_origem_id") REFERENCES "transacoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transacoes_pix" ADD CONSTRAINT "transacoes_pix_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itens_cobranca" ADD CONSTRAINT "itens_cobranca_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tentativas_transacoes" ADD CONSTRAINT "tentativas_transacoes_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tentativas_transacoes" ADD CONSTRAINT "tentativas_transacoes_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historicos_situacoes_transacoes" ADD CONSTRAINT "historicos_situacoes_transacoes_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chaves_idempotencia" ADD CONSTRAINT "chaves_idempotencia_credencial_api_id_fkey" FOREIGN KEY ("credencial_api_id") REFERENCES "credenciais_api"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chaves_idempotencia" ADD CONSTRAINT "chaves_idempotencia_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devolucoes_pix" ADD CONSTRAINT "devolucoes_pix_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devolucoes_pix" ADD CONSTRAINT "devolucoes_pix_caso_med_id_fkey" FOREIGN KEY ("caso_med_id") REFERENCES "casos_med"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saldos_usuarios" ADD CONSTRAINT "saldos_usuarios_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentacoes_saldo" ADD CONSTRAINT "movimentacoes_saldo_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentacoes_saldo" ADD CONSTRAINT "movimentacoes_saldo_devolucao_pix_id_fkey" FOREIGN KEY ("devolucao_pix_id") REFERENCES "devolucoes_pix"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentacoes_saldo" ADD CONSTRAINT "movimentacoes_saldo_caso_med_id_fkey" FOREIGN KEY ("caso_med_id") REFERENCES "casos_med"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentacoes_saldo" ADD CONSTRAINT "movimentacoes_saldo_movimentacao_relacionada_id_fkey" FOREIGN KEY ("movimentacao_relacionada_id") REFERENCES "movimentacoes_saldo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liberacoes_saldo" ADD CONSTRAINT "liberacoes_saldo_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liberacoes_saldo" ADD CONSTRAINT "liberacoes_saldo_movimentacao_liberacao_id_fkey" FOREIGN KEY ("movimentacao_liberacao_id") REFERENCES "movimentacoes_saldo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bloqueios_saldo" ADD CONSTRAINT "bloqueios_saldo_caso_med_id_fkey" FOREIGN KEY ("caso_med_id") REFERENCES "casos_med"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casos_med" ADD CONSTRAINT "casos_med_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casos_med" ADD CONSTRAINT "casos_med_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casos_med" ADD CONSTRAINT "casos_med_webhook_recebido_id_fkey" FOREIGN KEY ("webhook_recebido_id") REFERENCES "webhooks_recebidos_provedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historicos_casos_med" ADD CONSTRAINT "historicos_casos_med_caso_med_id_fkey" FOREIGN KEY ("caso_med_id") REFERENCES "casos_med"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhooks_recebidos_provedor" ADD CONSTRAINT "webhooks_recebidos_provedor_provedor_pagamento_id_fkey" FOREIGN KEY ("provedor_pagamento_id") REFERENCES "provedores_pagamento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas_webhook" ADD CONSTRAINT "entregas_webhook_evento_outbox_id_fkey" FOREIGN KEY ("evento_outbox_id") REFERENCES "eventos_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entregas_webhook" ADD CONSTRAINT "entregas_webhook_configuracao_webhook_id_fkey" FOREIGN KEY ("configuracao_webhook_id") REFERENCES "configuracoes_webhook_usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saldos_adquirentes" ADD CONSTRAINT "saldos_adquirentes_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gatilhos_saque_adquirente" ADD CONSTRAINT "gatilhos_saque_adquirente_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes_gatilho_saque" ADD CONSTRAINT "execucoes_gatilho_saque_gatilho_id_fkey" FOREIGN KEY ("gatilho_id") REFERENCES "gatilhos_saque_adquirente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes_gatilho_saque" ADD CONSTRAINT "execucoes_gatilho_saque_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contingencia_adquirente" ADD CONSTRAINT "contingencia_adquirente_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "falhas_adquirente" ADD CONSTRAINT "falhas_adquirente_transacao_id_fkey" FOREIGN KEY ("transacao_id") REFERENCES "transacoes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "falhas_adquirente" ADD CONSTRAINT "falhas_adquirente_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "falhas_adquirente" ADD CONSTRAINT "falhas_adquirente_resolvida_por_conta_provedor_id_fkey" FOREIGN KEY ("resolvida_por_conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "falhas_adquirente" ADD CONSTRAINT "falhas_adquirente_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
