# Gateway VPay API

NestJS dual entry: HTTP API + BullMQ Worker (mesmo repositório).

## Stack

- NestJS + Prisma + PostgreSQL 16 + Redis 7
- BullMQ filas genéricas + Bull Board (`/admin/queues`, ADMINISTRADOR)
- decimal.js para dinheiro
- Mock provider em `src/providers/mock/`

## Subir local

```bash
cd Gateway-de-Pagamentos-VPay-api
docker compose up -d
npx pnpm@9.15.0 install
npx pnpm@9.15.0 db:generate
npx pnpm@9.15.0 exec prisma migrate dev --name init
npx pnpm@9.15.0 db:seed
npx pnpm@9.15.0 dev:api      # :3001
npx pnpm@9.15.0 dev:worker
```

Admin seed: `admin@vpay.local` / `Admin@123456`

Health: `GET /health`  
API prefix: `/api`  
Bull Board: `http://localhost:3001/admin/queues` (Bearer JWT ADMINISTRADOR)
