# Gateway VPay — Claude Code

Dois repositórios: `Gateway-de-Pagamentos-VPay-api` (Nest API + Worker + Prisma) e `Gateway-de-Pagamentos-VPay-web` (Next.js).

## Webhook security (inegociável)

1. **Camada 1:** antes de creditar/terminal, consultar status na liquidante; se não confirmar → throw (job failed).
2. **Camada 2:** IP allowlist e/ou `x-key` do provedor.
3. Provedor inativo/suspenso → não atualiza tx nem saldo.
4. Match id externo + conta/provedor com a tx local; mismatch → rejeitar.
5. Um controller HTTP por adquirente em `src/providers/{codigo}/`.
6. Filas genéricas apenas; `provider` vai no job payload.

## Filas (nomes exatos)

- `1-pix-webhook-received`
- `2-pix-webhook-send`
- `3-pix-webhook-received-cashout`
- `4-pix-cash-out`
- `5-outbox-publisher`
- `6-liberacao-saldo`
- `7-conciliacao`
- `8-emails`
- `9-devolucao-pix`
- `10-saque-automatico`

Constantes em `src/shared/queues.ts`. Bull Board `/admin/queues` com ADMINISTRADOR.

## Ledger

Prisma CRUD normal; ledger com `$queryRaw`/`$executeRaw`/`$transaction` + `SELECT FOR UPDATE`. Dinheiro com Decimal/decimal.js — nunca float.

## Deploy

API + Worker separados (Render); web na Vercel; Postgres + Redis privados.
