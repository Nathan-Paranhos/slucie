# Operação

Este runbook cobre a referência self-hosted incluída no repositório.
`docker-compose.yml` define PostgreSQL e Redis;
`infra/compose.apps.yml` adiciona API, worker C#/.NET 8, dashboard e as redes
de ingress/egress. Os serviços continuam independentes e podem ser implantados
separadamente por um orquestrador.

O Compose é adequado para desenvolvimento e avaliação. Produção exige decisões
do operador sobre alta disponibilidade, capacidade, secret manager, rede,
backup, observabilidade e resposta a incidentes.

## Topologia recomendada

```text
Internet
   │
   ▼
WAF / proxy TLS ─────► ingest-api (Node.js 22)
   │
   └───────────────► dashboard (Next.js 16.2.12 / React 19.2.8)
                           │
                rede privada de dados
                    ┌──────┴──────┐
                    ▼             ▼
             PostgreSQL 17      Redis 7
                    ▲             ▲
                    └──────┬──────┘
                           │
                    worker C#/.NET 8
                           │
                           ▼
                 egress HTTPS allowlisted
```

PostgreSQL e Redis nunca devem receber tráfego da internet. Separe ingress
público, plano de dados e egress do worker. A validação SSRF da aplicação é
defesa em profundidade; aplique também firewall/NetworkPolicy.

Na referência Compose:

- `data_plane` é interna e conecta banco, Redis e aplicações;
- `edge_plane` recebe o proxy para API/dashboard;
- `worker_egress` separa o caminho de saída do worker.

O overlay de aplicações usa `expose`, não `ports`. Anexe um proxy controlado à
`edge_plane` em produção; publicação direta existe apenas no overlay de
desenvolvimento. A bridge Compose não implementa allowlist externa sozinha:
restrinja `worker_egress` também no firewall ou no orquestrador.

## Imagens

Execute a partir da raiz do repositório:

```bash
docker compose --env-file .env \
  -f docker-compose.yml -f infra/compose.apps.yml build
```

Builds individuais equivalentes:

```bash
docker build -f apps/ingest-api/Dockerfile \
  -t sluice-ingest-api:local apps/ingest-api

docker build -f apps/worker/Dockerfile \
  -t sluice-worker:local .

docker build -f apps/dashboard/Dockerfile \
  -t sluice-dashboard:local apps/dashboard
```

Os Dockerfiles executam build e verificações no estágio de construção e usam
usuários sem privilégios no runtime.

Para subir todos os serviços sem publicar portas do plano de dados:

```bash
docker compose --env-file .env \
  -f docker-compose.yml -f infra/compose.apps.yml up -d
```

## Ordem de inicialização

1. PostgreSQL com migrations concluídas e health check verde.
2. Redis autenticado.
3. Worker .NET; o startup valida as assinaturas das funções SQL.
4. API de ingestão.
5. Dashboard.
6. Proxy TLS, somente após readiness dos serviços.

Durante atualização, aplique migrations aditivas antes de subir binários que
dependem delas. Em seguida atualize worker, API e dashboard. O worker recusa
iniciar quando seu contrato SQL está incompleto.

## Configuração crítica

### Segredos

- Gere senhas únicas por role PostgreSQL e para Redis.
- Use `SLUICE_MASTER_KEYS` no formato `versão:base64`, com 32 bytes por chave.
- Mantenha `SLUICE_ACTIVE_KEY_VERSION` presente no keyring de todos os
  componentes que cifram.
- Injete KEKs, senhas e tokens por secret manager; não os inclua na imagem,
  repositório, log ou backup do banco.
- Defina `SLUICE_SESSION_SECRET` com pelo menos 32 caracteres no dashboard.
- Mantenha `SLUICE_DEMO_MODE=false` em produção.

### API

- `NODE_ENV=production` força HTTPS percebido pela aplicação.
- Configure `TRUST_PROXY=true` somente atrás de proxy confiável que substitua
  corretamente `X-Forwarded-Proto`.
- `REDIS_FAILURE_POLICY=closed` é o padrão seguro. O parser rejeita
  fail-open em `NODE_ENV=production`.
- Proteja `/metrics` com `METRICS_BEARER_TOKEN` e rede privada.

### Worker C#/.NET 8

- `WORKER_HEARTBEAT_SECONDS` precisa ser menor que
  `WORKER_LEASE_SECONDS`.
- O pool Npgsql usa aproximadamente `WORKER_CONCURRENCY + 20` conexões por
  réplica. Inclua API e dashboard no orçamento de `max_connections`.
- `REDIS_URL` é opcional para o worker e usa o formato StackExchange.Redis,
  por exemplo
  `redis:6379,password=segredo,defaultDatabase=0,abortConnect=false`.
  Esse subscriber aceita sinais de um publisher externo opcional; o caminho
  padrão usa PostgreSQL `LISTEN/NOTIFY`, e polling continua ativo.
- No Compose, a variável externa é `SLUICE_WORKER_REDIS_URL`, mapeada para
  `REDIS_URL` somente no container .NET. Não reutilize nela a URI `redis://`
  da API Node/ioredis.
