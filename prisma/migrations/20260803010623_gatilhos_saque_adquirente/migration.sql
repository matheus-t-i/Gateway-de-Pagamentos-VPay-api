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

-- AddForeignKey
ALTER TABLE "saldos_adquirentes" ADD CONSTRAINT "saldos_adquirentes_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gatilhos_saque_adquirente" ADD CONSTRAINT "gatilhos_saque_adquirente_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes_gatilho_saque" ADD CONSTRAINT "execucoes_gatilho_saque_gatilho_id_fkey" FOREIGN KEY ("gatilho_id") REFERENCES "gatilhos_saque_adquirente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "execucoes_gatilho_saque" ADD CONSTRAINT "execucoes_gatilho_saque_conta_provedor_id_fkey" FOREIGN KEY ("conta_provedor_id") REFERENCES "contas_provedor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- INVARIANTES DE DINHEIRO DOS GATILHOS (mesmo padrão dos demais valores)
-- Um gatilho com valor negativo ou com mínimo acima do máximo sacaria valores
-- absurdos da conta na adquirente — o banco recusa antes de chegar lá.
-- ============================================================================
ALTER TABLE gatilhos_saque_adquirente
  DROP CONSTRAINT IF EXISTS gatilhos_saque_valores_coerentes_chk;
ALTER TABLE gatilhos_saque_adquirente
  ADD CONSTRAINT gatilhos_saque_valores_coerentes_chk
  CHECK (
    valor_gatilho > 0
    AND valor_reserva >= 0
    AND valor_minimo_payout >= 0
    AND (valor_maximo_payout IS NULL OR valor_maximo_payout >= valor_minimo_payout)
    AND (valor_maximo_payout IS NULL OR valor_maximo_payout > 0)
    AND intervalo_minimo_minutos >= 0
  );

ALTER TABLE execucoes_gatilho_saque
  DROP CONSTRAINT IF EXISTS execucoes_gatilho_saque_valores_chk;
ALTER TABLE execucoes_gatilho_saque
  ADD CONSTRAINT execucoes_gatilho_saque_valores_chk
  CHECK (valor_solicitado > 0 AND saldo_observado >= 0);

ALTER TABLE saldos_adquirentes
  DROP CONSTRAINT IF EXISTS saldos_adquirentes_nao_negativos_chk;
ALTER TABLE saldos_adquirentes
  ADD CONSTRAINT saldos_adquirentes_nao_negativos_chk
  CHECK (saldo_disponivel >= 0 AND saldo_bloqueado >= 0);
