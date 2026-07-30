# Contribuindo com o Sluice

Obrigado por melhorar o Sluice. Buscamos mudanças pequenas, verificáveis e
compatíveis com operação self-hosted.

## Antes de começar

Para correções pequenas, abra diretamente um pull request. Para mudanças de
arquitetura, schema público, protocolo de provider ou comportamento de
privacidade, abra uma issue com:

- problema e cenário real;
- alternativas consideradas;
- impacto em segurança, multi-tenancy, retenção e compatibilidade;
- plano de migração e rollback.

Vulnerabilidades não devem ser publicadas em issues. Siga
[SECURITY.md](SECURITY.md).

## Ambiente

1. Instale Git, Docker Engine 24+, Docker Compose 2.24+, Node.js 22,
   SDK .NET 8, GNU Make e OpenSSL.
2. Copie `.env.example` para `.env` e substitua as credenciais.
3. Gere uma KEK local com `openssl rand -base64 32`.
4. Execute `make up` ou o comando Compose descrito no README.
5. Instale as dependências Node com `npm ci` em `apps/ingest-api` e
   `apps/dashboard`.
6. Rode `make test` antes do pull request. O alvo valida Compose, migrations e
   contratos SQL, API, dashboard em modo demo e worker C#.
7. Para mudanças no dashboard conectado, banco, fontes, provedores ou fluxo de
   entrega, suba a stack e rode também `SLUICE_CONNECTED_E2E=1 npm run
   test:connected` em `apps/dashboard`. O cenário usa dados de teste e executa
   limpeza lógica, preservando a auditoria append-only.

## Regras de implementação

- Preserve PostgreSQL como fonte de verdade da fila.
- Redis aceita somente estado efêmero.
- Toda tabela com dados de tenant deve ter `tenant_id`, FK composta quando
  referenciar outra tabela multi-tenant, RLS e teste de isolamento.
- Funções `SECURITY DEFINER` precisam de `search_path` fixo, privilégio mínimo,
  `REVOKE ... FROM PUBLIC` e teste.
- Não copie payload bruto para `jobs`, logs, auditoria ou métricas.
- Não registre segredos, tokens, assinaturas ou corpos de webhook.
- Alterações de schema são migrations aditivas e repetíveis. Nunca edite uma
  migration já publicada em uma release.
- Handlers são at-least-once e precisam de chave de efeito idempotente.
- Textos e componentes visuais devem seguir a identidade grafite, branco e
  laranja `#FF6B00`, com contraste acessível.

## Commits e pull requests

Use commits objetivos e inclua testes. No pull request, descreva:

- o comportamento anterior e o novo;
- como foi validado;
- risco e rollback;
- screenshots para mudanças de interface;
- migration e impacto de lock para mudanças de banco.

Ao contribuir, você declara ter direito de licenciar a contribuição sob Apache
2.0. Recomendamos assinar commits com o Developer Certificate of Origin:

```text
Signed-off-by: Seu Nome <seu-email@example.com>
```

## Critérios de revisão

Uma mudança só é considerada pronta quando:

- lint, testes e build passam;
- isolamento entre dois tenants foi exercitado quando aplicável;
- falha/retry/crash recovery foram testados em mudanças da fila;
- o E2E conectado foi executado quando a mudança alcança a console, fonte,
  autenticação, webhook ou fluxo de entrega;
- documentação e `.env.example` refletem novas configurações;
- não há regressão de retenção, criptografia ou auditoria.
