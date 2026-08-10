-- Controle de retentativa da devolução PIX (MED aceito).
--
-- A devolução nascia PENDENTE e era enfileirada DEPOIS do commit: enqueue
-- perdido (ou attempts:5 esgotado em ~30s de liquidante fora) deixava a linha
-- presa para sempre — ledger já debitado do lojista, pagador nunca recebendo,
-- e nenhuma varredura olhava devolucoes_pix.
--
-- Estas colunas dão à varredura da conciliação o que ela precisa para
-- reprocessar com teto (mesmo desenho de liberacoes_saldo): contador de
-- tentativas e o último erro, que também é o motivo exibido na tela de
-- dinheiro parado.
ALTER TABLE "devolucoes_pix"
  ADD COLUMN IF NOT EXISTS "quantidade_tentativas" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ultimo_erro" TEXT;

-- A varredura busca PENDENTE por idade; parcial porque CONCLUIDA (a vasta
-- maioria com o tempo) nunca é revisitada.
CREATE INDEX IF NOT EXISTS "devolucoes_pix_pendente_idx"
  ON "devolucoes_pix" ("situacao", "atualizado_em");
