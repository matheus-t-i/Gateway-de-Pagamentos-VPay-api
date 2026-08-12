#!/bin/sh
# Sobe API + Worker no MESMO container (útil no Render Starter sem pagar
# o Background Worker separado). Preferível em produção: serviço vpay-worker.
#
# Uso no Docker Command do Render:
#   sh scripts/start-api-com-worker.sh
#
# SIGTERM (deploy/restart): propaga para os dois e espera o job em voo
# do BullMQ terminar (enableShutdownHooks no worker).

set -eu

node dist/worker.js &
WORKER_PID=$!

node dist/main.js &
API_PID=$!

term() {
  kill -TERM "$WORKER_PID" "$API_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
}
trap term TERM INT

# Sai se qualquer um dos dois morrer (não deixa órfão processando fila).
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WORKER_PID" 2>/dev/null; do
  sleep 2
done

term
exit 1
