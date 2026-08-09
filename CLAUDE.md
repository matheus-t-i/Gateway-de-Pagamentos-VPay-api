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
  `enqueueIntegracaoEnvio` também engole erro. No `OutboxPublisherProcessor` só o
  `enfileirarEnvios` fica FORA do try que devolve o claim — devolver claim por
  causa de app de terceiro duplica o callback ao lojista.
- **Reserva do envio é atômica com o claim** (`reservarEnviosDoEvento`, dentro do
  `$transaction` do publisher). O claim é irreversível: com a reserva depois
  dele, worker morto no meio = venda que nunca chega ao app e evento que nunca
  mais é reprocessado. Foi encontrado em teste, não é hipótese.
  `reenfileirarPendentes` varre PENDENTE preso (falha de `enqueue`) no tick.
- **Capacidade é do APP, não do modelo.** `AppIntegracao.credencial` (`null` =
  sem credencial), `suportaTeste`, `eventosPadrao`. Nada de `if (tipo ===
  'UTMIFY')` fora do `switch` do dispatcher.
- **Xtracky:** sem autenticação; `utm_source` é o LeadId DELES e vai CRU
  (nunca normalizar/truncar), com `sck` de fallback; `amount` inteiro em
  centavos; **não existe campo de data**; sucesso é **202** (a doc oficial deles
  ensina `=== 200` e está errada); a API aceita quase tudo com 202, então
  `XtrackyClient.validar` é a única validação real. `duplicate: true` em 2xx =
  descartado → SUCESSO com aviso, nunca falha. Dedupe deles é por
  `orderId + LeadId` sem status, por isso nasce assinando só `pedido.pago`.
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

## Autenticação da API pública

**Token Bearer de curta duração** (decisão do dono do produto, ago/2026 — modelo
OAuth2 client_credentials na semântica, como o PIX do Bacen/Efí/BB):

1. `POST /v1/auth/token` com `x-api-key` + `x-api-secret` → `{ access_token,
   token_type: 'Bearer', expires_in, escopos }` (`API_TOKEN_TTL_SEGUNDOS`,
   padrão 3600). O par chave/segredo entra SOMENTE aqui.
2. Rotas de negócio (`/v1/pix/*`) exigem `Authorization: Bearer` —
   `ApiTokenGuard` (`src/api-credentials/api-token.guard.ts`).

**A revogação NÃO depende da expiração do token.** O `ApiTokenGuard` relê a
credencial no banco a cada requisição (`CredencialAuthService.
carregarCredencialAtiva`): revogar credencial, bloquear conta ou mudar a IP
allowlist corta o acesso na chamada seguinte, mesmo com token na validade — a
mesma razão pela qual o RBAC resolve permissão no banco e não dentro do JWT.
Escopos também são lidos do banco, nunca do token.

⚠️ **Os dois tokens usam o MESMO `JWT_SECRET`.** O que separa API de painel é o
claim `tipo: 'credencial_api'` (`TIPO_TOKEN_API`): o `ApiTokenGuard` exige o
claim e o `JwtAuthGuard` recusa quem o tem — sem isso, um token de API (`sub` =
id de CREDENCIAL) viraria sessão do usuário de mesmo id numérico. Coberto por
`src/api-credentials/token-api.spec.ts`.

**O segredo é verificado com HMAC-SHA256 + pepper, NUNCA com argon2**
(`src/api-credentials/segredo-hash.ts`). O segredo é `randomBytes(32)` gerado por
nós — 256 bits, sem dicionário possível —, então KDF lento não protege nada e
custava ~87 ms de CPU e 64 MB por requisição, travando o processo em ~73 req/s e
dando um vetor de DoS grátis (a chave pública não é secreta, então qualquer um
forçava a conta).

⚠️ **Se um dia o lojista puder trazer o próprio segredo, o argon2 tem que voltar**
— aí a entropia é baixa e o fator de trabalho passa a valer.

Regras da emissão do token (`CredencialAuthService.autenticarPorChaveSegredo`),
todas com motivo:
- `timingSafeEqual` na comparação, nunca `===` (o argon2 dava isso de graça).
- `API_SECRET_PEPPER` no env dos DOIS serviços. Perdê-lo invalida todas as
  credenciais, sem recuperação. O código falha alto se estiver ausente.
- Hash `$argon2…` legado ainda é aceito e **migra sozinho** no primeiro uso
  válido (fire-and-forget, fora do caminho da resposta).
- Teto de tentativas por chave pública ANTES de verificar o segredo — o limite de
  60/min roda dentro do handler e requisição inválida nunca chega lá.
