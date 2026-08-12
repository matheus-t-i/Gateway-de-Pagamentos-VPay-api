# Gateway VPay — API

Backend do gateway de pagamentos PIX da VPay. Um único repositório NestJS com **dois entrypoints**:

- **API HTTP** (`src/main.ts`) — REST para o painel web, API pública do lojista e webhooks das adquirentes.
- **Worker** (`src/worker.ts`) — application context sem HTTP que consome as filas BullMQ (crédito de saldo, entrega de webhooks, saques, conciliação, e-mails, tesouraria).

## Stack

| Camada | Tecnologia |
|---|---|
| Framework | NestJS 10 (Express 5) |
| Banco | PostgreSQL 16 + Prisma 6 |
| Filas | BullMQ 5 + Redis 7 (painel Bull Board em `/admin/queues`) |
| Autenticação | JWT (`@nestjs/jwt` + passport-jwt), senhas com argon2, 2FA TOTP (otplib + qrcode) |
| Dinheiro | decimal.js — **nunca float** |
| Validação | Zod (schemas em `src/shared/schemas.ts`) + validação de env no boot |
| Criptografia | AES-256-GCM (`ENCRYPTION_KEY`) para credenciais de adquirente, segredo TOTP e segredo de webhook |
| Logs | nestjs-pino (pretty em dev, redaction de headers sensíveis) |
| E-mail | nodemailer (modo LOG quando `SMTP_HOST` ausente) |

Não há Swagger — a referência da API pública vive no painel web (`/desenvolvedores/documentacao`).

## Subir local

Pré-requisitos: Node 20+, Docker Desktop.

```bash
docker compose up -d          # Postgres 16 + Redis 7 (só infra; a app roda fora do Docker)
cp .env.example .env          # no Windows: copy .env.example .env
npm install                   # ou: npx pnpm@9.15.0 install
npm run db:generate           # obrigatório — sem isso o TypeScript quebra (Prisma Client stub)
npx prisma migrate dev
npm run db:seed
npm run dev:api               # API em http://localhost:3001 (prefixo /api)
npm run dev:worker            # em outro terminal
```

**Por que `db:generate` é obrigatório:** o `npm install` instala o pacote `@prisma/client`, mas o client tipado só existe depois do `prisma generate` (lê `prisma/schema.prisma` e gera os tipos em `node_modules/.prisma`). Sem esse passo, o Nest sobe com dezenas/centenas de erros `TS7006` / `TS2694` (`implicitly has an 'any' type`, `Prisma.X does not exist`). Rode de novo sempre que o schema mudar (ou após um clone/`install` limpo).

**Proxy / certificado SSL (rede corporativa):** se `prisma generate` falhar com `unable to get local issuer certificate` ao baixar engines de `binaries.prisma.sh`, use no PowerShell só nessa sessão:

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED='0'
npm run db:generate
```

Preferível a longo prazo: apontar o CA corporativo com `NODE_EXTRA_CA_CERTS` em vez de desligar a verificação TLS.

- Admin seed: `admin@vpay.local` / `Admin@123456` (sobrescrevível por `ADMIN_EMAIL`/`ADMIN_PASSWORD`; reexecutar o seed não reseta a senha).
- Health check: `GET /health` (fora do prefixo `/api`).
- Bull Board: `http://localhost:3001/admin/queues` — Bearer JWT ou cookie `access_token`; exige papel `ADMINISTRADOR` ou permissão `admin.filas.ver`.
- O worker **precisa** estar rodando: sem ele nenhum saldo é creditado, nenhum webhook é entregue e nenhum saque sai.

## Scripts npm

| Script | O que faz |
|---|---|
| `dev` / `dev:api` | API em watch mode |
| `dev:worker` | Worker em watch mode (`--entryFile worker`) |
| `build` | Compila para `dist/` |
| `start` / `start:worker` | API / Worker em produção (`node dist/main.js` / `node dist/worker.js`) |
| `db:generate` | Gera o Prisma Client tipado — **obrigatório** após install / mudança de schema |
| `db:migrate` | `prisma migrate dev` |
| `db:deploy` | `prisma migrate deploy` (produção) |
| `db:seed` | Roda `prisma/seed.ts` (tsx) |
| `db:studio` | Prisma Studio |
| `test` | Jest (`*.spec.ts`; hoje só o teste de concorrência do ledger, que exige Postgres real) |

## Variáveis de ambiente

