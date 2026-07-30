# Desenvolvimento local

O ambiente local é composto por:

- PostgreSQL 17 e Redis 7 via Docker Compose;
- API de ingestão em Node.js 22;
- processamento de jobs no worker C#/.NET 8;
- dashboard em Next.js 16.2.12 e React 19.2.8.

O Compose pode iniciar o conjunto completo. Para debug e hot reload, suba
somente PostgreSQL/Redis pela mesma cadeia de overlays e execute as três
aplicações a partir do código-fonte.

O banco é controlado por migrations SQL em `database/migrations`; o projeto
não usa Prisma. Em um volume novo, o bootstrap do PostgreSQL aplica todas as
migrations automaticamente. Para reaplicá-las de forma idempotente depois de
uma alteração, use `make migrate` ou o comando Compose indicado em
[Banco de dados e contratos SQL](database.md#aplicar-e-testar).

## Pré-requisitos

- Git;
- Docker Engine 24+ e Compose 2.24+;
- Node.js 22 e npm;
- .NET SDK 8;
- `make` opcional;
- OpenSSL opcional para gerar a chave local.

Portas:

| Serviço | Compose completo | Processo local |
|---|---:|---:|
| dashboard | `3000` | `3000` |
| API de ingestão | `3001` | `8080` |
| diagnósticos do worker | `8082` | `8082` |
| PostgreSQL | `5432` | `5432` |
| Redis | `6379` | `6379` |

## 1. Preparar o ambiente

Copie o ambiente raiz:

```bash
cp .env.example .env
```

No PowerShell:

```powershell
Copy-Item .env.example .env
```

Troque todas as senhas. Gere uma chave local de 32 bytes:

```bash
openssl rand -base64 32
```

Substitua tanto `SLUICE_MASTER_KEY_BASE64` quanto a entrada correspondente em
`SLUICE_MASTER_KEYS`. Mantenha o mesmo material de versão em API, worker e
dashboard.

### Opção A: conjunto completo

Inicie infraestrutura e aplicações:

```bash
docker compose --env-file .env \
  -f docker-compose.yml \
  -f infra/compose.apps.yml \
  -f infra/compose.dev.yml \
  up --build -d
```

Ou:

```bash
make doctor
make up
```

Confirme:

```bash
docker compose --env-file .env \
  -f docker-compose.yml \
  -f infra/compose.apps.yml \
  -f infra/compose.dev.yml \
  ps

make test-db

curl http://localhost:3001/health/ready
curl http://localhost:8082/health/ready
curl http://localhost:3000/api/health
```

O overlay de desenvolvimento publica as portas somente em `127.0.0.1`. Não o
use em produção.
O dashboard inicia em modo conectado conforme `.env.example`; conclua o
bootstrap do primeiro owner em [Modo conectado](#modo-conectado).

O health do dashboard em `http://localhost:3000/api/health` inclui
`databaseReady: true` somente depois de uma consulta real ao PostgreSQL. A tela
conectada lê o mesmo banco sob RLS; não depende de fixtures, cache local ou
preferências de navegador para apresentar os indicadores operacionais.

### Opção B: infraestrutura em container, aplicações no código-fonte

Use a mesma cadeia, mas selecione apenas os dois serviços:

```bash
docker compose --env-file .env \
  -f docker-compose.yml \
  -f infra/compose.apps.yml \
  -f infra/compose.dev.yml \
  up --build -d postgres redis
```

Siga as seções seguintes. Não use `infra/compose.dev.yml` sem
`infra/compose.apps.yml`, pois ele contém overrides de porta para as
aplicações.

## 2. API de ingestão

No diretório `apps/ingest-api`:

```bash
cp .env.example .env
npm ci
```

Edite `.env`:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=8080
DATABASE_URL=postgres://sluice_api:SENHA_API_DA_RAIZ@localhost:5432/sluice
DATABASE_SSL=false
REDIS_URL=redis://:SENHA_REDIS_DA_RAIZ@localhost:6379/0
REDIS_FAILURE_POLICY=closed
SLUICE_MASTER_KEYS=1:BASE64_DE_32_BYTES
SLUICE_ACTIVE_KEY_VERSION=1
```

O Node não carrega esse arquivo pelo script `npm run dev`. Para usá-lo
explicitamente:

```bash
npx tsx --env-file=.env watch src/server.ts
```

Se as variáveis já foram exportadas pelo shell/IDE, use:

```bash
npm run dev
```

Teste o processo:

```bash
curl http://localhost:8080/health/live
curl http://localhost:8080/health/ready
```

## 3. Worker C#/.NET 8

O worker não lê arquivos `.env` automaticamente. Exporte as variáveis antes de
executar.

Bash:

```bash
export SLUICE_WORKER_DATABASE_URL='Host=localhost;Port=5432;Database=sluice;Username=sluice_worker;Password=SENHA_WORKER_DA_RAIZ;SSL Mode=Disable'
export REDIS_URL='localhost:6379,password=SENHA_REDIS_DA_RAIZ,defaultDatabase=0,abortConnect=false'
export SLUICE_MASTER_KEYS='1:BASE64_DE_32_BYTES'
export SLUICE_ACTIVE_KEY_VERSION='1'
export WORKER_DIAGNOSTICS_URL='http://127.0.0.1:8082'

dotnet run --project apps/worker/src/Sluice.Worker/Sluice.Worker.csproj
```

PowerShell:

```powershell
$env:SLUICE_WORKER_DATABASE_URL='Host=localhost;Port=5432;Database=sluice;Username=sluice_worker;Password=SENHA_WORKER_DA_RAIZ;SSL Mode=Disable'
$env:REDIS_URL='localhost:6379,password=SENHA_REDIS_DA_RAIZ,defaultDatabase=0,abortConnect=false'
$env:SLUICE_MASTER_KEYS='1:BASE64_DE_32_BYTES'
$env:SLUICE_ACTIVE_KEY_VERSION='1'
$env:WORKER_DIAGNOSTICS_URL='http://127.0.0.1:8082'

dotnet run --project .\apps\worker\src\Sluice.Worker\Sluice.Worker.csproj
```

O log `PostgreSQL worker contract validated` confirma que as funções SQL
esperadas existem. Verifique:

```bash
curl http://localhost:8082/health/ready
curl http://localhost:8082/metrics
```

Com o Redis do Compose configurado, readiness mostra `postgres_notify=ok` e
`redis_wakeup=ok`. O deploy padrão produz sinais pelo PostgreSQL; o subscriber
Redis fica disponível para um publisher externo opcional. Se qualquer canal
de wake-up degradar, o polling permanece ativo.

Para o worker, `REDIS_URL` recebe uma connection string do
StackExchange.Redis, não a URI `redis://` usada pela API Node/ioredis. No
Compose raiz, configure `SLUICE_WORKER_REDIS_URL`; o overlay a mapeia para
`REDIS_URL` dentro do container.

## 4. Dashboard

Para demonstração sem PostgreSQL:

```bash
cd apps/dashboard
cp .env.example .env.local
npm ci
```

Em `.env.local`, mantenha:

```dotenv
SLUICE_DEMO_MODE=true
SLUICE_RUNTIME_ENV=development
SLUICE_SESSION_SECRET=development-session-secret-with-at-least-32-characters
SLUICE_COOKIE_SECURE=false
SLUICE_DEMO_EMAIL=admin@sluice.local
SLUICE_DEMO_PASSWORD=sluice-demo
DATABASE_URL=
```

No Compose, `infra/compose.dev.yml` injeta `SLUICE_RUNTIME_ENV=development`
automaticamente. Ao iniciar o dashboard fora do Compose, mantenha essa mesma
variável para liberar o fluxo local por senha; valores ausentes ou inválidos
adotam a política segura de produção.

O conteúdo do modo demo prioriza os dados simulados. Como o readiness verifica
qualquer `DATABASE_URL` configurada, deixe-a vazia para reduzir acoplamento e
evitar uma conexão acidental durante a demonstração.

Execute:

```bash
npm run dev
```

Abra `http://localhost:3000` e use `admin@sluice.local` /
`sluice-demo`. Mutações são simuladas e nenhum registro é escrito.

### Modo conectado

Para usar dados reais:

```dotenv
SLUICE_DEMO_MODE=false
DATABASE_URL=postgresql://sluice_dashboard:SENHA_DASHBOARD_DA_RAIZ@localhost:5432/sluice
DATABASE_SSL=false
SLUICE_SESSION_SECRET=outra-chave-local-com-ao-menos-32-caracteres
```

É necessário criar o primeiro owner uma única vez. Gere um hash Argon2id no
diretório do dashboard:

```bash
node --input-type=module -e \
  "import { hash } from '@node-rs/argon2'; console.log(await hash('troque-esta-senha'))"
```

Abra `psql` como administrador local:

```bash
docker compose --env-file .env \
  -f docker-compose.yml \
  -f infra/compose.apps.yml \
  -f infra/compose.dev.yml \
  exec postgres sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec psql --no-psqlrc \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Substitua o hash no comando:

```sql
SELECT *
FROM sluice.bootstrap_first_owner(
    'admin@sluice.local',
    'Administrador local',
    '$argon2id$HASH_COMPLETO',
    'local',
    'Sluice Local'
);
```

A função só aceita uma instância sem usuários e sem tenants. Depois do
bootstrap, faça login com a senha em texto usada para gerar o hash.

## 5. Criar uma fonte e testar um webhook

### Pelo dashboard conectado (recomendado)

Faça login em `http://localhost:3000`, abra **Fontes** e escolha **Criar
fonte**. A UI cifra o segredo antes de persistir, mostra apenas uma versão
mascarada depois da criação e devolve a URL pública do webhook. No Compose de
desenvolvimento ela usa a porta publicada da API:

```text
http://localhost:3001/v1/webhooks/{provider}/{endpointKey}
```

Fontes criadas pela UI começam com reconciliação desativada. Ative-a somente
depois de configurar a base HTTPS fixa do provedor em
`WORKER_RECONCILIATION_ENDPOINTS_JSON` e o bloco cifrado
`provider.reconciliation` da fonte; sem ambos o job de reconciliação pode
terminar em dead-letter. A alteração é persistida e auditada.

### Pelo CLI de provisionamento

O CLI é útil para provisionamento automatizado. Os UUIDs de tenant e usuário
retornados pelo bootstrap são necessários. O usuário deve ser owner/admin
ativo. No diretório `apps/ingest-api`, configure:

```bash
export SLUICE_BOOTSTRAP_DATABASE_URL='postgres://sluice_dashboard:SENHA_DASHBOARD_DA_RAIZ@localhost:5432/sluice'
export SLUICE_BOOTSTRAP_DATABASE_SSL='false'
export SLUICE_MASTER_KEYS='1:BASE64_DE_32_BYTES'
export SLUICE_ACTIVE_KEY_VERSION='1'
export SLUICE_BOOTSTRAP_SECRET='token-local-com-16-ou-mais-bytes'
export SLUICE_BOOTSTRAP_CONFIG_JSON='{"schemaVersion":1,"job":{"type":"webhook.process","priority":100,"maxAttempts":8}}'

npm run bootstrap:source -- \
  --tenant-id UUID_DO_TENANT \
  --actor-user-id UUID_DO_OWNER \
  --provider asaas \
  --name "Asaas local"
```

No PowerShell, substitua `export NOME=...` por `$env:NOME='...'`.

Guarde a `endpointKey` exibida. Com API e worker executados pelo código-fonte,
envie:

```bash
curl -i -X POST \
  "http://localhost:8080/v1/webhooks/asaas/ENDPOINT_KEY" \
  -H "Content-Type: application/json" \
  -H "asaas-access-token: token-local-com-16-ou-mais-bytes" \
  --data-binary \
  '{"id":"evt-local-001","event":"PAYMENT_CONFIRMED","dateCreated":"2026-01-01T12:00:00Z"}'
```

A resposta aceita deve conter `received: true`. Repetir exatamente a chamada
retorna `duplicate: true`. Consulte evento e job no dashboard conectado.
Se estiver usando o Compose completo, troque a porta da URL para `3001`.

## Testes

### Banco

```bash
make test-db
```

### API

```bash
cd apps/ingest-api
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

O teste de integração com banco é opcional:

```bash
export TEST_DATABASE_URL='postgres://sluice_api:SENHA_API_DA_RAIZ@localhost:5432/sluice'
export TEST_DATABASE_ADMIN_URL='postgres://sluice_admin:SENHA_ADMIN_DA_RAIZ@localhost:5432/sluice'
npm run test:integration
```

### Worker

```bash
dotnet restore apps/worker/Sluice.Worker.sln
dotnet build apps/worker/Sluice.Worker.sln --no-restore
dotnet test apps/worker/Sluice.Worker.sln --no-build
```

### Dashboard

```bash
cd apps/dashboard
npm ci
npm run typecheck
npm run lint
npm test
```

`npm test` compila o output standalone e exercita login, proteção da console e
mutações do modo demo.

### E2E conectado da stack completa

Com o Compose completo em execução, health verde e um owner/admin ativo no
tenant, execute o teste contra os serviços publicados:

```powershell
Set-Location apps/dashboard
$env:SLUICE_CONNECTED_E2E = "1"
npm run test:connected
```

No Bash, use `SLUICE_CONNECTED_E2E=1 npm run test:connected`. Por padrão o
teste procura `http://127.0.0.1:3000`, `http://127.0.0.1:3001` e
`admin@sluice.local`; ajuste `SLUICE_DASHBOARD_URL`, `SLUICE_INGEST_URL` e
`SLUICE_CONNECTED_E2E_EMAIL` quando necessário. Ele obtém uma sessão curta do
container de dashboard, sem imprimir a chave de sessão nem exigir a senha do
owner no terminal.

O cenário verifica as 11 rotas da console, autenticação/autorização, proteção
de origem, criação e desativação auditada de recursos, reconciliação e webhooks
assinados de Asaas, PagBank, Mercado Pago, Stripe e Pix. Também cobre assinatura
inválida, duplicata e conflito de deduplicação. A limpeza é lógica: os recursos
de teste são desativados e a auditoria append-only é preservada.

## Parar e resetar

Parar sem remover dados:

```bash
make down
```

Remover os volumes locais é destrutivo e exige confirmação explícita:

```bash
make reset CONFIRM=destroy-local-data
```

O reset apaga PostgreSQL local. Segredos e arquivos `.env` permanecem no
filesystem e devem ser removidos separadamente quando não forem mais
necessários.

## Problemas comuns

| Sintoma | Verificação |
|---|---|
| API falha no startup | `SLUICE_MASTER_KEYS`, versão ativa e URLs obrigatórias |
| API retorna `503` | health do PostgreSQL e Redis/fail-closed |
| worker falha no startup | migrations e assinatura das funções SQL |
| `postgres_notify`/`redis_wakeup` degradado | listener reconecta; polling continua |
| dashboard demo usa dados reais | confirme `SLUICE_DEMO_MODE=true` e reinicie |
| dashboard conectado retorna `401` | owner, hash Argon2id e membership ativa |
| dashboard conectado retorna `503` | PostgreSQL, `SLUICE_DASHBOARD_DATABASE_URL` e `/api/health` (`databaseReady`) |
| destino vai para dead-letter | HTTPS, host exato na allowlist e configuração cifrada |
| reconciliação vai para dead-letter | deixe a fonte desativada ou configure o endpoint HTTPS fixo do provedor no worker |
| porta `8080` ocupada | mantenha worker em `8082` localmente |
