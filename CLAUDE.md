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
- `6-liberacao-saldo` (varre AGENDADA vencida + reprocessa FALHA/PROCESSANDO órfã,
  com claim atômico, espera de 10 min e teto de 8 tentativas — antes, FALHA era
  terminal e congelava o dinheiro do lojista para sempre)
- `7-conciliacao`
- `8-emails`
- `9-devolucao-pix`
- `10-saque-automatico`
- `11-webhook-reenvio` (reenvio MANUAL do callback, pelo botão do painel/admin)
- `12-integracao-envio` (envio da venda aos APPS que o lojista conectou)

Constantes em `src/shared/queues.ts`. Bull Board `/admin/queues` com ADMINISTRADOR.

## Integrações (apps conectados pelo lojista)

`/desenvolvedores/integracoes` + `src/integracoes/`. Vocabulário em
`src/shared/integracoes.ts` (espelhado no web). App novo = um client novo em
`src/integracoes/<app>/` + uma entrada no `CATALOGO_INTEGRACOES` e no enum
`TipoIntegracao`; o resto (reserva de envio, fila, histórico, tela) é comum.

- **Nunca derruba o dinheiro.** Ganchos chamam `notificarSemFalhar`;
  `enqueueIntegracaoEnvio` também engole erro. No `OutboxPublisherProcessor` a
  notificação fica FORA do try que devolve o claim — devolver claim por causa de
  app de terceiro duplica o callback ao lojista.
- **Não mexer em `EVENTOS_LOJISTA` para isso.** Evento novo lá vaza para todo
  webhook com `tiposEvento: []` e para todo `urlCallback`. Integração tem
  vocabulário próprio (`EVENTOS_INTEGRACAO`).
- **Dedupe** pela unique `(integracao, transacao, status_remoto)` de
  `envios_integracao`: a linha nasce PENDENTE antes do POST. Já em SUCESSO → não
  reenvia; PENDENTE/FALHA → reenvia (a tentativa anterior não terminou).
- **4xx do app = definitivo** (payload, token, janela de 7/45 dias da Utmify):
  grava FALHA e não retenta. 5xx/timeout relança para o BullMQ.
- **Utmify:** `orderId` = `idTransacaoPublico` e `createdAt` = `criadoEm` em UTC,
  os dois IMUTÁVEIS entre `waiting_payment` → `paid` → `refunded`. Centavos
  inteiros (decimal.js). Só cash-in COM itens — depósito de painel não é venda.
  Sem `pagador.nome`/`pagador.email` a Utmify recusa: registramos a falha com o
  motivo em vez de inventar dado de comprador.

## Contrato do callback ao lojista (PÚBLICO — não quebrar)

> **Estágio: PRÉ-PRODUÇÃO.** Sem lojista integrado ainda, então mudar o contrato
> é decisão de produto normal — sem plano de migração nem convivência de
> versões. No go-live, apague este aviso e as regras abaixo passam a valer na
> forma estrita. Renomear continua sendo decisão do dono do produto: a IA nunca
> muda contrato por conta própria, em nenhum estágio.

**Fonte única:** `src/shared/callback-lojista.ts`, espelhada em
`Gateway-de-Pagamentos-VPay-web/src/lib/callback-lojista.ts`. O corpo é montado em
`EntregaWebhookService.montarCorpo` e entregue pelas filas `2-pix-webhook-send`
(automático) e `11-webhook-reenvio` (manual) — as duas pelo MESMO código.

- O `status` do callback é a **situação do sistema** (`SITUACAO_TRANSACAO`), o mesmo
  valor que aparece no painel. Não existe vocabulário traduzido/paralelo — nunca
  inventar `PAID_OUT`/`COMPLETED` e afins.
- Nunca escrever a situação literal nem `'cash_in'`: usar `statusCallback(situacao,
  direcao)`, `operacaoCallback(direcao)`, `STATUS_CASH_IN`, `STATUS_CASH_OUT`.
- **Cash-in** ∈ `AGUARDANDO_PAGAMENTO | CONCLUIDA | FALHA | MED`. Não tem
  `PENDENTE`, não tem `PROCESSANDO`, não tem `CANCELADA`.
- **Cash-out** ∈ `PROCESSANDO | CONCLUIDA | FALHA | CANCELADA`.
- `LIQUIDADA` e `PENDENTE` são internos e nunca saem no callback (os mapas os
  convertem). Situação nova no enum exige entrada nos DOIS mapas.
- Nomes dos campos (`valor_bruto`, `referencia_externa`, `deposito_liquido`,
  `valor_liquidado`, `data_med`, …) também são contrato: acrescentar pode, renomear não.
- `urlcallback` é o destino DAQUELA entrega → corpo montado **por destino**.
- Mexeu no contrato: atualize o espelho do web e `STATUS_CALLBACK_DOC` na mesma
  alteração — `/desenvolvedores/documentacao` é gerada dessa lista.

## Máquina de estados das transações

