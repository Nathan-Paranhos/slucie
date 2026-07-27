# Sluice Dashboard

Console operacional do Sluice, construída com Next.js 16.2.12, React 19.2.8 e
PostgreSQL.

A especificação visual inicial citava Next.js 14. O repositório usa a linha de
manutenção 16.2.12 por hardening e correções de segurança, sem alterar a
identidade, o modelo RLS ou os contratos operacionais do produto. O lockfile
também fixa `postcss` 8.5.23 e `sharp` 0.35.3 por overrides auditáveis.

## Identidade

- display: Manrope;
- interface: Inter;
- dados e IDs: JetBrains Mono;
- ação e destaque: `#FF6B00`;
- base: grafite/preto e branco;
- cores funcionais são reservadas para feedback de estado.

O logo e o personagem são SVGs próprios e permanecem legíveis sem imagens
externas.

## Modo demo

```bash
cp .env.example .env.local
npm ci
```

Edite `.env.local`:

```dotenv
SLUICE_DEMO_MODE=true
SLUICE_SESSION_SECRET=development-session-secret-with-at-least-32-characters
SLUICE_COOKIE_SECURE=false
SLUICE_DEMO_EMAIL=admin@sluice.local
SLUICE_DEMO_PASSWORD=sluice-demo
DATABASE_URL=
```

O conteúdo do modo demo não consulta PostgreSQL. O readiness, porém, verifica
qualquer `DATABASE_URL` configurada; para uma demonstração isolada, deixe-a
vazia. Execute:

```bash
npm run dev
```

Abra `http://localhost:3000` e use:

- e-mail: `admin@sluice.local`;
- senha: `sluice-demo`.

Dados e mutações são simulados. Nunca habilite o modo demo em produção.

## Modo conectado

Configure:

```dotenv
SLUICE_DEMO_MODE=false
SLUICE_SESSION_SECRET=replace-with-a-random-secret-of-at-least-32-characters
SLUICE_COOKIE_SECURE=true
DATABASE_URL=postgresql://sluice_dashboard:senha@postgres:5432/sluice
DATABASE_SSL=true
DATABASE_SSL_REJECT_UNAUTHORIZED=true
DATABASE_SSL_CA_FILE=/run/secrets/postgres_ca_cert
DASHBOARD_DB_POOL_SIZE=8
```

Cada operação de tenant usa uma transação e define
`app.tenant_id`/`app.user_id` localmente. Isso impede que o contexto sobreviva
à reutilização da conexão pelo pool e permite que o PostgreSQL aplique RLS.

O primeiro acesso conectado requer:

- usuário ativo em `sluice.users` com hash Argon2id;
- tenant em `sluice.tenants`;
- vínculo owner/admin/operator/viewer em `sluice.tenant_memberships`.

A função `sluice.bootstrap_first_owner` cria esses três registros apenas em
uma instância vazia. O procedimento completo está em
[Desenvolvimento local](../../docs/local-development.md#modo-conectado).

Owner/admin podem criar e ativar/desativar fontes, destinos e pipelines, criar
tenants e fazer redrive. Operator/viewer têm acesso de leitura conforme a UI e
as políticas RLS. Redrive cria outro job e é recusado quando o payload original
já foi purgado.

## Segurança de produção

- mantenha `SLUICE_DEMO_MODE=false`;
- use segredo de sessão aleatório e rotacione-o com plano de expiração;
- termine HTTPS em proxy confiável e mantenha cookie `Secure`;
- conecte com `sluice_dashboard`, sem propriedade de tabelas e sem
  `BYPASSRLS`;
- habilite TLS e verificação da CA no PostgreSQL;
- proteja a console por rede privada/VPN ou identity-aware proxy;
- não exponha a administração à internet como substituto de MFA/SSO.

O campo de MFA existe no domínio, mas o fluxo completo de segundo fator ainda
não está implementado.

## Verificação

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` executa o build standalone e um teste end-to-end do modo demo.

## Imagem

A partir da raiz do repositório:

```bash
docker build -f apps/dashboard/Dockerfile \
  -t sluice-dashboard:local apps/dashboard
```

O container final usa o output standalone, executa como usuário sem
privilégios e expõe a porta `3000`. O health check usa `/api/health`.

Consulte também [API HTTP](../../docs/api.md#api-interna-do-dashboard) e
[Operação](../../docs/operations.md).