Validadas no boot por `src/common/env.validation.ts` (fail-fast). Em produção, segredos com valor de exemplo derrubam o processo. Copie `.env.example` para `.env`.

### Obrigatórias

| Variável | Para que serve |
|---|---|
| `DATABASE_URL` | Conexão Postgres (Prisma) |
| `REDIS_URL` | Conexão Redis (BullMQ + rate limit) |
| `JWT_SECRET` | Assinatura do JWT (produção: ≥32 chars, sem valor de exemplo) |
| `ENCRYPTION_KEY` | AES-256-GCM, exatamente 64 chars hex |

### Servidor

| Variável | Para que serve |
|---|---|
| `API_PORT` | Porta local (default `3001`); `PORT` (injetada pela plataforma) tem precedência |
| `NODE_ENV` | `production` liga as validações estritas de boot e endurece o seed |
| `WEB_URL` | Origem permitida no CORS (default `http://localhost:3000`); obrigatória em produção |
| `TRUST_PROXY` | `1` para `req.ip` real atrás de proxy — **obrigatória em produção** (as allowlists de IP dependem disso) |
| `JWT_EXPIRES_IN` | Validade do token (default `1h`) |
| `STORAGE_DRIVER` | Em produção não pode ser ausente nem `local` (KYC em disco efêmero) |
| `UPLOADS_DIR` | Raiz do armazenamento local de documentos (default `./uploads`) |

### Seed, e-mail e marca

| Variável | Para que serve |
|---|---|
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Admin criado pelo seed (`ADMIN_PASSWORD` obrigatória em produção) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | SMTP; sem `SMTP_HOST` o `EmailService` só registra no log |
| `BRAND_NOME` / `BRAND_SITE` / `BRAND_EMAIL` / `BRAND_WHATSAPP` | Marca usada nos templates de e-mail e no issuer do TOTP |

### Adquirentes

| Variável | Para que serve |
|---|---|
| `MOCK_PROVIDER_WEBHOOK_KEY` | Header `x-key` esperado no webhook do provedor mock |
| `CONTINGENCIA_TIMEOUT_SEGUNDOS` | Timeout por adquirente na criação da cobrança antes de cair na contingência (default 10) |
| `API_PUBLIC_URL` | URL pública desta API — monta o `postbackUrl` enviado à Valorion |
| `VALORION_API_KEY` | Credencial Valorion (fallback quando a `conta_provedor` não tem); cash-in só usa `x-api-key` |
| `VALORION_WEBHOOK_TOKEN` | Token do `?token=` no postback, conferido com `timingSafeEqual` |
| `VALORION_BASE_URL` / `VALORION_FILA_URL` | Overrides dos hosts Valorion |
| `TESOURARIA_CHAVE_PIX` | Nome da env que guarda a chave PIX do saque automático (ex.: `CHAVE_PIX_BB_VPAY`); tipo/titular no gatilho |

## Estrutura de `src/`

| Diretório | Papel |
|---|---|
| `auth/` | Login/cadastro, `JwtAuthGuard` + RBAC (`@RequerPermissao`), reset de senha, TOTP, administração de usuários |
| `api-credentials/` | API pública: emissão de token Bearer (`POST /v1/auth/token` com `x-api-key`/`x-api-secret`), guard Bearer com revalidação no banco, escopos, allowlist de IP, idempotência, rate limit por credencial |
| `onboarding/` | Cadastro sem JWT (reverifica e-mail+senha via argon2 a cada request) + revisão admin de documentos |
| `pix/` | Cobrança/saque/consulta (API pública `v1/pix` e painel) e chaves PIX |
| `ledger/` | Ledger de saldo (`SELECT FOR UPDATE`), configuração PIX efetiva do cliente, carteiras admin |
| `providers/` | Porta de adquirente (`PaymentProviderPort`), registry, vitrine; um subdiretório por liquidante (`mock/`, `valorion/`) |
| `contingencia/` | Cadeia de fallback de adquirentes na criação da cobrança + registro/monitoramento de falhas |
| `med/` | Casos MED (contestação): recebimento, bloqueio/débito de saldo, decisão |
| `tesouraria/` | Saldo da VPay nas adquirentes + gatilhos de saque automático |
| `ops/` | Dashboards, relatórios, auditoria, gestão de adquirentes/taxas, webhooks do lojista |
| `perfis/` | CRUD de perfis de acesso + catálogo de permissões |
| `queues/` | Registro das filas, `QueuesService` (enqueue + repeatables), auth do Bull Board |
| `worker-processors/` | Processors BullMQ, um arquivo por domínio |
| `email/` | E-mail transacional (serviço + templates) |
| `common/` | Cripto AES-GCM, validação de env, throttle por IP, filtro de exceções Prisma, tracing, storage |
| `shared/` | **Vocabulário-fonte**: filas, `PERMISSOES`, `SITUACAO_*`, `EVENTOS_LOJISTA`, schemas Zod, helpers de dinheiro/documento |
| `prisma/` | `PrismaService` global |

