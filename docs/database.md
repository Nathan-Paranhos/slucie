# Banco de dados e contratos SQL

O PostgreSQL é a fonte de verdade do Sluice. Eventos, jobs, tentativas,
efeitos idempotentes, notificações, auditoria e checkpoints permanecem
duráveis no schema `sluice`. Redis não contém a fila e pode ser reconstruído
sem perda desses registros.

Este documento descreve o contrato implementado pelas migrations em
[`database/migrations`](../database/migrations). Mudanças incompatíveis exigem
uma migration nova e coordenação com a API de ingestão, o dashboard e,
principalmente, o worker C#/.NET 8.

## Versão e extensões

A imagem de referência usa PostgreSQL 17 e instala:

- `pgcrypto`, para UUIDs e primitivas criptográficas auxiliares;
- `citext`, para e-mail e slug sem distinção de caixa;
- `pg_cron`, para manutenção sem leader election na aplicação.

As migrations atuais são aplicadas em ordem lexical:

| Migration | Responsabilidade |
|---|---|
| `0001` | extensões, roles e schema |
| `0002` | tabelas, índices, constraints e triggers |
| `0003` | RLS, políticas e grants mínimos |
| `0004` | ingestão, claim, lease, retry, dead-letter e efeitos |
| `0005` | purge, rollups, reconciliação e outbox |
| `0006` | agendas do `pg_cron` |
| `0007` | autenticação e ações administrativas do dashboard |
| `0008` | criação de tenant e políticas de escrita administrativas |

## Roles

| Role | Login no container | Uso |
|---|---:|---|
| `sluice_owner` | não | proprietária do schema; `BYPASSRLS`; nunca use em runtime |
| `sluice_api` | sim | somente funções de resolução e ingestão |
| `sluice_worker` | sim | funções da fila e leituras limitadas usadas pelo worker .NET |
| `sluice_dashboard` | sim | consultas com RLS e mutações administrativas autorizadas |
| `sluice_maintenance` | não | funções chamadas pelo scheduler |
| `sluice_readonly` | sim | consultas sujeitas a RLS |

O bootstrap do container transforma as quatro roles de runtime em `LOGIN`,
define senhas SCRAM e limites de conexão. Em uma instalação externa, prefira
roles de login próprias que herdem os grupos acima. Nenhuma role de aplicação
deve ser proprietária de objetos ou receber `BYPASSRLS`.

## Modelo de dados

| Tabela | Conteúdo durável |
|---|---|
| `tenants` | estado, retenção e limites padrão do tenant |
| `users`, `tenant_memberships` | identidade administrativa e RBAC |
| `webhook_sources` | endpoint opaco, provedor e envelopes de segredo/configuração |
| `destinations` | configuração cifrada, timeout e allowlist de hosts |
| `pipelines`, `pipeline_destinations` | roteamento e ordem dos destinos |
| `webhook_events` | hashes, envelopes do evento e data de purge |
| `jobs` | fila e estado de lease |
| `job_attempts` | uma linha por claim, com resultado e duração |
| `job_delivery_effects` | ledger idempotente de efeitos externos |
| `audit_log` | trilha append-only |
| `notification_outbox` | notificações duráveis e seus leases |
| `reconciliation_checkpoints` | janela e cursor cifrado por fonte |
| `usage_rollups` | agregações horárias de uso |

Foreign keys entre recursos de tenant incluem `tenant_id`. Isso impede uma
pipeline, tentativa ou efeito de referenciar acidentalmente um registro de
outro tenant.

### Estados de job

```text
pending ──claim──> processing ──sucesso──> completed
   ^                    │
   └────retry/backoff───┤
                        └──falha final──> dead_letter
```

`completed` e `dead_letter` são terminais. O trigger
`jobs_validate_transition` rejeita reabertura. Redrive administrativo chama
`admin_redrive_dead_letter`, cria um novo job com outra chave idempotente e
mantém o original.

Cada claim incrementa `delivery_count`, cria uma linha em `job_attempts` e
gera um `lease_token`. Heartbeat, conclusão e falha só avançam o estado quando
tenant, job, token, status e validade do lease coincidem. Esse é o fencing
consumido pelo worker C#.

