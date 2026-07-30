# Changelog

Todas as mudanças relevantes do Sluice serão registradas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
o projeto pretende adotar [Versionamento Semântico](https://semver.org/lang/pt-BR/)
quando iniciar releases públicas.

## [Unreleased]

### Adicionado

- API de ingestão em Node.js 22, TypeScript e Fastify.
- Adaptadores autenticados para Stripe, Mercado Pago, Asaas, PagBank e Pix
  configurável.
- Deduplicação durável e criação transacional de evento/job no PostgreSQL.
- Worker C#/.NET 8 com claim, lease, heartbeat, fencing, retry e dead-letter.
- Handlers .NET para entrega HTTPS, reconciliação e notification outbox.
- Envelope encryption AES-256-GCM interoperável entre API, dashboard e worker.
- Proteção SSRF com HTTPS, allowlist, validação DNS/IP e redirects desativados.
- Dashboard operacional Next.js 16.2.12 e React 19.2.8 com modo demo e modo
  conectado PostgreSQL/RLS, indicadores reais de saúde, fila, retenção,
  auditoria e reconciliação.
- Schema multi-tenant com RLS forçado, auditoria append-only e RBAC.
- Purge de payload, rollups, reconciliação e recuperação de leases via
  `pg_cron`.
- Imagens Docker sem privilégios e Compose de PostgreSQL/Redis.
- Testes de contratos SQL, API, providers, criptografia, worker e dashboard.
- Fluxo E2E conectado para as 11 rotas da console e os provedores Asaas,
  PagBank, Mercado Pago, Stripe e Pix, cobrindo assinatura, deduplicação,
  conflito e ciclo de recursos auditado.
- CI para Node.js 22, .NET 8, PostgreSQL 17, CodeQL e auditoria de
  dependências.
- Overlay de produção com PostgreSQL TLS 1.3 obrigatório, validação de CA por
  API, dashboard e Npgsql, além de imagens-base fixadas por digest.
- Licença Apache 2.0, política de segurança, guia de contribuição e
  documentação operacional.

### Segurança

- Roles separadas e SCRAM para API, worker, dashboard e leitura.
- Fencing token obrigatório em transições de job e outbox.
- Segredos e payloads omitidos de logs e métricas.
- Sessão administrativa assinada, `HttpOnly`, `SameSite=Strict` e `Secure` em
  produção.
- Portas do overlay de desenvolvimento vinculadas exclusivamente a
  `127.0.0.1`; readiness do dashboard consulta o PostgreSQL.
- Next.js 16.2.12 e React 19.2.8 adotados no lugar da referência inicial
  Next.js 14 para hardening; `postcss` 8.5.23 e `sharp` 0.35.3 fixados por
  overrides auditáveis.

As datas e tags serão adicionadas na primeira release publicada.