## Mapa de rotas

Tudo sob o prefixo **`/api`**, exceto `GET /health` e `/admin/queues` (Bull Board).

### Autenticação e onboarding (público)

| Rota | Descrição |
|---|---|
| `POST /auth/cadastro` | Cadastro PF/PJ com aceite dos 2 documentos legais (IP/user-agent gravados na mesma transação) |
| `POST /auth/login` | argon2 + lockout deslizante (5 falhas/15 min, sempre temporário); com 2FA ativo devolve `requer2FA` sem token; JWT **só** para conta `ATIVO` — demais estados retornam `proximoPasso` |
| `GET/PATCH /auth/me` | Perfil, papéis e permissões efetivas / atualização de telefone, nome fantasia e tema |
| `POST /auth/senha/esqueci` · `/redefinir` | Reset sem enumeração; token guardado como sha256, uso único, 30 min |
| `POST /auth/totp/iniciar` · `/confirmar` · `/desabilitar` | 2FA TOTP (QR Code; desabilitar exige senha) |
| `POST /onboarding/status` · `/documentos` | Sem JWT; reautentica e-mail+senha a cada request; upload multipart até 10 MB (PDF/JPG/PNG), cota de 30 docs/conta |

### API pública do lojista (token Bearer)

`POST /v1/auth/token` troca `x-api-key` + `x-api-secret` por um `access_token` Bearer (TTL `API_TOKEN_TTL_SEGUNDOS`, padrão 1 h); as rotas de negócio aceitam só o Bearer e revalidam a credencial no banco a cada request (revogação imediata). Idempotência por `referenciaExterna`: repetir a mesma referência com os mesmos dados devolve a mesma transação (sem novo PIX/débito); cobrança com dados diferentes gera cobrança NOVA (nunca 409); saque com dados diferentes → 409. Rate limit por credencial; allowlist de IP quando cadastrada.

| Rota | Escopo | Descrição |
|---|---|---|
| `POST /v1/auth/token` | — | Emite o token de acesso a partir do par de credenciais (único lugar que aceita o par) |
| `POST /v1/pix/cobrancas` | `pix.cobranca.criar` | Cobrança PIX copia-e-cola. Exige `itens` (≥1) com `titulo`/`quantidade`/`valorUnitario`/`tangivel`; item tangível torna `pagador.endereco` obrigatório; o `valor` não precisa bater com a soma dos itens (frete/desconto ficam fora) |
| `POST /v1/pix/saques` | `pix.saque.criar` | Saque PIX — exige o escopo **e** allowlist de IP configurada na credencial |
| `GET /v1/pix/transacoes/:id` | `transacoes.ler` | Detalhe da transação da própria conta |

### Painel do cliente (JWT + permissão)

| Prefixo | Descrição |
|---|---|
| `painel/dashboard` | KPIs e gráficos da conta |
| `painel/transacoes` | Extrato paginado (`direcao`/`situacao`/período/`busca` + totais das concluídas), detalhe, depósito pelo painel (`depositoPainelSchema`, sem itens — não é venda) e saque (só para chave PIX **APROVADA**) |
| `painel/adquirentes` | Vitrine liberada + escolha da adquirente de PIX in |
| `painel/chaves-pix` | CRUD de chaves PIX (entram `PENDENTE`; admin aprova) |
| `painel/credenciais` | Credenciais de API (`vp_<hex>`; segredo exibido **uma única vez**) |
| `painel/webhooks` | Webhooks do lojista + `GET /painel/webhooks/eventos` (lista de `EVENTOS_LOJISTA`) |

### Admin (JWT + permissão)