**Cash-in:** a cobrança **nasce `AGUARDANDO_PAGAMENTO`** (não passa por
`PENDENTE`/`PROCESSANDO`). Liquidante falhou → a contingência gera em outra e o status
**continua** `AGUARDANDO_PAGAMENTO`, mudando só os dados da cobrança (txid, copia-e-cola).
Esgotaram as tentativas → `FALHA`. Pago → `CONCLUIDA`. MED aceito → `MED`.
Cash-in **nunca** é `CANCELADA`.

**Cash-out:** nasce `PROCESSANDO` — e `PROCESSANDO` significa que **o saldo já foi
debitado** (o débito acontece em `criarSaque`, antes de enfileirar). Confirmado na
liquidante → `CONCLUIDA`.

### Saque: beneficiário obrigatório

`nomeBeneficiario` e `documentoBeneficiario` são **obrigatórios** em
`criarSaquePixSchema` — a liquidante exige os dois e confere o documento contra o dono
da chave no DICT. Enquanto eram opcionais, o saque saía com string vazia e só quebrava
na adquirente, **com o saldo do lojista já debitado**.

O documento tem que ser o do **titular da chave**. Quando `tipoChavePix` é `CPF`/`CNPJ`
a chave É o documento, então o schema recusa divergência na hora (400, antes do débito).
No painel, nome e documento vêm da `chaves_pix_usuarios` aprovada — chave sem
`nomeTitular`/`documentoTitular` é recusada no `saquePainel` pelo mesmo motivo.

### Saque: o débito precisa estar AMARRADO à transação

`criarSaque` debita ANTES de a transação existir (é o que `PROCESSANDO` significa), então as
movimentações nascem sem `transacao_id` — e o `PixCashOutProcessor` revalida o débito somando
`movimentacoes_saldo` **por `transacao_id`**. Por isso a transação e o `updateMany` que amarra as
duas movimentações a ela vão no MESMO `$transaction`. Sem esse vínculo a soma dá zero e TODO saque
morre na revalidação, com o saldo do lojista já debitado. Regressão coberta por
`src/pix/saque-debito.spec.ts`.

### Saque nunca usa saldo negativo

`criarSaque` debita com `permiteSaldoNegativo: false` **fixo**, mesmo em conta marcada como
"permite saldo negativo" (o que hoje acontece sempre que o MED é `DEBITAR_IMEDIATAMENTE`). Esse
débito é a **única** checagem de saldo do saque — não existe validação de saldo suficiente antes
dele. Saldo negativo é para dívida que a adquirente já criou (MED); saque a descoberto seria a VPay
pagando dinheiro que o lojista não tem, sem garantia de reaver.

### Saque: um por vez e revalidação total (inegociável)

`4-pix-cash-out` roda com `concurrency: 1` — dois jobs do mesmo lojista em paralelo
poderiam passar juntos pelas checagens e pagar duas vezes.

`PixCashOutProcessor` **não confia em nada validado na criação**: o job pode ser
reprocessado à mão (Bull Board/Redis) horas depois. Antes de mover dinheiro, revalida,
nesta ordem:

1. **Tentativa de SUCESSO já existente → não reenvia.** É a trava contra pagamento
   duplo: se saiu ordem para a liquidante, reprocessar é no-op (`ignorado: true`).
2. Situação ainda enviável (`PENDENTE`/`PROCESSANDO`); terminal → no-op.
3. Conta `ATIVO` e não bloqueada.
4. Provedor/conta `ATIVO`.
5. Débito correspondente existe em `movimentacoes_saldo` (valor + tarifa).
6. Ticket mínimo/máximo vigentes.
7. Origem **API**: credencial ativa, não revogada/expirada, com escopo
   `pix.saque.criar` e `permitirPixSaidaViaApi`. Origem **painel**: chave PIX
   cadastrada na conta **e** `APROVADA` agora (a aprovação pode ter sido revogada).

Regra violada → `throw` (job falha e fica visível para análise). **Nunca** devolver
saldo nem "consertar" sozinho: mexer em dinheiro automaticamente é decisão humana.

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

### Trava de saldo negativo: por movimentação, não por estado

`aplicarMovimentacoes` recusa **só** o que piora o buraco: `tipoSaldo: 'DISPONIVEL'` +
`tipoMovimento: 'DEBITO'` que deixe o saldo negativo, com `permiteSaldoNegativo` falso. Crédito no
disponível e débito de outro bucket NUNCA são recusados por dívida preexistente — a conta negativa
precisa continuar recebendo para se quitar sozinha.

Quem cria conta negativa hoje: MED com `DEBITAR_IMEDIATAMENTE` (`permiteSaldoNegativo: true` fixo no
call site) e o MED automático. Quem nunca pode ficar negativo: **saque** (`criarSaque` passa `false`
fixo). Regressão coberta por `src/ledger/saldo-negativo.spec.ts` — os 5 casos falham se a trava
voltar a olhar o estado da conta.

## Deploy

API + Worker separados (Render); web na Vercel; Postgres + Redis privados.
