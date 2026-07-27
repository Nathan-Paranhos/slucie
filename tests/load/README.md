# Teste de carga

O cenário k6 envia webhooks Stripe sintéticos, corretamente assinados, com IDs
únicos. Execute apenas em um ambiente descartável e com uma fonte criada para
teste.

```bash
SLUICE_BASE_URL=https://sluice.test.example \
SLUICE_ENDPOINT_KEY=00000000-0000-0000-0000-000000000000 \
SLUICE_SIGNING_SECRET='segredo-da-fonte-de-teste' \
k6 run tests/load/stripe-webhook.js
```

O perfil sobe gradualmente a 100 requisições por segundo, sustenta a carga e
mede p95/p99. Ajuste metas conforme hardware e SLO. Durante o teste acompanhe:

- idade e profundidade da fila;
- conexões e locks no PostgreSQL;
- latência/erros Redis;
- duração de ingestão;
- CPU, memória e GC do worker C#;
- retry e dead-letter.

Não reutilize segredo de produção e não grave payload real no script.
