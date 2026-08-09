-- No máximo UMA tentativa "em voo ou aceita" por transação.
--
-- Fecha a corrida multi-worker no cash-out: dois processos podiam passar o
-- check `jaEnviado`, criar ENVIANDO com numeroTentativa 1 e 2, e mandar DOIS
-- PIX com um único débito. A unique (transacao_id, numero_tentativa) NÃO
-- impede isso.
--
-- ENVIANDO e SUCESSO são mutuamente exclusivos na prática (a linha sobe de
-- ENVIANDO → SUCESSO); o índice cobre os dois para o claim atômico do
-- processor e qualquer insert concorrente. FALHA fica de fora — recusa
-- confirmada libera eventual reenvio futuro legítimo.
--
-- Cash-in também se beneficia: contingência grava FALHA e depois UM SUCESSO.

-- Dados legados da corrida (ou retries) podem ter 2+ linhas ativas.
-- Mantém a mais recente; as demais viram FALHA para o índice poder nascer.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY transacao_id ORDER BY id DESC) AS rn
  FROM tentativas_transacoes
  WHERE situacao IN ('ENVIANDO', 'SUCESSO')
)
UPDATE tentativas_transacoes AS t
SET
  situacao = 'FALHA',
  mensagem_erro = LEFT(
    CONCAT(
      COALESCE(t.mensagem_erro, ''),
      CASE WHEN t.mensagem_erro IS NULL OR t.mensagem_erro = '' THEN '' ELSE ' | ' END,
      'dedupe migration 20260809180000: tentativas ativas duplicadas'
    ),
    2000
  ),
  concluido_em = COALESCE(t.concluido_em, NOW())
FROM ranked AS r
WHERE t.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX "tentativas_transacao_ativa_key"
  ON "tentativas_transacoes" ("transacao_id")
  WHERE "situacao" IN ('ENVIANDO', 'SUCESSO');
