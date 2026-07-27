# Sluice Worker (.NET 8 / C#)

Worker de processamento do Sluice. O PostgreSQL é a fonte de verdade da fila;
Redis é opcional e serve somente como sinal de wake-up via pub/sub. O polling
periódico continua ativo mesmo quando Redis está indisponível. Uma conexão
PostgreSQL dedicada executa `LISTEN sluice_jobs` e
`LISTEN sluice_notifications`, consumindo diretamente os `NOTIFY` emitidos
pelas migrations; ela também é apenas uma otimização e reconecta com backoff.
O subscriber Redis aceita sinais de um publisher externo opcional; o deploy
padrão produz wake-up via PostgreSQL.

## Garantias de execução

- `claim_jobs` é executada em uma transação curta e atômica. A transação é
  confirmada antes de qualquer handler iniciar.
- Cada claim recebe um `lease_token`. Heartbeat, conclusão, retry e dead-letter
  usam esse token como fence.
- O worker para de fazer claims durante shutdown e aguarda os jobs em voo. Jobs
  que ultrapassarem o prazo de drain são recuperados pelo sweep de leases.
- A entrega é `at-least-once`; cada chamada HTTP recebe uma
  `Idempotency-Key` estável e cada efeito é registrado em
  `sluice.job_delivery_effects`.
- Leituras diretas sempre ocorrem em uma transação com
  `set_config('app.tenant_id', ..., true)`, respeitando RLS.
- Logs contêm apenas IDs, códigos estáveis, tipos de exceção e estados. Payload,
  headers, URLs, respostas, segredos e mensagens externas não são registrados.

Ao iniciar, o processo valida a presença das funções SQL usadas nas migrations
`0004_ingestion_and_queue_functions.sql` e `0005_maintenance_functions.sql`.
Uma divergência interrompe o startup.

## Handlers

`webhook.process`, `process_webhook` e `deliver_event`

: Carregam o evento, descriptografam o corpo com AES-256-GCM, verificam o
  `payload_hash`, aplicam filtros dos pipelines ativos e entregam, na ordem,
  aos destinos ativos. Como o papel `sluice_worker` não possui permissão para
  criar jobs arbitrários, a expansão dos destinos ocorre dentro do job lógico.
  Em retry, efeitos já marcados como `applied` são ignorados.

`reconcile_provider`

: Usa o `source_id` e a janela presentes em `jobs.arguments`, chama um endpoint
  base fixado pelo operador e atualiza
  `sluice.reconciliation_checkpoints`. A configuração criptografada pode
  escolher apenas um caminho relativo; não pode alterar host, porta ou esquema.

O outbox também é consumido: `dashboard` é confirmado localmente; `webhook` e
`email` são enviados a endpoints HTTPS fixos definidos no ambiente. Falhas usam
`fail_notification`, inclusive seu backoff e limite de tentativas.

## Configuração

Variáveis obrigatórias:

| Variável | Descrição |
|---|---|
| `SLUICE_WORKER_DATABASE_URL` | Connection string Npgsql do papel `sluice_worker` |
| `SLUICE_MASTER_KEYS` | Keyring no formato `versão:base64,versão:base64` |
| `SLUICE_ACTIVE_KEY_VERSION` | Versão usada para novos checkpoints |

Para compatibilidade com o `.env.example` da raiz, uma única chave também pode
ser informada por `SLUICE_MASTER_KEY_BASE64` e
`SLUICE_MASTER_KEY_VERSION`.

Variáveis opcionais:

| Variável | Padrão |
|---|---:|
| `DATABASE_SSL` | `false`; o overlay TLS define `true` |
| `DATABASE_SSL_CA_FILE` | obrigatório quando `DATABASE_SSL=true` |
| `REDIS_URL` | desabilitado; formato StackExchange.Redis |
| `WORKER_ID` | hostname + PID + sufixo aleatório |
| `WORKER_CONCURRENCY` | `16` |
| `WORKER_CLAIM_BATCH_SIZE` | `20`, limitado pela concorrência |
| `WORKER_LEASE_SECONDS` | `60` |
| `WORKER_HEARTBEAT_SECONDS` | um terço do lease |
| `WORKER_POLL_INTERVAL_MS` | `2000` |
| `WORKER_DRAIN_SECONDS` | `30` |
| `WORKER_DIAGNOSTICS_URL` | `http://0.0.0.0:8080` |
| `WORKER_METRICS_BEARER_TOKEN` | sem autenticação; proteja a rede |
| `WORKER_RECONCILIATION_ENDPOINTS_JSON` | `{}` |
| `WORKER_NOTIFICATION_WEBHOOK_URL` | desabilitado |
| `WORKER_NOTIFICATION_EMAIL_URL` | desabilitado |
| `WORKER_NOTIFICATION_ALLOWED_HOSTS` | hosts dos endpoints fixos |
| `WORKER_NOTIFICATION_TIMEOUT_MS` | `10000` |