| Prefixo | Descrição |
|---|---|
| `admin/usuarios` | Aprovação de cadastros, ficha do cliente, situação, perfis, taxas/configuração comercial (taxa, liberação D+, reserva, MED) e o padrão de novos clientes (`/config-padrao`) |
| `admin/documentos` | Download stream e validação de documentos KYC |
| `admin/chaves-pix` | Aprovação/reprovação das chaves PIX dos clientes |
| `admin/med` | Fila MED, registro manual e decisão (aceitar/recusar) |
| `admin/perfis` | CRUD de perfis + catálogo de permissões (`/catalogo`) |
| `admin/carteiras` | Saldos dos lojistas (somente leitura) |
| `admin/adquirentes` · `admin/provedores` | Cadastro de adquirentes, vitrine, liberações por cliente, custos, alternância em massa |
| `admin/contingencia` | Cadeia de contingência, resumo e falhas (com response cru da liquidante) |
| `admin/tesouraria` | Saldos da VPay nas adquirentes, gatilhos de saque automático, execuções |
| `admin/relatorios` · `admin/dashboard` · `admin/auditoria` | Cash-in/out, Lucro × Custo, auditoria de persistência e de acesso |

### Webhooks de adquirentes

Um controller por adquirente (`src/providers/{codigo}/`), throttle 6000/min:

| Rota | Proteção |
|---|---|
| `POST /webhooks/mock/pix-in` · `/pix-out` · `/med` | Allowlist de IP + header `x-key` (hash argon2) |
| `POST /webhooks/valorion/pix-in` · `/pix-out` (`?token=`) | Token via `timingSafeEqual` + allowlist de IP; traduz o vocabulário Valorion (`idtransaction`→`transactionId`, `PAID_OUT`→`PAID`); `status=MED` abre caso MED |

**Segurança de webhook em 2 camadas (inegociável):**

1. **Camada 1** — dentro do processor, **antes** de creditar: reconsulta o status na liquidante; se não confirmar, o job falha.
2. **Camada 2** — na entrada do controller: `verifyTransport` (allowlist de IP, `x-key`, token).

Provedor `INATIVO`/`SUSPENSO` não atualiza transação nem saldo; o match é sempre id externo + provedor; idempotência por `chaveIdempotencia` em `webhooks_recebidos_provedor` (duplicata retorna 200 com `{ duplicated: true }`).

## Filas BullMQ

Nomes em `src/shared/queues.ts`; jobs com `attempts: 5` e backoff exponencial. Filas genéricas — o `provider` vai no payload do job.

| Fila | Repeat | O que faz |
|---|---|---|
| `1-pix-webhook-received` | — | Cash-in confirmado: Camada 1, credita o ledger (tarifa/reserva), agenda liberação, emite evento de outbox |
| `2-pix-webhook-send` | — | Entrega o callback ao lojista (destinos deduplicados, header de autenticação, histórico em `entregas_webhook`) |
| `3-pix-webhook-received-cashout` | — | Webhook de saque: reconfere na liquidante e conclui a transação |
| `4-pix-cash-out` | — | Executa o saque na liquidante com as credenciais descriptografadas da conta |
| `5-outbox-publisher` | 5 s | Lê `eventos_outbox`, faz **claim atômico** e enfileira na fila 2 — o callback ao lojista sai **só** por aqui (enfileirar direto na 2 duplica a entrega) |
| `6-liberacao-saldo` | 60 s | Move liberações vencidas para `DISPONIVEL` |
| `7-conciliacao` | 300 s | Reconsulta na liquidante transações paradas há mais de 5 min |
| `8-emails` | — | E-mail transacional (retentável; SMTP fora do ar não derruba a request) |
| `9-devolucao-pix` | — | Efetiva na liquidante a devolução PIX de um MED aceito (idempotente) |
| `10-saque-automatico` | 60 s | Tesouraria: atualiza saldos, reconcilia enviadas, avalia gatilhos e dispara saques |

### Callback ao lojista

Dois destinos possíveis: os webhooks cadastrados no painel (filtrados por `tiposEvento`, com header de autenticação cifrado) e o `urlCallback` informado na criação da operação (**sem** header — para não vazar a credencial para uma URL passada solta). URLs iguais (normalizando barra final e host) entregam **uma vez só**, com prioridade para o cadastro do painel. Eventos: `pix.cashin.pago`, `pix.cashout.concluido`, `pix.cashout.falhou`, `pix.devolucao.concluida`. Reenvio manual: `POST /admin/webhooks/:entregaId/reenviar`.

## Modelo de dados (Prisma)

