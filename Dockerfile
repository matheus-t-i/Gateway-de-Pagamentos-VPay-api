# syntax=docker/dockerfile:1
#
# Imagem ÚNICA para API e Worker — o que muda é o comando:
#   API:    node dist/main.js   (padrão)
#   Worker: node dist/worker.js (dockerCommand no render.yaml)
#
# node:22-slim (Debian) e não alpine: o engine do Prisma e os prebuilds do
# argon2 são glibc — em musl exigiriam compilação nativa no build.

FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# openssl: exigido pelo engine do Prisma. curl: probe manual de /health.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Cliente Prisma GERADO no build (o `npm ci --omit=dev` acima instala o
# @prisma/client cru, sem o client do nosso schema) + a CLI PINADA do lockfile:
# o preDeployCommand roda `prisma migrate deploy` dentro desta imagem, e um
# `npx` sem a CLI instalada baixaria a versão latest — drift de migração.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/.bin ./node_modules/.bin
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
