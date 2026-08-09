#!/usr/bin/env bash
# Release checklist — rode no ambiente de produção/staging antes de subir API+worker.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> prisma migrate deploy"
npx prisma migrate deploy

echo "==> health ready (API precisa estar no ar)"
# Ajuste a URL: local ou balanceador.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/health/ready}"
curl -fsS "$HEALTH_URL" | tee /tmp/vpay-health.json
echo
echo "OK — migrations aplicadas e /health/ready respondeu."
