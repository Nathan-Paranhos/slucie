# API HTTP

O Sluice possui uma API pública de ingestão e endpoints operacionais em cada
serviço. As rotas do dashboard são internas à interface web e não constituem
uma API pública de administração.

## Convenções

- JSON usa UTF-8.
- O endpoint de webhook exige um content type JSON:
  `application/json` ou `application/*+json`.
- A API gera um `requestId` UUID; não confia em um ID fornecido pelo cliente.
- Respostas de erro não incluem detalhes internos, payload, segredo ou IDs de
  banco.
- Em produção, webhooks são aceitos somente quando o protocolo percebido é
  HTTPS.
- O limite global padrão do corpo é 1 MiB e pode chegar no máximo a 16 MiB por
  configuração da aplicação; a fonte pode aplicar um limite menor.

## API pública de ingestão

### `POST /v1/webhooks/{provider}/{endpointKey}`

Recebe um webhook, autentica o provedor, aplica rate limit, cifra o corpo e
persiste evento e primeiro job na mesma transação.

Parâmetros:

| Nome | Contrato |
|---|---|
| `provider` | `asaas`, `pagbank`, `mercado-pago`, `mercado_pago`, `stripe` ou `pix` |
| `endpointKey` | UUID opaco da fonte |

O provedor na rota precisa coincidir com a fonte. O tenant não é um parâmetro
da API.

Exemplo Asaas:

```http
POST /v1/webhooks/asaas/06db215e-1d6b-4a2f-9ab0-6438b13d0a18 HTTP/1.1
Host: ingest.example.com
Content-Type: application/json
asaas-access-token: segredo-configurado

{"id":"evt-001","event":"PAYMENT_CONFIRMED"}
```

Primeiro recebimento:

```http
HTTP/1.1 200 OK
RateLimit-Limit: 600
RateLimit-Remaining: 599

{
  "received": true,
  "duplicate": false,
  "requestId": "f8c1304a-6678-45eb-83a0-aa4b9ce18c17"
}
```

Repetição idempotente com o mesmo ID externo e payload:

```json
{
  "received": true,
  "duplicate": true,
  "requestId": "fa64eac8-9516-4080-8028-8fe1f916095d"
}
```

Mesmo ID externo com outro hash de payload:

```http
HTTP/1.1 409 Conflict

{
  "received": false,
  "quarantined": true,
  "requestId": "473ae74f-d01f-444b-afae-ce49e382735e"
}
```

O `409` registra auditoria de conflito e não cria outro job.

### Status

| HTTP | `error` ou resultado | Significado |
|---:|---|---|
| `200` | `received: true` | inserido ou duplicata idempotente |
| `400` | `invalid_request` | rota/parâmetro inválido |
| `400` | `invalid_payload` | JSON ou schema do provedor inválido |
| `400` | `https_required` | HTTP percebido em produção |
| `401` | `invalid_signature` | credencial/assinatura inválida |
| `401` | `stale_signature` | timestamp fora da tolerância |
| `404` | `not_found` | provedor/fonte inexistente, inativa ou incompatível |
| `409` | resposta `quarantined` | ID externo reutilizado com outro payload |
| `413` | `payload_too_large` | limite global ou da fonte excedido |
| `415` | `application_json_required` | corpo não foi recebido como JSON |
| `429` | `rate_limited` | limite por fonte excedido |
| `503` | `temporarily_unavailable` | banco, Redis fail-closed ou falha interna transitória |

Todo erro JSON inclui `requestId`. `429` inclui `Retry-After`; indisponibilidade
conhecida do rate limiter e falhas de persistência incluem
`Retry-After: 5`.

### Headers de rate limit

Depois de autenticar a fonte, a API pode enviar:

- `RateLimit-Limit`;
- `RateLimit-Remaining`;
- `RateLimit-Reset`, em segundos até o fim da janela;
- `Retry-After`, quando a solicitação foi limitada.

O algoritmo atual usa janela fixa de 60 segundos por `source_id`. Não baseie
correção financeira apenas nesses headers; o resultado durável está no
PostgreSQL.

### Headers persistidos

Somente esta allowlist é copiada para `sanitized_headers`, truncada a 512
caracteres por valor:

- `content-type`;
- `user-agent`;
- `x-request-id`;
- `x-product-origin`.

Headers de assinatura, autorização e cookies não são persistidos.

Os detalhes de assinatura estão em
[Autenticação de provedores](provider-authentication.md).

## Endpoints da API de ingestão

### `GET /health/live`

```json
{
  "status": "ok",
  "service": "sluice-ingest-api"
}
```

### `GET /health/ready`

Quando tudo está disponível:

```json
{
  "status": "ok",
  "checks": {
    "postgres": "ok",
    "redis": "ok"
  }
}
```

Retorna `503` quando PostgreSQL falha ou quando Redis falha sob
`REDIS_FAILURE_POLICY=closed`. Em fail-open, retorna `200`,
`status: "degraded"` e `redis: "degraded_fail_open"`.

