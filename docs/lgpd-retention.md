# Retenção e LGPD

O Sluice implementa minimização e expiração como comportamento obrigatório. A
configuração técnica não define, por si só, finalidade, base legal ou prazo
adequado para cada controlador.

## Inventário de dados

| Dado | Local | Proteção | Expiração |
|---|---|---|---|
| corpo bruto do webhook | `webhook_events.raw_body_envelope` | envelope AES-256-GCM | `purge_after` |
| ID externo reversível | `external_event_id_envelope` | envelope AES-256-GCM | junto do payload |
| hash do ID externo | `external_event_id_hash` | hash não reversível, mas potencialmente pseudônimo | política de metadados |
| hash do payload | `payload_hash` | hash | política de metadados |
| headers permitidos | `sanitized_headers` | allowlist + banco cifrado em disco recomendado | zerados no purge |
| argumentos/erros de job | `jobs`, `job_attempts` | não devem copiar payload | redigidos no purge |
| auditoria | `audit_log` | append-only/RLS | política organizacional |
| usuário administrativo | `users` | Argon2id para senha | ciclo de conta |

Segredos de assinatura e configuração de destino são credenciais, não payload,
e permanecem cifrados enquanto o recurso existir.

## Política de payload

Cada tenant possui `raw_payload_retention_days`, com padrão 90 e faixa técnica
de 1 a 3650 dias. O valor não pode desabilitar o purge.

Ao ingerir, o banco calcula `purge_after`. O `pg_cron` chama
`purge_expired_payloads` em lotes. A função:

- apaga o envelope do corpo e do ID externo;
- remove headers sanitizados;
- reduz argumentos de jobs a referência técnica e marcador de purge;
- redige mensagens de erro relacionadas;
- preserva hashes necessários à deduplicação;
- grava uma entrada de auditoria sem incluir dado pessoal.

Um evento purgado continua provando que houve recebimento e impede duplicação,
mas não permite reprocessamento do corpo. Dead-letter com payload purgado não
pode ser redriven.

## Metadados de deduplicação

`dedupe_metadata_retention_days` é separado e nunca menor que a retenção do
payload. O padrão de schema é 2555 dias para cenários financeiros, mas o
controlador deve revisar esse prazo e implementar a eliminação/anonimização
organizacional compatível com sua obrigação legal.

Hash não deve ser tratado automaticamente como dado anônimo: quando ainda pode
ser correlacionado a uma pessoa ou transação, é dado pseudonimizado.

## Solicitações do titular

O produto oferece blocos técnicos, não um portal jurídico completo. Um
procedimento operacional deve:

1. autenticar a solicitação e determinar o papel controlador/operador;
2. localizar tenants e referências com acesso privilegiado auditado;
3. evitar exportar segredo, credencial ou dado de outro titular;
4. aplicar acesso, correção, portabilidade ou eliminação conforme a decisão do
   controlador;
5. preservar somente registros exigidos, preferindo anonimização;
6. registrar decisão, operador, data e fundamento fora do payload.

Não procure titulares diretamente por hash sem uma entrada já conhecida e
autorizada. Não desabilite RLS para uma busca ampla no dashboard.

## Backup

Purge no banco primário não remove instantaneamente bytes de backups imutáveis.
A política precisa definir:

- janela de retenção de backup;
- criptografia e controle de acesso;
- prazo de expiração da mídia;
- comportamento após restore: migrations e purge devem rodar antes de liberar
  acesso;
- registro de destruição.

Manter a KEK fora do backup reduz exposição, mas sua disponibilidade precisa
ser protegida para recuperação legítima.

## Checklist do controlador

- finalidade e base legal documentadas por fonte;
- prazo configurado por categoria de evento;
- DPA e papéis entre Aithos/operador/tenant definidos;
- encarregado e canal de titulares definidos;
- registro de operações de tratamento atualizado;
- RIPD realizado quando aplicável;
- suboperadores e destinos externos inventariados;
- transferência internacional avaliada;
- incident response testado;
- restore e purge testados conjuntamente;
- métricas e logs livres de payload.