`prisma/schema.prisma` (~50 models; tabelas em português via `@@map`). Conceito central: **1 usuário = 1 conta** — não existe entidade `Empresa`; saldo, transações, MED, webhooks, credenciais e chaves PIX penduram em `usuarios`. Para PJ, `cpfCnpj`/`nomeRazaoSocial` são da pessoa jurídica e `cpfResponsavel`/`nomeResponsavel` do responsável.

Grupos principais:

- **Conta e acesso** — `Usuario`, `AceiteDocumentoLegal`, `DocumentoUsuario`, `HistoricoSituacaoUsuario`, `Papel`/`Permissao` (+ vínculos), `TokenRedefinicaoSenha`, `AuditoriaAcesso` (base do lockout).
- **API pública** — `CredencialApi`, `IpPermitidoApi`, `RegistroAcessoApi`, `ChaveIdempotencia`.
- **Adquirentes** — `ProvedorPagamento` (vitrine), `ContaProvedor` (credenciais cifradas), `CustoPixContaProvedor`, `LiberacaoAdquirenteUsuario`, `IpPermitidoWebhookProvedor`, `ContingenciaAdquirente`, `FalhaAdquirente`.
- **Transações** — `Transacao`, `TransacaoPix`, `ItemCobranca`, `TentativaTransacao` (chave de casamento dos webhooks), `HistoricoSituacaoTransacao`, `DevolucaoPix`.
- **Ledger** — `SaldoUsuario` (4 baldes: `DISPONIVEL`, `PENDENTE_LIBERACAO`, `RESERVADO`, `BLOQUEADO_MED`), `MovimentacaoSaldo` (idempotente, grava `saldoApos`), `LiberacaoSaldo`, `BloqueioSaldo`, `ConfiguracaoPixUsuario` / `ConfiguracaoPadraoPixUsuario`.
- **MED** — `CasoMed`, `HistoricoCasoMed`.
- **Webhooks** — `ConfiguracaoWebhookUsuario`, `WebhookRecebidoProvedor`, `EventoOutbox`, `EntregaWebhook`.
- **Tesouraria** — `SaldoAdquirente`, `GatilhoSaqueAdquirente`, `ExecucaoGatilhoSaque` (saque do saldo do gateway **não** é `Transacao`).
- **Segurança** — `RegistroAuditoria`, `PoliticaLimiteRequisicoes`, `BloqueioAcesso`, `EventoSeguranca`.

**Regra do projeto:** nunca escrever string literal de situação ou permissão em controller/service/processor — usar as constantes de `src/shared/situacoes.ts` e `src/shared/permissoes.ts`.

## RBAC

- Catálogo único em `src/shared/permissoes.ts` (espelhado no web em `src/lib/permissoes.ts`). Permissão = `<recurso>.<ação>`, com ação ∈ `ver|criar|editar|excluir|aprovar|decidir|executar`.
- Toda rota autenticada declara `@RequerPermissao(PERMISSOES.X)`; a checagem roda **dentro** do `JwtAuthGuard` (impossível esquecer de registrar um guard separado). Sem a permissão → 403. Rota sem decorator fica aberta a qualquer autenticado — só para conta própria (`/auth/me`, `/auth/totp`).
- Permissões resolvidas **no banco a cada request**, nunca dentro do JWT: inativar usuário ou perfil corta o acesso na requisição seguinte.
- `escopo.global` decide escopo de dados (todas as contas × só a própria) — usar `temEscopoGlobal(req.user)`.
- Anti-lockout: `ADMINISTRADOR` recebe o catálogo inteiro por código e não aceita edição de permissões; perfis de sistema (`ADMINISTRADOR`, `CLIENTE`) não podem ser renomeados/inativados/excluídos; ninguém remove o próprio ADMINISTRADOR; perfil com usuário vinculado não é excluído.

## Ledger

`src/ledger/ledger.service.ts`: `$transaction` + `$queryRaw` com `SELECT ... FOR UPDATE` em `saldos_usuarios`; movimentações, liberações e evento de outbox no **mesmo commit**. Dinheiro sempre com `Decimal` (decimal.js). Cada movimentação tem `chaveIdempotencia` única — webhook repetido não credita duas vezes. Teste de concorrência em `src/ledger/ledger.concurrency.spec.ts`.

## MED (contestações)