### `GET /metrics`

Retorna o exposition format do Prometheus. Quando
`METRICS_BEARER_TOKEN` está definido:

```http
Authorization: Bearer {token}
```

Token ausente/incorreto retorna:

```json
{
  "error": "unauthorized",
  "requestId": "..."
}
```

Não exponha métricas diretamente à internet.

## Diagnósticos do worker C#/.NET 8

O worker expõe HTTP no endereço de `WORKER_DIAGNOSTICS_URL`.

### `GET /health/live`

```json
{
  "status": "ok"
}
```

### `GET /health/ready`

Retorna `503` quando a consulta obrigatória ao PostgreSQL não responde. O
listener PostgreSQL `LISTEN/NOTIFY` e Redis são otimizações de wake-up; qualquer
um pode aparecer degradado com HTTP `200`, porque polling continua:

```json
{
  "status": "degraded",
  "checks": {
    "postgres": "ok",
    "postgres_notify": "degraded_polling",
    "redis_wakeup": "degraded_polling"
  }
}
```

Estados:

- `postgres`: `ok`;
- `postgres_notify`: `ok` ou `degraded_polling`;
- `redis_wakeup`: `ok`, `degraded_polling` ou `disabled_polling`.

### `GET /metrics`

Retorna Prometheus text format. Se `WORKER_METRICS_BEARER_TOKEN` estiver
definido, exige:

```http
Authorization: Bearer {token}
```

Comparação do token é feita em tempo constante. Mantenha o endpoint em rede
interna ou atrás de um proxy TLS.

## Contrato de entrega do worker

O handler de entrega encaminha os bytes originais descriptografados. A
configuração do destino pode escolher `POST`, `PUT` ou `PATCH`.

Headers adicionados pelo Sluice:

```text
Idempotency-Key: deliver:{event_id}:{destination_id}
X-Sluice-Event-Id: {event_id}
Content-Type: {configuração ou content type original}
```

O destino não pode sobrescrever `Host`, tamanho/transferência, conexão,
`Idempotency-Key` ou `X-Sluice-Event-Id`. Redirects não são seguidos.

Classificação:

- qualquer `2xx`: efeito aplicado;
- `408`, `425`, `429` e `5xx`: falha retryable;
- outros status: falha permanente/dead-letter;
- timeout ou transporte: retry;
- URL, header, envelope, hash ou allowlist inválidos: falha permanente.

O destino deve honrar `Idempotency-Key`. Sem isso, uma falha entre o efeito
externo e o commit local ainda pode produzir outra chamada.

## API interna do dashboard

Essas rotas suportam a UI e podem mudar sem versionamento externo. Use o
dashboard, funções SQL administrativas ou desenvolva uma API de gestão
explicitamente revisada; não integre automações de terceiros diretamente
nessas rotas.

### `POST /api/session/login`

Request:

```json
{
  "email": "admin@example.com",
  "password": "senha-com-8-ou-mais-caracteres",
  "returnTo": "/jobs"
}
```

Sucesso grava o cookie `sluice_session` (`HttpOnly`, `SameSite=Strict`, oito
horas) e retorna:

```json
{
  "ok": true,
  "returnTo": "/jobs"
}
```

Credenciais inválidas retornam `401` com `invalid_credentials`.

### `POST /api/session/logout`

Expira o cookie e retorna `{ "ok": true }`.

### `GET /api/dashboard`

Exige sessão. Retorna cards, série temporal, jobs, eventos, fontes, destinos,
pipelines, workers e tenants visíveis no contexto RLS. Owner pode informar
`?tenant={uuid}`; os demais papéis permanecem no tenant da sessão.

### `POST /api/actions`

Exige sessão owner/admin e valida mesma origem quando o header `Origin` está
presente. Ações atuais:

- `redrive_job`;
- `toggle_resource`;
- `create_resource`.

Recursos criáveis: tenant, fonte, destino e pipeline. Em
`SLUICE_DEMO_MODE=true`, a ação é simulada e retorna `demo: true`.

Não envie segredos por essa API fora de HTTPS. Segredos de fonte e configuração
de destino são cifrados antes da escrita.

### `GET /api/health`

Público para health check:

```json
{
  "status": "ok",
  "service": "sluice-dashboard",
  "databaseConfigured": true,
  "timestamp": "2026-01-01T12:00:00.000Z"
}
```

`databaseConfigured` apenas indica presença de `DATABASE_URL`; não confirma
uma query bem-sucedida.

## API de gestão

A versão atual não publica CRUD REST, API keys administrativas nem OpenAPI de
gestão. Provisionamento de fontes pode ser feito pelo CLI documentado e
operações humanas pelo dashboard. Essa ausência é deliberada: uma API de
gestão precisa de autenticação, escopos, auditoria, rate limit e compatibilidade
próprios antes de ser exposta.
