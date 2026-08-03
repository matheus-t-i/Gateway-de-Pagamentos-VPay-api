-- CreateIndex
CREATE INDEX "auditorias_acesso_usuario_id_sucesso_ocorrido_em_idx" ON "auditorias_acesso"("usuario_id", "sucesso", "ocorrido_em");

-- CreateIndex
CREATE INDEX "tentativas_transacoes_id_transacao_liquidante_idx" ON "tentativas_transacoes"("id_transacao_liquidante");

-- CreateIndex
CREATE INDEX "transacoes_empresa_id_criado_em_idx" ON "transacoes"("empresa_id", "criado_em");

-- ============================================================================
-- INVARIANTES DE DINHEIRO NO BANCO
-- Até aqui o schema não tinha NENHUM CHECK: qualquer bug ou UPDATE manual podia
-- deixar saldo inconsistente sem o Postgres reclamar. Só saldo_disponivel pode
-- ficar negativo (empresas com permiteSaldoNegativo); os demais, nunca.
-- ============================================================================
ALTER TABLE saldos_empresas
  DROP CONSTRAINT IF EXISTS saldos_empresas_nao_negativos_chk;
ALTER TABLE saldos_empresas
  ADD CONSTRAINT saldos_empresas_nao_negativos_chk
  CHECK (
    saldo_pendente_liberacao >= 0
    AND saldo_reservado >= 0
    AND saldo_bloqueado_med >= 0
  );

-- Valores monetários de movimentação e transação são sempre positivos.
ALTER TABLE movimentacoes_saldo
  DROP CONSTRAINT IF EXISTS movimentacoes_saldo_valor_positivo_chk;
ALTER TABLE movimentacoes_saldo
  ADD CONSTRAINT movimentacoes_saldo_valor_positivo_chk CHECK (valor > 0);

ALTER TABLE devolucoes_pix
  DROP CONSTRAINT IF EXISTS devolucoes_pix_valor_positivo_chk;
ALTER TABLE devolucoes_pix
  ADD CONSTRAINT devolucoes_pix_valor_positivo_chk CHECK (valor > 0);

-- MED: os valores derivados não podem passar do contestado.
ALTER TABLE casos_med
  DROP CONSTRAINT IF EXISTS casos_med_valores_coerentes_chk;
ALTER TABLE casos_med
  ADD CONSTRAINT casos_med_valores_coerentes_chk
  CHECK (
    valor_solicitado > 0
    AND valor_bloqueado >= 0
    AND valor_debitado >= 0
    AND valor_nao_coberto >= 0
    AND valor_bloqueado <= valor_solicitado
    AND valor_debitado <= valor_solicitado
  );
