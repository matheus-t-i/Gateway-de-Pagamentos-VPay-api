-- Round-robin da conciliação.
--
-- A varredura fazia `findMany({ take: 40 })` sem orderBy nem cursor sobre
-- AGUARDANDO_PAGAMENTO/PROCESSANDO/FALHA — e nada expira cobrança abandonada,
-- então as MESMAS 40 pendentes mais antigas eram relidas a cada tick e uma
-- transação recente nunca era alcançada (starvation da única rede de
-- recuperação de cash-in fantasma e saque órfão).
--
-- A coluna registra a última passada; a conciliação ordena por ela
-- (NULLS FIRST = nunca visitada vai primeiro) e a carimba a cada passe.
ALTER TABLE "transacoes" ADD COLUMN "ultima_conciliacao_em" TIMESTAMPTZ;

CREATE INDEX "transacoes_ultima_conciliacao_em_idx"
  ON "transacoes" ("ultima_conciliacao_em");
