-- SituacaoTransacao.DEVOLVIDA -> MED
--
-- "MED" (Mecanismo Especial de Devolução) é o termo que o mercado usa para a
-- contestação/chargeback do PIX, e é o status que o lojista recebe no callback.
-- Renomear o VALOR do enum é atômico e não reescreve as linhas existentes:
-- toda transação que estava DEVOLVIDA passa a ler MED automaticamente.
ALTER TYPE "SituacaoTransacao" RENAME VALUE 'DEVOLVIDA' TO 'MED';
