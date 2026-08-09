-- Uma `referenciaExterna` identifica NO MÁXIMO UM saque por conta.
--
-- Índice PARCIAL, só para SAIDA: cash-in continua podendo repetir a referência
-- (regra "nunca perder venda" — carrinho mudou, QR expirou, adquirente falhou).
--
-- Por que no BANCO e não só no código: o pre-check de retentativa em
-- `PixService.criarSaque` é read-then-write. Duas chamadas no MESMO instante
-- (bot que reenvia) leem "não existe" antes de qualquer uma gravar, e as duas
-- seguem — criando dois saques, dois débitos e DOIS PIX pagos. Reproduzido em
-- `src/pix/saque-concorrencia.spec.ts`. Só o banco resolve a corrida.
--
-- A perdedora recebe P2002 e `criarSaque` a trata como retentativa: relê a
-- vencedora e devolve o MESMO saque (ou 409, se os dados divergirem).
--
-- Saque SEM referência continua permitido e não é coberto por este índice
-- (NULL não colide no Postgres) — sem um identificador do lojista, duas
-- chamadas são dois saques legítimos, e quem limita é o saldo.

CREATE UNIQUE INDEX "transacoes_saque_referencia_key"
  ON "transacoes" ("usuario_id", "referencia_externa")
  WHERE "direcao" = 'SAIDA' AND "referencia_externa" IS NOT NULL;
