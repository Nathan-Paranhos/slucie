# Autenticação de provedores

A API valida a autenticidade do webhook sobre os bytes exatos recebidos antes
de interpretar o JSON ou escrever no PostgreSQL. Cada URL contém uma
`endpoint_key` UUID opaca:

```text
POST /v1/webhooks/{provider}/{endpoint_key}
```

O tenant é derivado da fonte resolvida no banco; nunca é aceito do corpo,
query string ou header enviado pelo provedor.

Os contratos abaixo descrevem a implementação atual. Provedores podem alterar
protocolos e formatos. Antes de ativar tráfego real, compare a configuração
com a documentação vigente da conta/PSP e execute uma entrega de teste.

## Provedores implementados

| Provedor na URL | Valor no banco | Autenticação | Proteção temporal |
|---|---|---|---|
| `stripe` | `stripe` | HMAC-SHA256 no header `Stripe-Signature` | sim |
| `mercado-pago` ou `mercado_pago` | `mercado_pago` | HMAC-SHA256 com `x-signature` | sim |
| `asaas` | `asaas` | token fixo `asaas-access-token` | não |
| `pagbank` | `pagbank` | SHA-256 em `x-authenticity-token` | não |
| `pix` | `pix` | HMAC-SHA256 configurável | opcional |

O schema aceita `generic` por compatibilidade futura, mas a API não registra
um adaptador `generic`; uma rota desse tipo é rejeitada.

## Stripe

Headers:

```text
Stripe-Signature: t={timestamp},v1={hex_hmac}
Content-Type: application/json
```

O conteúdo assinado é:

```text
ASCII(timestamp + ".") || raw_body
```

Uma ou mais assinaturas `v1` podem ser apresentadas, o que permite a janela de
rotação oferecida pelo provedor. O timestamp em segundos deve estar dentro de
`signatureToleranceSeconds` (300 segundos por padrão).

Campos mínimos do evento:

- `id`: ID externo usado na deduplicação;
- `object`: deve ser `event`;
- `type`: tipo canônico persistido;
- `created`: timestamp Unix;
- `data.object`: objeto JSON.

## Mercado Pago

A URL pode usar `mercado-pago`; o valor persistido é sempre
`mercado_pago`.

Headers e query string:

```text
X-Signature: ts={timestamp},v1={hex_hmac}
X-Request-Id: {request_id}
?data.id={data_id}
```

O manifesto assinado, em UTF-8, é:

```text
id:{data_id_em_minúsculas};request-id:{request_id};ts:{timestamp};
```

`v1` é HMAC-SHA256 hexadecimal usando o segredo da fonte. O timestamp é
interpretado em segundos e validado contra a tolerância. O `data.id` da query
deve coincidir, sem distinção de caixa, com `data.id` do JSON.

Campos mínimos do evento:

- `id`: string ou número usado para deduplicação;
- `type` e `action`: persistidos como `{type}.{action}`;
- `data.id`: string ou número;
- `date_created`: opcional.

## Asaas

Header:

```text
asaas-access-token: {segredo_da_fonte}
```

O token é comparado em tempo constante com o segredo descriptografado. Campos
mínimos:

- `id`: string ou número;
- `event`: tipo persistido;
- `dateCreated`: opcional.

Esse protocolo não inclui timestamp autenticado na implementação. Replay é
contido pela deduplicação durável do ID externo; proteja também o endpoint
opaco e rotacione o token quando houver suspeita de exposição.

## PagBank

Header:

```text
x-authenticity-token: {sha256_hex}
```

O valor esperado pela implementação é o SHA-256 hexadecimal de:

```text
secret_bytes || ASCII("-") || raw_body
```

Campos mínimos:

- `id`: string usada na deduplicação;
- `status`: tipo persistido;
- `created_at`: opcional.

Não há timestamp autenticado nesse contrato. A proteção contra repetição
depende do ID externo e do hash do payload.

## Pix configurável

Pix não define um formato universal de webhook. O adaptador exige uma
configuração explícita e estrita dentro de `config_envelope`:

```json
{
  "schemaVersion": 1,
  "signatureToleranceSeconds": 300,
  "job": {
    "type": "webhook.process",
    "priority": 100,
    "maxAttempts": 8
  },
  "provider": {
    "algorithm": "hmac-sha256",
    "signatureHeader": "x-webhook-signature",
    "timestampHeader": "x-webhook-timestamp",
    "signatureEncoding": "hex",
    "signaturePrefix": "sha256=",
    "signedTemplate": "{timestamp}.{raw}",
    "timestampToleranceSeconds": 300,
    "eventIdPath": "event.id",
    "eventTypePath": "event.type",
    "occurredAtPath": "event.createdAt"
  }
}
```

Regras:

- `algorithm` deve ser `hmac-sha256`;
- `signedTemplate` precisa conter `{raw}` e pode conter `{timestamp}`;
- ao usar `{timestamp}`, `timestampHeader` é obrigatório;
- encoding aceito: `hex` ou Base64 canônico;
- `signaturePrefix` é removido antes da decodificação;
- caminhos JSON aceitam segmentos alfanuméricos, `_` e `-`, separados por `.`;
- `eventIdPath` e `eventTypePath` devem resolver para string ou número;
- tolerância aceita: 30 a 3600 segundos.

Sem `timestampHeader`, o adaptador autentica o HMAC, mas a deduplicação é a
única proteção contra replay.

## Configuração comum da fonte

O objeto cifrado segue este schema:

```json
{
  "schemaVersion": 1,
  "signatureToleranceSeconds": 300,
  "job": {
    "type": "webhook.process",
    "priority": 100,
    "maxAttempts": 8
  },
  "provider": {}
}
```

Limites:

- `job.type`: 2 a 128 caracteres, iniciando por letra minúscula;
- `job.priority`: `0..1000`, onde o número menor é processado primeiro;
- `job.maxAttempts`: `1..100`;
- tolerância de assinatura: `30..3600` segundos.

O worker C#/.NET 8 possui handlers para `webhook.process`,
`process_webhook`, `deliver_event` e `reconcile_provider`. Para fontes novas,
prefira `webhook.process`.

As colunas da fonte ainda controlam:

- `rate_limit_per_minute`;
- `max_body_bytes`;
- retenção herdada do tenant;
- reconciliação e sua janela de 1 a 168 horas.

## Provisionar uma fonte

A role `sluice_api` não pode inserir fontes. O CLI de bootstrap usa a role
`sluice_dashboard` ou uma role de provisionamento equivalente, define o
contexto de um owner/admin, cifra segredo e configuração localmente e grava os
envelopes com o AAD correto.

No diretório `apps/ingest-api`:

```bash
npm ci

export SLUICE_BOOTSTRAP_DATABASE_URL='postgres://sluice_dashboard:senha@localhost:5432/sluice'
export SLUICE_MASTER_KEYS='1:BASE64_DE_32_BYTES'
export SLUICE_ACTIVE_KEY_VERSION='1'
export SLUICE_BOOTSTRAP_SECRET='segredo-com-ao-menos-16-bytes'
export SLUICE_BOOTSTRAP_CONFIG_JSON='{"schemaVersion":1,"job":{"type":"webhook.process","priority":100,"maxAttempts":8}}'

npm run bootstrap:source -- \
  --tenant-id 11111111-1111-4111-8111-111111111111 \
  --actor-user-id 22222222-2222-4222-8222-222222222222 \
  --provider stripe \
  --name "Stripe produção"
```

No PowerShell, use `$env:NOME='valor'` no lugar de `export`.

Flags:

| Flag | Obrigatória | Observação |
|---|---:|---|
| `--tenant-id` | sim | tenant já existente |
| `--actor-user-id` | sim | owner/admin ativo do tenant; também é gravado na auditoria |
| `--provider` | sim | `asaas`, `pagbank`, `mercado-pago`, `mercado_pago`, `stripe` ou `pix` |
| `--name` | não | nome de desenvolvimento por padrão |
| `--source-id` | não | UUID gerado quando omitido |
| `--endpoint-key` | não | UUID opaco gerado quando omitido |

O banco reaplica RLS e autorização usando `app.tenant_id`/`app.user_id`; um UUID
arbitrário sem membership administrativa é recusado. O resultado JSON informa
`sourceId`, `endpointKey` e `webhookPath`. Não registre o segredo no histórico
do shell; em produção, injete-o no processo por um secret manager e descarte o
ambiente depois do provisionamento.

## Envelopes e rotação

Segredo e configuração usam AES-256-GCM com contexts distintos:

```text
webhook-source-secret:{tenant_id}:{source_id}
webhook-source-config:{tenant_id}:{source_id}
```

`key_version` da linha deve coincidir com `kid` dos dois envelopes. Durante
rotação, mantenha a versão antiga em `SLUICE_MASTER_KEYS` até que todas as
fontes e eventos tenham sido recifrados. Nunca substitua o material de uma
versão existente.

## Falhas esperadas

| Condição | HTTP |
|---|---:|
| assinatura inválida | `401` |
| timestamp fora da janela | `401` |
| JSON/schema inválido | `400` |
| fonte desconhecida, desativada ou de outro provedor | `404` |
| mesmo ID externo com outro payload | `409` |
| limite por fonte excedido | `429` |
| Redis indisponível em fail-closed | `503` |

Detalhes completos de request e response estão em [API HTTP](api.md).