- Exponha `WORKER_DIAGNOSTICS_URL` somente em rede interna.
- Configure endpoints de reconciliação como bases HTTPS fixas em
  `WORKER_RECONCILIATION_ENDPOINTS_JSON`.
- Configure allowlist de hosts das notificações, além dos endpoints HTTPS
  fixos.

### Dashboard

- Use a role `sluice_dashboard`, sem propriedade de tabelas e sem
  `BYPASSRLS`.
- Habilite `DATABASE_SSL=true` e mantenha
  `DATABASE_SSL_REJECT_UNAUTHORIZED=true` quando usar uma CA confiável.
- O cookie deve permanecer `HttpOnly`, `SameSite=Lax` e `Secure`.
- MFA completo ainda não está implementado; use VPN/identity-aware proxy ou
  integre SSO antes de expor administração sensível.

## TLS

O overlay `infra/compose.tls.yml` exige TLS 1.3 no PostgreSQL e configura API,
dashboard e worker C# para validar a CA. Ele requer a composição conjunta com
`docker-compose.yml` e `infra/compose.apps.yml`:

```bash
docker compose --env-file .env \
  -f docker-compose.yml \
  -f infra/compose.apps.yml \
  -f infra/compose.tls.yml \
  config

docker compose --env-file .env \
  -f docker-compose.yml \
  -f infra/compose.apps.yml \
  -f infra/compose.tls.yml \
  up -d
```

Os arquivos apontados por `POSTGRES_TLS_CERT_FILE`,
`POSTGRES_TLS_KEY_FILE` e `POSTGRES_TLS_CA_FILE` precisam existir no host e a
chave privada deve ter permissões restritas. O certificado do servidor precisa
conter `postgres` no Subject Alternative Name DNS, correspondente ao hostname
usado pelos serviços no Compose.

Esse overlay não configura:

- TLS público do proxy;
- TLS do Redis;
- certificados cliente (mTLS).

Configure esses itens na plataforma de implantação. Não combine o overlay
`infra/compose.dev.yml`, que publica portas no host, com produção.

## Health checks

| Serviço | Endpoint | Readiness |
|---|---|---|
| API | `/health/live` | processo ativo |
| API | `/health/ready` | PostgreSQL e, em fail-closed, Redis |
| Worker | `/health/live` | processo ativo |
| Worker | `/health/ready` | query PostgreSQL obrigatória; `LISTEN/NOTIFY` e Redis podem degradar |
| Dashboard | `/api/health` | processo ativo e indicação se o DB foi configurado |

O health do dashboard não executa uma query. Monitore separadamente uma
operação autenticada ou a conectividade PostgreSQL.

Use liveness apenas para reinício do processo. Use readiness para retirar a
réplica do balanceador. Não reinicie o worker apenas porque
`postgres_notify` ou `redis_wakeup` aparece como `degraded_polling`; polling
continua encontrando trabalho durável.

## Métricas

A API expõe métricas default do runtime com prefixo `sluice_ingest_` e:

- `sluice_webhook_requests_total{provider,outcome}`;
- `sluice_webhook_duration_seconds{provider,outcome}`;
- `sluice_webhook_body_bytes{provider}`;
- `sluice_rate_limit_redis_failures_total{policy}`;
- `sluice_ingest_database_errors_total{operation}`;
- `sluice_ingest_internal_errors_total{component}`.

O worker expõe:

- `sluice_worker_jobs_claimed_total`;
- `sluice_worker_jobs_active`;
- `sluice_worker_leases_lost_total`;
- `sluice_worker_outbound_requests_total`;
- `sluice_worker_notifications_total`;
- `sluice_worker_last_claim_timestamp_seconds`;
- `sluice_worker_jobs_completed_total{job_type}`;
- `sluice_worker_jobs_failed_total{code}`.

Alertas mínimos devem cobrir:

- erro/readiness do PostgreSQL;
- crescimento da idade do job pendente mais antigo;
- dead-letter e falhas por código;
- leases perdidos;
- p95/p99 da ingestão;
- falhas do rate limit;
- atraso do purge em relação a `purge_after`;
- falha ou atraso dos cinco jobs do `pg_cron`;
- uso de conexões, disco, WAL e capacidade de backup.

Defina limiares a partir dos SLOs e da carga real; valores universais tendem a
gerar silêncio ou ruído.

## Consultas operacionais

Execute com uma identidade autorizada e defina o contexto RLS. Não use
`sluice_owner` em dashboards ou automações permanentes.

Profundidade e idade da fila por tenant:

```sql
BEGIN;
SELECT set_config('app.tenant_id', :'tenant_id', true);

SELECT
    status,
    count(*) AS jobs,
    min(clock_timestamp() - created_at) FILTER (
        WHERE status = 'pending'
    ) AS oldest_pending
FROM sluice.jobs
WHERE tenant_id = :'tenant_id'::uuid
GROUP BY status
ORDER BY status;

COMMIT;
```

Leases em processamento:

```sql
SELECT id, job_type, claimed_by, delivery_count,
       lease_expires_at, heartbeat_at
FROM sluice.jobs
WHERE tenant_id = :'tenant_id'::uuid
  AND status = 'processing'
ORDER BY lease_expires_at;
```

Estado do cron:

```sql
SELECT jobname, schedule, active
FROM cron.job
WHERE jobname LIKE 'sluice-%'
ORDER BY jobname;
```

O acesso ao schema `cron` deve ficar restrito a uma identidade operacional.

## Runbooks de falha

### PostgreSQL indisponível

1. Retire API e dashboard do balanceador; a API não pode confirmar eventos.
2. Pare escalonamento agressivo de workers para evitar tempestade de conexão.
3. Verifique storage, conexões, WAL/replicação e failover.
4. Recupere o primário e confirme migrations/health.
5. Libere worker antes da API para drenar jobs existentes.
6. Libere a API e acompanhe duplicatas legítimas reenviadas pelos PSPs.

Não responda sucesso ao provedor enquanto o evento não estiver confirmado no
PostgreSQL.

### Redis indisponível

Na API, fail-closed retorna `503` e `Retry-After: 5`; restaure Redis ou assuma
explicitamente o risco de outra proteção de borda. No worker, a fila continua
por `LISTEN/NOTIFY` e polling; apenas o subscriber externo opcional
`redis_wakeup` fica `degraded_polling`.

Redis pode ser recriado. Não restaure jobs a partir dele.

### Fila cresce

1. Compare taxa de ingestão, claim e conclusão.
2. Agrupe `sluice_worker_jobs_failed_total` por código.
3. Verifique destino, DNS, certificados, allowlist e limites HTTP.
4. Confirme disponibilidade de conexões e ausência de lock prolongado.
5. Escale réplicas do worker gradualmente.
6. Só aumente concorrência depois de verificar pools, CPU e capacidade dos
   destinos.

### Leases perdidos

Ocorrências isoladas durante deploy/falha são esperadas. Crescimento contínuo
indica heartbeat lento, pausa de runtime, banco instável ou lease curto. Não
edite o job manualmente: o sweep a cada minuto recupera o registro e o fencing
rejeita resultados atrasados.

### Dead-letter

1. Inspecione somente código seguro, tipo, tentativas e IDs; não copie payload
   para tickets.
2. Corrija configuração, destino ou handler.
3. Use o redrive no dashboard com owner/admin.
4. Confirme o novo job e preserve o original.

Redrive é recusado quando o payload já foi purgado.

### Falha de descriptografia

1. Não substitua a chave associada a um `kid`.
2. Verifique se todas as versões necessárias estão no keyring do serviço.
3. Compare `key_version` da linha com o envelope.
4. Restaure a KEK correta pelo secret manager.
5. Trate possível alteração/corrupção como incidente de integridade.

### Purge atrasado

Verifique o job `sluice-lgpd-purge`, locks e volume por lote. É seguro executar
um lote adicional com uma role de manutenção autorizada:

```sql
SELECT sluice.purge_expired_payloads(1000);
```

Não aumente retenção para mascarar atraso operacional.

## Backup e restauração

Recomendação de produção:

- backup físico compatível com PITR e arquivamento contínuo de WAL;
- cópia externa criptografada e imutável;
- backup separado de roles/grants;
- KEK fora do backup, com procedimento de recuperação protegido;
- retenção de backup compatível com a política LGPD;
- restore drill periódico em rede isolada.

Após restaurar:

1. recupere roles e banco na mesma versão principal suportada;
2. disponibilize as versões de KEK necessárias;
3. aplique migrations pendentes;
4. execute `database/tests/contracts.sql`;
5. execute `purge_expired_payloads` antes de liberar acesso;
6. valide cron, RLS, health do worker e uma ingestão sintética;
7. só então abra tráfego.

Um dump lógico é útil para portabilidade, mas não substitui PITR. Registre RPO,
RTO e o resultado dos testes.

## Rotação

### KEK

1. Adicione a nova versão ao keyring em todas as réplicas.
2. Reinicie e confirme readiness.
3. Mude a versão ativa para novas escritas.
4. Recifre recursos em lotes auditáveis.
5. Confirme que nenhum envelope usa a versão antiga.
6. Remova e destrua a chave antiga conforme política.

O repositório ainda não fornece um comando geral de recifragem; planeje e
valide esse procedimento antes de retirar uma versão.

### Credenciais PostgreSQL

Rotacione uma role por vez, atualize seu serviço, confirme health e só depois
encerre sessões antigas. Evite rotação simultânea de API, worker e dashboard.

## Shutdown e deploy do worker

Ao receber término, o worker deixa de fazer claims e aguarda jobs em voo por
`WORKER_DRAIN_SECONDS`. Configure o grace period do orquestrador acima desse
valor. Se o prazo expirar, o lease permanece até o sweep; não force updates no
banco.

Use rollout gradual, IDs de worker distinguíveis e capacidade suficiente para
processar backlog durante a atualização.