- Credencial inexistente, inativa, revogada, expirada ou com segredo errado
  respondem TODAS `401 Credencial inválida`. Estado da conta (403) só depois de o
  segredo conferir: antes, a mensagem confirmava a existência da chave e vazava a
  situação do lojista. Medido: era 3 ms × 41 ms; hoje os dois caminhos custam o
  mesmo.
- No guard Bearer a regra é a OPOSTA: quem chegou com token assinado por nós já
  provou posse do segredo, então a mensagem PODE ser específica ("credencial
  revogada", "token expirado — gere um novo") sem vazar nada.

**Rotação sem downtime** (`POST /painel/credenciais/:id/rotacionar`): gera o
segredo novo e guarda o anterior em `segredoHashAnterior` +
`segredoAnteriorExpiraEm` (7 dias por padrão, `0` para incidente). Os dois valem
durante a janela, a chave PÚBLICA não muda, e
`DELETE /painel/credenciais/:id/segredo-anterior` encerra na hora. É isto que dá
vida útil finita a um segredo vazado — a expiração do access token limita só o
TOKEN, não o segredo que o emite. Para cortar tudo de uma vez, revogar a
credencial: o guard Bearer derruba os tokens dela na requisição seguinte.

⚠️ **Autenticar pelo segredo ANTERIOR nunca pode disparar a migração lazy.** Se o
hash anterior for argon2 legado, `verificarSegredo` devolve `precisaMigrar: true`
e a emissão reescreveria `segredoHash` (o ATUAL) com o hash do segredo ANTIGO —
desfazendo a rotação sozinho e derrubando o segredo que o lojista acabou de
instalar. Por isso o `precisaMigrar` é forçado a `false` nesse ramo. Coberto por
`src/api-credentials/rotacao-segredo.spec.ts`.

No máximo DOIS segredos vivem por vez: rotacionar de novo descarta o
intermediário, senão a janela viraria acúmulo de credenciais válidas.

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

### Idempotência por `referenciaExterna` (cobrança E saque)

Não existe header `idempotency-key` — a idempotência da API pública é a
`referenciaExterna` (o id do pedido DO LOJISTA), resolvida DENTRO do
`PixService`, antes de qualquer validação/débito. **A referência NÃO é unique
no banco** (é `@@index`, não `@@unique`): é etiqueta, e a decisão é sempre
contra a transação MAIS RECENTE da referência, por sentido.

**COBRANÇA nunca responde 409 pela referência** ("nunca perder venda" —
decisão do dono do produto, ago/2026):

- Mesma referência + MESMOS dados (valor, pagador nome/documento/email,
  itens) + cobrança que ainda SERVE → devolve a MESMA transação, com situação
  ATUAL. "Serve" = `CONCLUIDA`/`MED` (venda já paga: avisa em vez de duplicar)
  ou `AGUARDANDO_PAGAMENTO` com QR dentro da validade.
- Qualquer outro caso — dado diferente (carrinho mudou), `FALHA` (retry
  pós-503), QR expirado, ainda sem `pixCopiaCola` (1ª chamada em voo) → gera
  uma cobrança NOVA sob a MESMA referência. O QR antigo que chegou a ser
  exibido continua pagável na liquidante (não há cancel no contrato das
  adquirentes); cada cobrança credita só o próprio pagamento e o lojista
  distingue callbacks pelo `idTransacao`.

**SAQUE mantém a trava:** mesmos dados → replay (situação atual); QUALQUER
divergência → 409 (criar segunda ordem de pagamento sob a mesma referência é
como se paga duas vezes).

⚠️ **Isto é detecção de RETENTATIVA, não a trava de dinheiro.** Só o lojista
sabe que a segunda chamada é a mesma operação, e a `referenciaExterna` é
OPCIONAL de propósito — é o id do sistema DELE. Sem ela, a chamada é um saque
novo. A integridade do ledger não depende disso: as chaves derivam do
`idTransacaoPrivado` e o débito nasce no mesmo commit da transação (ver
"Saque: transação e débito nascem no MESMO commit"). Nunca reintroduzir dado
externo em chave de dinheiro.

⚠️ **O pre-check sozinho NÃO resolve a corrida** (bot que dispara duas vezes no
mesmo instante): é read-then-write, e as duas chamadas leem "não existe" antes
de qualquer uma gravar. Quem barra é a UNIQUE PARCIAL
`transacoes_saque_referencia_key` (`(usuario_id, referencia_externa) WHERE
direcao='SAIDA'`, migration 20260808140000) — parcial porque cash-in PRECISA
repetir referência. A perdedora leva P2002, é tratada como retentativa (relê a
vencedora e devolve o MESMO saque) e nunca vira segundo débito/segundo PIX.
Reproduzido e coberto por `src/pix/saque-concorrencia.spec.ts` — o teste falha
se o índice sumir.

**Duas ordens SEM referência no mesmo instante são dois saques legítimos** — não
há como distinguir. Quem limita é o saldo: `SELECT FOR UPDATE` serializa e o
segundo lê o saldo já debitado (mesmo spec, primeiro caso).

Coberto por `src/pix/referencia-idempotente.spec.ts` — inclusive o
curto-circuito (replay não pode tocar config, ledger nem adquirente).

### Cobrança: pagador obrigatório

`pagador` com `nome`, `documento` e `email` é **obrigatório** em
`criarCobrancaPixSchema` — as liquidantes recusam a cobrança sem os três
(`ValorionPaymentProvider.createCharge`). Enquanto eram opcionais, a cobrança
era aceita e só quebrava na adquirente: o lojista recebia **503 genérico** sem
saber o campo faltante e a venda ia para FALHA sem código PIX. Mesmo erro que o
cash-out já tinha cometido com `nomeBeneficiario`.

`documento` é CPF **ou** CNPJ, decidido pelo TAMANHO após `normalizarDocumento`
(11 = CPF, 14 = CNPJ) — não existe campo de tipo. Aceita máscara e o **CNPJ
alfanumérico** da Receita. Nunca usar `replace(/\D/g, '')` em documento: apaga
as letras do alfanumérico e o valor chega mutilado na liquidante.

⚠️ O campo da Valorion se chama `cpf` e não há equivalente para CNPJ — nosso
contrato aceita pagador PJ, mas o comportamento dela com 14 posições não está
confirmado.

### Saque: beneficiário obrigatório

`nomeBeneficiario` e `documentoBeneficiario` são **obrigatórios** em
`criarSaquePixSchema` — a liquidante exige os dois e confere o documento contra o dono
da chave no DICT. Enquanto eram opcionais, o saque saía com string vazia e só quebrava
na adquirente, **com o saldo do lojista já debitado**.

O documento tem que ser o do **titular da chave**. Quando `tipoChavePix` é `CPF`/`CNPJ`
a chave É o documento, então o schema recusa divergência na hora (400, antes do débito).
No painel, nome e documento vêm da `chaves_pix_usuarios` aprovada — chave sem
`nomeTitular`/`documentoTitular` é recusada no `saquePainel` pelo mesmo motivo.

### Saque: transação e débito nascem no MESMO commit

**Chave de dinheiro deriva de id NOSSO, nunca de dado do lojista.** `criarSaque` abre UM
`$transaction`: cria a transação e, dentro dele, chama `ledger.aplicarMovimentacoes(..., db)` com
as chaves `saque:hold:<idTransacaoPrivado>` e `saque:tarifa:<idTransacaoPrivado>`. As movimentações
já nascem com `transacao_id` preenchido — o `PixCashOutProcessor` revalida o débito somando
`movimentacoes_saldo` **por `transacao_id`** antes de mandar dinheiro.

Saldo insuficiente derruba o commit inteiro: nenhuma transação gravada, 400 para o lojista.

⚠️ **Não voltar a derivar a chave da `referenciaExterna`.** Ela é o id do sistema do LOJISTA, chega
de fora e é OPCIONAL — a versão anterior caía num `randomUUID()` por chamada quando ela faltava, ou
seja, saque sem idempotência nenhuma (retry por timeout = segundo débito + segundo PIX). Também
não existe mais o `updateMany` que adotava movimentação órfã: com transação e débito no mesmo
commit, a janela em que existia débito sem transação deixou de existir.

`aplicarMovimentacoes` aceita um `Prisma.TransactionClient` opcional justamente para isso; sem ele
continua abrindo a própria transação (todos os outros chamadores).

Regressões em `src/pix/saque-debito.spec.ts` (chaves derivadas do id privado, saque SEM
`referenciaExterna` amarrado, saques distintos sem cruzar chave).

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

### Saque: TRÊS desfechos, e confundi-los paga duas vezes

A tentativa nasce **`ENVIANDO` ANTES do POST** — é ela que torna a ordem "em voo"
visível. `jaEnviado` barra qualquer tentativa que **não seja FALHA**, então
timeout não reenvia. Coberto por `src/pix/saque-duplicidade.spec.ts`.

| Desfecho | Erro | O que o processor faz |
|---|---|---|
| Antes do envio | `ErroAntesDoEnvioError` (auth, credencial) | apaga a tentativa e relança — **retry é seguro e necessário** |
| Recusa | `RecusaAdquirenteError` (4xx da criação, menos 408/429) | tentativa FALHA + transação FALHA + `pix.cashout.falhou`, numa transação |
| Ambíguo | qualquer outro (timeout, 5xx) | tentativa fica `ENVIANDO` + `UnrecoverableError` — **congela** |

⚠️ **`throw` cru NÃO congela nada**: a fila roda com `attempts: 5`, então relançar
REAGENDA. Congelar exige `UnrecoverableError` do BullMQ. Foi exatamente esse
engano que abriu a janela de pagamento duplicado — timeout de 20s na Valorion
(que não tem chave de idempotência no cash-out) e o retry mandava um segundo PIX.

**Recusa CONFIRMADA estorna automaticamente** (valor + tarifa, natureza
`ESTORNO_SAQUE`): a liquidante disse que não executou, então segurar o saldo
seria reter dinheiro do lojista. Vale para os dois caminhos — a recusa síncrona e
o webhook que confirma `FAILED`/`CANCELLED` na Camada 1 —, com as MESMAS chaves
(`saque:estorno:<txId>`), então rodar os dois credita uma vez só.

**Estorno e mudança de situação nunca podem deixar `FALHA` sem devolução** — mas
a forma DEPENDE de haver `idTransacaoLiquidante`, porque é ele que dá (ou não)
rede de recuperação pela conciliação:

- **Recusa síncrona (`registrarRecusa`)**: 4xx, o PIX NÃO saiu, NÃO há id da
  liquidante. A conciliação não consegue recuperar (só loga "conferir manual"
  para SAIDA sem id — `outbox-and-ops`, ramo `if (!liquidanteId)`). Então o
  estorno vem PRIMEIRO, em commit próprio: o dinheiro volta no ato, antes de
  qualquer outro passo. Atômico aqui seria PIOR — um blip no commit reverteria
  a devolução junto, sem rede para refazer.
- **Webhook e conciliação (`encerrarComoFalha` / ramo FAILED)**: o saque FOI
  enviado, TEM id da liquidante. Aqui é o oposto: estorno + FALHA + histórico +
  outbox no MESMO `$transaction` (via `aplicarMovimentacoes(..., db)`). Se o
  commit reverter, a tx segue `PROCESSANDO` e a conciliação reencontra +
  reconsulta + refaz — há rede. Antes, o `FALHA` commitava sozinho e o estorno
  vinha depois: um erro no meio deixava `FALHA` sem crédito, e o retry batia no
  guard de "já FALHA" e nunca refazia — dinheiro preso. (Achado ALTA da
  auditoria de cash-out, ago/2026.)

Regra geral: **`FALHA` de saque nunca coexiste com saldo não-devolvido.** Com id
da liquidante → atômico (a conciliação é a rede). Sem id → estorno primeiro (não
há rede, então devolve antes de tudo). Coberto por `saque-duplicidade.spec.ts`.

### Estado final do saque nunca regride

`CONCLUIDA`/`FALHA`/`CANCELADA` NUNCA voltam para `PROCESSANDO`. Toda escrita de
situação de cash-out usa `updateMany` com `WHERE situacao IN [PROCESSANDO,
PENDENTE]` — inclusive o bloco de SUCESSO do envio (`PixCashOutProcessor`), que
antes fazia `update({ where: { id } })` sem guarda: um webhook `PAID` que
chegasse enquanto o `createCashOut` ainda estava em voo marcava `CONCLUIDA` e o
bloco de sucesso a rebaixava para `PROCESSANDO`. A tentativa registra
`SUCESSO`+resposta mesmo quando o `updateMany` da transação dá `count: 0` (o
desfecho já foi selado por outro caminho). Coberto por `saque-duplicidade.spec.ts`
('SUCESSO não regride estado final').

### A resposta do banco é sempre salva E visível ao admin

Toda resposta da liquidante fica em `tentativas_transacoes` (`dadosResposta` =
resposta ao gerar o saque na criação; e o `getStatus` que a CONCILIAÇÃO usou
para decidir o desfecho — antes a conciliação descartava esse `raw`) +
`statusHttp`/`mensagemErro`; o corpo dos webhooks do banco fica em
`webhooks_recebidos_provedor`. **`GET /admin/relatorios/transacoes/:idTransacao`**
(`ADMIN_RELATORIOS_VER`) devolve tudo isso — `tentativas[].respostaBanco` e
`webhooksBanco[].conteudo` — para o suporte explicar ao cliente por que o banco
recusou. Na web, botão "Resposta do banco" em `/admin/relatorios/cash-out|cash-in`
abre o modal (`relatorio-transacoes.tsx`). O relatório em LISTA não carrega esse
JSON (grande por linha) — só o detalhe sob demanda.

⚠️ **Desfecho AMBÍGUO nunca estorna.** Lá o PIX pode ter saído — devolver criaria
rombo do nosso lado, do mesmo jeito que reenviar pagaria duas vezes. Só conferência
humana resolve.

`CANCELADA` saiu de `STATUS_CASH_OUT`: nenhum fluxo cancela saque, e status que
nunca chega faz o lojista escrever `if` morto achando que está coberto.

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