`REDIS_URL` usa o formato de configuração do StackExchange.Redis:

```text
redis:6379,password=segredo,defaultDatabase=0,abortConnect=false
```

Não use a URI `redis://` consumida pela API Node/ioredis. Na referência
Compose, `.env` expõe `SLUICE_WORKER_REDIS_URL` e
`infra/compose.apps.yml` a mapeia para `REDIS_URL` dentro do worker.

Exemplo de endpoints de reconciliação fixados no deploy:

```json
{
  "stripe": "https://api.stripe.com/v1/",
  "asaas": "https://api.asaas.com/v3/",
  "mercado_pago": "https://api.mercadopago.com/",
  "pagbank": "https://api.pagseguro.com/"
}
```

Não há endpoint Pix universal. O operador deve cadastrar o endpoint do PSP
contratado explicitamente.

## Contratos criptografados

O envelope é idêntico ao da API Node:

```json
{
  "v": 1,
  "alg": "A256GCM",
  "kid": 1,
  "wrappedKey": { "iv": "...", "ciphertext": "...", "tag": "..." },
  "data": { "iv": "...", "ciphertext": "...", "tag": "..." }
}
```

Contexts AAD usados:

- corpo: `webhook-event-body:{tenant_id}:{source_id}:{external_id_hash_hex}`;
- destino: `destination-config:{tenant_id}:{destination_id}`;
- fonte: `webhook-source-config:{tenant_id}:{source_id}`;
- cursor: `reconciliation-cursor:{tenant_id}:{source_id}`.

Configuração descriptografada de um destino:

```json
{
  "schemaVersion": 1,
  "url": "https://hooks.example.com/sluice",
  "method": "POST",
  "contentType": "application/json",
  "headers": {
    "Authorization": "Bearer segredo-armazenado-no-envelope"
  }
}
```

O host deve constar exatamente em `destinations.allowed_hosts`. Não são aceitos
HTTP, userinfo, wildcard/subdomínio implícito, redirect, proxy do ambiente,
loopback, link-local, redes privadas, CGNAT, multicast ou faixas reservadas em
IPv4/IPv6. O DNS é validado novamente no momento da conexão para evitar
rebinding.

A configuração de fonte continua compatível com o objeto `provider` aceito pela
API de ingestão:

```json
{
  "schemaVersion": 1,
  "job": {
    "type": "webhook.process",
    "priority": 100,
    "maxAttempts": 8
  },
  "provider": {
    "reconciliation": {
      "path": "events",
      "method": "GET",
      "headers": {
        "Authorization": "Bearer credencial-da-api-do-psp"
      },
      "cursorQueryParameter": "starting_after",
      "windowStartQueryParameter": "created_after",
      "windowEndQueryParameter": "created_before",
      "nextCursorProperty": "next_cursor",
      "timeoutMs": 10000
    }
  }
}
```

Credenciais de reconciliação são diferentes do segredo de assinatura de
webhook e devem ficar dentro de `config_envelope`.

## Health e métricas

- `GET /health/live`: processo ativo;
- `GET /health/ready`: PostgreSQL obrigatório; o listener `LISTEN/NOTIFY` e
  Redis podem aparecer degradados porque polling é o fallback durável;
- `GET /metrics`: formato Prometheus, opcionalmente protegido por bearer token.

O endpoint de diagnósticos usa HTTP para operar em rede interna ou atrás de um
proxy TLS. Não o exponha diretamente à internet.

Exemplo Redis compatível com `StackExchange.Redis`:

```text
redis:6379,password=segredo,defaultDatabase=0,abortConnect=false
```

## Desenvolvimento

Requer .NET SDK 8 ou superior:

```powershell
cd .\apps\worker
dotnet restore .\Sluice.Worker.sln
dotnet build .\Sluice.Worker.sln --no-restore
dotnet test .\Sluice.Worker.sln --no-build
```

Imagem Docker, executada a partir da raiz do repositório:

```powershell
docker build -f .\apps\worker\Dockerfile -t sluice-worker:local .
```

A imagem compila e executa os testes no estágio de build e roda como usuário
não-root no runtime.
