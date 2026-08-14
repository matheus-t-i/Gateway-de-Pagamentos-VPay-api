# Runbook de go-live — Gateway VPay (PIX)

Checklist operacional do dia do deploy e procedimentos para saque `ENVIANDO`
ambíguo e cobrança fantasma de cash-in. Complementa o fail-fast de código
(boot recusa envs fracos / mock / allowlist vazia).

---

## 0. Empacotamento

- **API + Worker (Render):** blueprint `render.yaml` na raiz — dois serviços da
  MESMA imagem (`Dockerfile`), Postgres e Key Value (Redis) **sem IP público**
  (`ipAllowList: []`). O `preDeployCommand` roda `prisma migrate deploy` com a
  CLI pinada da imagem ANTES de promover a versão — migração falhou, deploy não
  sobe. Health check em `/health/ready`. Segredos entram com `sync: false`
  (o Render pede no primeiro deploy; nada versionado).
- **Painel (Vercel):** projeto `Gateway-de-Pagamentos-VPay-web`, sem config
  extra — mas `NEXT_PUBLIC_API_URL` é OBRIGATÓRIA no ambiente de build: sem
  ela o `next build` agora **falha de propósito** (antes publicava um painel
  chamando localhost e o erro só aparecia no browser do cliente).
- **Banco — dois usuários (least privilege):** o runtime (API/Worker) conecta
  com um usuário de APLICAÇÃO, membro do role `vpay_aplicacao` (só DML — a
  migration `20260814100000_role_aplicacao` cria o role e os grants); o OWNER
  fica exclusivo do `migrate deploy` (`DIRECT_DATABASE_URL`, que o blueprint já
  aponta para a connection string do Render). Passo a passo no primeiro deploy:
  1. Deploy inicial com `DATABASE_URL` = connection string do owner (a migração
     ainda não rodou, o role não existe).
  2. Depois da migração, no psql do banco (dashboard do Render → Connect):
     `CREATE USER vpay_app LOGIN PASSWORD '<segredo forte>' IN ROLE vpay_aplicacao;`
  3. Trocar `DATABASE_URL` da vpay-api e do vpay-worker para a mesma connection
     string substituindo `user:senha` por `vpay_app:<segredo>` e redeploy.
  4. Conferir no boot: `/health/ready` verde e nenhuma query com erro de
     permissão nos logs. Rollback = voltar `DATABASE_URL` para o owner.
- Smoke local da imagem: `docker build -t vpay-api .` na raiz da API.

---

## 1. Checklist antes de subir produção

1. Backup Postgres recente e janela de restore testada.
2. `STORAGE_DRIVER=s3` + `S3_BUCKET` + `S3_REGION` (ou `AWS_REGION`) + credenciais AWS.
3. Segredos reais (não de exemplo): `JWT_SECRET`, `ENCRYPTION_KEY`, `API_SECRET_PEPPER`.
4. `VALORION_WEBHOOK_TOKEN` forte; `TRUST_PROXY=1`; `WEB_URL` e `API_PUBLIC_URL` HTTPS.
5. Allowlist IP Valorion cadastrada em `ips_permitidos_webhook_provedor` **antes** do boot
   (produção não sobe com lista vazia).
5b. `DATABASE_URL` do runtime aponta para o usuário de APLICAÇÃO (`vpay_app`,
   membro de `vpay_aplicacao`) e `DIRECT_DATABASE_URL` para o owner (§0) —
   runtime rodando como owner anula o least privilege e bypassaria uma RLS futura.
6. Release: `prisma migrate deploy` (ou `npm run release` / `scripts/release.sh`).
7. Probes: `GET /health` (liveness) e `GET /health/ready` (Postgres + Redis).
8. Worker saudável; pager/alerta em logs `ALERTA_FILA` (filas vermelhas / depth).
9. Adquirente mock `INATIVA`; adquirente real `ATIVA` com conta e custos.
10. Toda conta `ADMINISTRADOR` com 2FA ativo (step-up exige TOTP em mutações).
11. Staging: postback cash-in pago, MED, saque ok e timeout simulado de saque.

---

## 2. Saque ambíguo (`ENVIANDO` sem confirmação)

**Sintoma:** tentativa em `ENVIANDO`, transação `PROCESSANDO`, job com
`UnrecoverableError` / mensagem `AMBÍGUO` (timeout, 5xx ou rede após o POST).

**Nunca:**
- Apagar a tentativa `ENVIANDO` e reenfileirar o job sem consultar a liquidante.
- Isso pode **pagar duas vezes**.

**Procedimento:**
1. Anotar `idTransacaoPublico`, `idTransacaoPrivado` (`externaRef` enviada à Valorion)
   e `idTransacaoLiquidante` se existir.
2. Na Valorion, buscar a ordem por `externaRef` / id privado **ou** id liquidante.
3. Se a liquidante **pagou** (`PAID`/`COMPLETED`):
   - Aguardar webhook/conciliação fechar `CONCLUIDA`, ou
   - Confirmar no painel admin que a conciliação já liquidou; não reenviar.
4. Se a liquidante **não tem** a ordem / recusou:
   - Só então avaliar estorno manual / correção com dupla checagem (duas pessoas).
5. Se a liquidante **não responde**: manter congelado; dinheiro fica debitado no
   lojista até haver certeza — é o desenho anti double-pay.

Log OPS da conciliação: `OPS conciliação: saque … ENVIANDO sem idTransacaoLiquidante`.

---

## 3. Cash-in fantasma (TIMEOUT / abort pós-aceite)

**Sintoma:** venda local em `FALHA` (ou sem QR), tentativa sem
`idTransacaoLiquidante`, mensagem `TIMEOUT:…`. Na liquidante pode existir
cobrança com `externaRef` = `idTransacaoPrivado` (ou `referenciaExterna`).

**Automático:**
- Webhook pago com `externaRef` casa a tx e credita (mesmo se estava `FALHA`).
- Conciliação: se houver id liquidante numa tentativa e status pago + valor ok,
  credita; se TIMEOUT sem id, só alerta OPS.

**Manual:**
1. Buscar na Valorion por `externaRef` / id privado da tx.
2. Se paga e o lojista não foi creditado: abrir suporte interno — preferir
   reprocessar o webhook (ou aguardar conciliação se o id já estiver gravado).
3. Se paga e o cliente final já usou outro QR: devolver na liquidante e
   documentar; não creditar duas vendas.

Log OPS: `OPS conciliação: cash-in fantasma suspeito tx=…`.

---

## 4. Pós-deploy (smoke)

1. Cobrança pequena cash-in → pagar → saldo/crédito + callback lojista.
2. Saque painel com 2FA → `CONCLUIDA` ou caminho feliz síncrono.
3. Postback com IP fora da allowlist → 401 (não processa).
4. Conta admin sem 2FA → mutação abre CTA “Ativar 2FA”.
5. Bull Board `/admin/queues` sem filas em falha acumulada.