## RLS e contexto de sessão

As tabelas multi-tenant usam `ENABLE ROW LEVEL SECURITY` e
`FORCE ROW LEVEL SECURITY`. O dashboard estabelece o contexto dentro da mesma
transação da operação:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000000', true);
-- consultas ou mutações
COMMIT;
```

O terceiro argumento `true` limita a configuração à transação e evita
contaminação ao devolver a conexão ao pool.

O worker .NET também define `app.tenant_id` nas leituras diretas. Claim e
transições usam funções privilegiadas estreitas. A API de ingestão não possui
grants de tabela: todo o caminho é feito por
`resolve_webhook_source` e `ingest_event_and_enqueue`.

## Contratos do dashboard

| Função | Contrato |
|---|---|
| `lookup_dashboard_login(text)` | retorna hash Argon2id e memberships sem depender de contexto prévio |
| `bootstrap_first_owner(text, text, text, text, text)` | cria a primeira identidade/tenant somente em instância vazia |
| `admin_set_membership(uuid, text, text, text)` | cria convite ou altera papel com autorização owner/admin |
| `current_user_is_tenant_admin(uuid)` | decisão restrita à identidade de `app.user_id` |
| `admin_create_tenant(text, text, integer)` | cria tenant e torna o ator owner |
| `admin_redrive_dead_letter(uuid, uuid, text)` | cria outro job e audita o motivo |

`lookup_dashboard_login` é necessariamente anterior à sessão RLS, mas só
retorna o registro associado ao e-mail exato. As demais funções administrativas
validam identidade, membership e tenant. Escritas diretas do dashboard em
fontes, destinos, pipelines e associações também exigem policy owner/admin.

O redrive recusa job que não esteja em `dead_letter` e evento cujo envelope já
tenha sido purgado.

## Contratos da ingestão

### `resolve_webhook_source(uuid)`

Recebe a `endpoint_key` pública e opaca. Retorna apenas uma fonte ativa de um
tenant ativo, incluindo envelopes, limites e retenção. É executável por
`sluice_api`.

### `ingest_event_and_enqueue(...)`

Valida tenant/fonte, digests SHA-256, envelope, versão de chave, prioridade e
tentativas. A retenção do tenant no banco é autoritativa; o horário informado
pela API pode variar no máximo cinco minutos.

O retorno possui `outcome`, `event_id` e `job_id`:

- `inserted`: evento e job foram inseridos na mesma transação;
- `duplicate`: o mesmo ID externo e o mesmo hash de payload já existiam;
- `conflict`: o ID externo já existia com outro hash; nada é reprocessado e a
  divergência é auditada.

A constraint `(tenant_id, source_id, external_event_id_hash)` resolve corridas
de deduplicação. A constraint `(tenant_id, job_type, idempotency_key)` impede
reuso da chave de job.

## Contrato do worker C#/.NET 8

No startup, `DatabaseContractValidationService` confirma a existência exata
destas funções. Se alguma estiver ausente, o processo falha antes de consumir
jobs:

| Função | Uso pelo worker |
|---|---|
| `claim_jobs(text, integer, integer, uuid)` | claim atômico com `SKIP LOCKED` |
| `heartbeat_job(uuid, uuid, uuid, integer)` | estende o lease vigente |
| `complete_job(uuid, uuid, uuid)` | conclui job e tentativa |
| `fail_job(uuid, uuid, uuid, text, text, integer)` | escolhe retry ou dead-letter |
| `dead_letter_job(uuid, uuid, uuid, text, text)` | falha permanente imediata |
| `reserve_delivery_effect(uuid, uuid, uuid, text)` | reserva efeito idempotente |
| `mark_delivery_effect_applied(uuid, uuid, bytea, integer)` | confirma efeito |
| `update_reconciliation_checkpoint(uuid, uuid, bytea, integer, boolean, text)` | grava cursor/resultado |
| `claim_notifications(text, integer, integer)` | claim da outbox |
| `complete_notification(uuid, uuid, uuid)` | confirma notificação |
| `fail_notification(uuid, uuid, uuid, text)` | agenda retry ou falha final |

`claim_jobs` ordena por prioridade numérica ascendente, `available_at`,
`created_at` e UUID. Um número menor representa maior prioridade. Limite e
lease aceitam, respectivamente, `1..500` e `5..3600` segundos; a configuração
do worker aplica limites ainda mais conservadores.

`fail_job` retorna:

- `pending`, quando o retry foi persistido;
- `dead_letter`, quando `delivery_count >= max_attempts`;
- `lost_lease`, quando o fencing rejeita a atualização.

O backoff SQL começa em cinco segundos, dobra até uma hora e recebe até 20% de
jitter. O worker envia um atraso-base para falhas conhecidas; a função continua
sendo a autoridade da transição.

As funções de ingestão, retry, reconciliação e dead-letter emitem somente IDs
nos canais PostgreSQL `sluice_jobs` e `sluice_notifications`. Um
`PostgresWakeSubscriber` C# mantém uma conexão dedicada com `LISTEN`, sinaliza
os pumps e reconecta com backoff. Perda do canal não perde jobs: polling
periódico continua sendo o fallback durável.

## Efeitos externos e outbox

Antes de chamar um destino, o worker reserva uma chave no
`job_delivery_effects`. Para entrega de webhook, o formato atual é:

```text
deliver:{event_id}:{destination_id}
```

Quando o destino retorna sucesso, `mark_delivery_effect_applied` grava código
HTTP e, quando presente, hash de `Location` ou `ETag`. Um efeito já `applied`
não é chamado novamente. Isso oferece comportamento effectively-once somente
quando o destino também honra o header `Idempotency-Key`.

Dead-letter cria uma notificação `dashboard` deduplicada. Canais `webhook` e
`email` podem ser consumidos pelo mesmo worker quando seus endpoints fixos
estão configurados. A outbox faz até dez tentativas, com backoff exponencial
iniciado em 15 segundos e limitado a uma hora.

## Manutenção agendada

| Job `pg_cron` | Agenda | Função |
|---|---|---|
| `sluice-retry-sweep` | a cada minuto | recupera leases de jobs |
| `sluice-notification-lease-sweep` | a cada minuto | recupera leases da outbox |
| `sluice-lgpd-purge` | a cada 10 minutos | remove payloads expirados |
| `sluice-usage-rollup` | a cada 5 minutos | recalcula rollups horários |
| `sluice-reconciliation-enqueue` | a cada 15 minutos | cria jobs de reconciliação |

As funções trabalham em lotes e usam locks com `SKIP LOCKED` onde necessário.
Consulte [Retenção e LGPD](lgpd-retention.md) antes de mudar prazos ou purge.

## Aplicar e testar

No primeiro start de um volume vazio, o entrypoint aplica todas as migrations
em uma única transação. Para reaplicá-las no ambiente local:

```bash
make migrate
make test-db
```

Sem `make`:

```bash
docker compose --env-file .env \
  -f docker-compose.yml \
  -f infra/compose.apps.yml \
  -f infra/compose.dev.yml \
  exec -T postgres \
  /docker-entrypoint-initdb.d/00-bootstrap.sh

docker compose --env-file .env \
  -f docker-compose.yml \
  -f infra/compose.apps.yml \
  -f infra/compose.dev.yml \
  exec -T postgres sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql --no-psqlrc \
  -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < database/tests/contracts.sql
```

Os testes cobrem extensões, roles, cron, RLS entre tenants, deduplicação,
leases/fencing, efeitos, purge, redrive e funções administrativas.

## Evolução de schema

- Adicione um arquivo numerado; não reescreva uma migration publicada.
- Prefira mudanças aditivas e compatíveis com versões anteriores.
- Atualize primeiro o banco quando uma aplicação nova depender de função ou
  coluna adicional.
- Trate alterações de assinatura das funções listadas pelo worker como mudança
  incompatível.
- Avalie lock, duração, rollback e espaço extra antes de aplicar em produção.
- Faça backup e teste de restauração; uma migration não substitui rollback
  operacional.
