-- No máximo uma devolução por caso MED.
-- Fecha a corrida em MedService.decidir: dois cliques paralelos criavam
-- duas linhas em devolucoes_pix (e dois PIX de devolução na liquidante).

CREATE UNIQUE INDEX "devolucoes_pix_caso_med_id_key"
  ON "devolucoes_pix" ("caso_med_id")
  WHERE "caso_med_id" IS NOT NULL;
