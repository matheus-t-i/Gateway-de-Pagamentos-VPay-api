# Gateway VPay — Claude Code

Dois repositórios: `Gateway-de-Pagamentos-VPay-api` (Nest API + Worker + Prisma) e `Gateway-de-Pagamentos-VPay-web` (Next.js).

## Webhook security (inegociável)

1. **Camada 1:** antes de creditar/terminal, consultar status na liquidante; se não confirmar → throw (job failed).
2. **Camada 2:** IP allowlist e/ou `x-key` do provedor.
3. Provedor inativo/suspenso → não atualiza tx nem saldo.
4. Match id externo + conta/provedor com a tx local; mismatch → rejeitar.
5. Um controller HTTP por adquirente em `src/providers/{codigo}/`.
6. Filas genéricas apenas; `provider` vai no job payload.

## Novas integrações de adquirente (padrão de segurança)

Contrato mínimo de toda integração nova: **consultar a liquidante antes de mover
dinheiro**, proteger o webhook o máximo que o provedor permitir, **nunca
pagar/creditar em duplicidade**, e tratar resposta ambígua com cautela —
especialmente no saque. Implementar `PaymentProviderPort` completo
(`src/providers/payment-provider.port.ts`) seguindo `valorion/` como referência.

### Webhooks — nunca confiar só no aviso
Toda liquidação (pago, estorno, saque, devolução) passa pelas **duas camadas**
acima. Preferência de Camada 2, na ordem do que a adquirente oferecer:
IP + consulta → HMAC/token + consulta → só consulta (mínimo aceitável).
Responder **200 mesmo ao descartar** a entrega (idempotência/evento ignorado) —
4xx/5xx gera tempestade de retries da liquidante. 401/400 só para transporte
inválido (IP fora da allowlist, token errado, payload sem id).

### Credenciais e comunicação
Credenciais só em env / `credenciaisCriptografadas` por conta de provedor —
nunca no código, sempre mascaradas em log. Outbound com a autenticação oficial
deles (OAuth, Basic, API key), TLS verificado e timeout explícito.

### Idempotência e anti-duplicidade
- Dedupe de webhooks (`chaveIdempotencia`) e de jobs — o mesmo evento nunca
  processa duas vezes. Se o provedor repete o mesmo id de evento com status
  diferente (ex.: pago → MED), o status entra na chave.
- Saque: usar chave de idempotência quando a API oferecer; se a adquirente
  **não** tem, resposta ambígua (timeout/5xx) **congela** o fluxo — nada de
  retry automático que possa pagar duas vezes; vai para reconciliação manual.
- Crédito de saldo é recalculado de forma idempotente (chaves `cashin:*` no
  ledger) — webhook repetido não "soma de novo".

### Controles de conta e saque
Usuário aprovado e habilitado. No cash-out: validar documento, tipo de chave,
ownership da chave, allowlist de IP da credencial e **revalidar elegibilidade no
retry**. Tentativa abusiva pode desligar o saque da conta. Lock e rate limit por
usuário.

### Proteção financeira na máquina de estados
- Não reprocessar crédito em venda já terminal ou retida.
- Não rebaixar saque concluído por webhook de falha tardio.
- Devolução de saque só com confirmação na API da liquidante.
- Falha pós-crédito (saldo/callback) não pode fazer o retry "pular" o crédito.

### Contingência e disponibilidade
Timeout na criação do PIX (`CONTINGENCIA_TIMEOUT_SEGUNDOS`); adquirente falhou →
cadeia de contingência na MESMA transação. Muitas falhas em pouco tempo podem
trocar o gateway padrão dos usuários automaticamente.

### Saldo na liquidante
A cada transação **paga** recebida, consultar o saldo da nossa conta na
liquidante (`getBalance`) — mantém `saldos_adquirentes` fiel e alimenta a
tesouraria e os gatilhos de saque automático. `getBalance` é obrigatório no
port; sem endpoint de saldo na adquirente, derivar do movimento (ver mock).

### Operação no painel
Ativar/desativar adquirente, contingência e saque automático exigem permissão
(`PERMISSOES.*`) e, em mutações críticas, 2FA. Toda ação auditada em
`registros_auditoria` com antes/depois.

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

## Conta

1 usuário = 1 conta. Não existe `Empresa`: tudo pendura em `usuarios` (`saldos_usuarios`,
`chaves_pix_usuarios`, `configuracoes_webhook_usuario`, `transacoes.usuario_id`, …). Rotas de painel
não recebem id de conta — o alvo é o titular do JWT.

## Adquirente de PIX in

Vitrine em `ProvedorPagamento` (`nomeFantasia`, `temMed`, `observacaoCliente`,
`disponibilidadePixEntrada`) + `liberacoes_adquirente_usuario`. O cliente escolhe a sua em
`PUT /painel/adquirentes/pix-entrada`; `PixService.criarCobranca` reconfere a liberação.
Tirar uma adquirente de circulação exige `substituicoes` para todos os clientes afetados
(`AdquirentesService.aplicarSubstituicoes`, na mesma transação).

## Ledger

Prisma CRUD normal; ledger com `$queryRaw`/`$executeRaw`/`$transaction` + `SELECT FOR UPDATE` em
`saldos_usuarios`. Dinheiro com Decimal/decimal.js — nunca float.

## Deploy

API + Worker separados (Render); web na Vercel; Postgres + Redis privados.