Modos por cliente (`ModoTratamentoMed`): `BLOQUEAR_SALDO` (move disponível→bloqueado só o que existe; o resto vira `valorNaoCoberto`) e `DEBITAR_IMEDIATAMENTE`. MED sempre desconta saldo. **A decisão é que liquida o dinheiro** (`MedService.decidir`): `ACEITO` tira do bloqueado + debita o restante + cria `DevolucaoPix` (a fila 9 faz a transferência externa); `RECUSADO` devolve o bloqueado ao disponível. Caso finalizado não aceita nova decisão. Entradas: webhook mock, postback Valorion com `status=MED`, ou registro manual do admin.

## Contingência de adquirentes

Se a adquirente principal do lojista falhar ao criar a cobrança, a cadeia de contingência (`contingencia_adquirente`) tenta as próximas em ordem, na **mesma** requisição — o objetivo é não perder a venda. Timeout por tentativa: `CONTINGENCIA_TIMEOUT_SEGUNDOS`. Cada falha vira linha em `falhas_adquirente` com o response cru (`TIMEOUT` | `ERRO_PROVEDOR` | `SEM_CODIGO_PIX`); `resolvidaPorContaProvedorId` nulo = venda perdida.

## Tesouraria / saque automático

`saldos_adquirentes` guarda o snapshot do saldo da **VPay** em cada adquirente (fonte de verdade é a adquirente). `gatilhos_saque_adquirente` define limiar de disparo, float mínimo, piso/teto do payout e intervalo mínimo. Tick de 60 s (fila 10): atualiza saldos → reconcilia pendentes → avalia gatilhos → executa. Nada disso toca o ledger do lojista — é dinheiro do gateway, registrado em `ExecucaoGatilhoSaque`.

## Rate limiting

1. **Por IP + rota** (`IpThrottleGuard`, global): 300 req/min default; `@Throttle` ajusta por rota (login 20, cadastro 10, esqueci-senha 5, onboarding 30, webhooks de adquirente 6000).
2. **Por credencial de API** (`RateLimitService`): política em `politicas_limite_requisicoes`, default 60 req/min; excesso gera `EventoSeguranca` + HTTP 429.

Implementação em Redis com script Lua (`INCR`+`EXPIRE` atômicos); **falha aberta** de propósito se o Redis cair.

## Uploads / KYC

Driver local (`src/common/storage.util.ts`): arquivos em `{UPLOADS_DIR}/usuarios/{id}/{uuid}-{nome-sanitizado}`; metadados + hash sha256 em `documentos_usuarios`. Limite 10 MB; MIME PDF/JPEG/PNG. Tipos em `TIPOS_DOCUMENTO`: 3 pessoais obrigatórios para PF, +3 societários para PJ; `CONTRATO_PRESTACAO_SERVICO` só a VPay envia. Em produção o boot recusa storage local (`STORAGE_DRIVER`) — driver de bucket (S3) ainda não implementado.

## Seed

`prisma/seed.ts` cria: perfis (`CLIENTE`, `FUNCIONARIO`, `ADMINISTRADOR`, `FINANCEIRO`, `ANALISTA_MED`) com seus conjuntos de permissões; espelho do catálogo de permissões (removendo obsoletas); provedor `mock` (ATIVO em dev, INATIVO em produção) com conta e custos; provedor `valorion` (nasce INATIVO; credenciais vazias caem no fallback dos envs `VALORION_*`); configuração padrão de taxas ("Padrao Sistema"); usuário admin; políticas de rate limit. Em `NODE_ENV=production` exige `ADMIN_PASSWORD` e não cria recursos de desenvolvimento.

## Observabilidade e segurança transversal

- `TracingInterceptor`: propaga `x-request-id`/`x-trace-id` via `AsyncLocalStorage`, inclusive para dentro dos payloads de job.
- `PrismaExceptionFilter`: P2002→409, P2025→404, P2003→400.
- Helmet com CSP explícita; CORS restrito a `WEB_URL` com credentials.
- Logs pino com redaction de `authorization`, `x-api-key`, `x-api-secret`, `x-key`, cookies.
- Auditoria administrativa em `registros_auditoria` (antes/depois) e de acesso em `auditorias_acesso`.

## Deploy

API e Worker como serviços separados (ex.: Render — a `PORT` injetada tem precedência sobre `API_PORT`); painel web na Vercel; Postgres e Redis privados. `enableShutdownHooks()` nos dois processos para o SIGTERM de deploy não matar jobs de crédito/saque no meio. Checklist de produção em `../PRONTIDAO-PRODUCAO.md`.
