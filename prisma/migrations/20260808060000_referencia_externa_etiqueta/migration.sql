-- `referenciaExterna` deixa de ser única por conta: é ETIQUETA do lojista.
-- O mesmo pedido pode legitimamente gerar mais de uma cobrança (carrinho
-- mudou, QR expirou, adquirentes falharam) — cobrança nunca responde 409 por
-- causa da referência. A idempotência (mesma referência + mesmos dados
-- devolve a mesma transação) é resolvida no PixService pela transação MAIS
-- RECENTE da referência, por sentido.

-- DropIndex
DROP INDEX "transacoes_usuario_id_referencia_externa_key";

-- CreateIndex
CREATE INDEX "transacoes_usuario_id_referencia_externa_idx" ON "transacoes"("usuario_id", "referencia_externa");
