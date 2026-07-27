# Roadmap

O objetivo é tornar o Sluice uma base open source confiável para ingestão e
processamento de webhooks self-hosted. Este roadmap expressa direção, não
promessa de prazo. Issues e pull requests devem manter as garantias de
multi-tenancy, retenção, idempotência e o núcleo de processamento em
C#/.NET 8.

## Antes da primeira release

- fixar actions do CI por commit para builds estritamente reproduzíveis;
- adicionar SBOM e image scan;
- documentar imagens e tags imutáveis;
- validar restore, purge e redrive em um ambiente descartável;
- executar teste de carga de ingestão e workers concorrentes;
- realizar revisão independente de segurança e isolamento RLS;
- definir política de compatibilidade de migrations e APIs.

## Série 0.1 — Fundação operacional

- estabilizar contratos HTTP e SQL existentes;
- ampliar testes de crash entre entrega externa e confirmação local;
- testar key rotation com envelopes de versões simultâneas;
- adicionar dashboards e regras Prometheus de exemplo;
- melhorar ferramentas de bootstrap de instância, usuários e fontes;
- validar adapters contra fixtures oficiais versionadas dos provedores.

## Série 0.2 — Extensibilidade segura

- SDK/contrato para handlers adicionais em C#;
- API administrativa versionada com escopos e auditoria;
- providers adicionais guiados por demanda da comunidade;
- recifragem em lotes com checkpoint e relatório auditável;
- exportação/importação segura de configuração sem segredos em texto;
- políticas de retenção por categoria de evento;
- webhooks de operação e notificações com templates versionados.

## Série 0.3 — Escala e disponibilidade

- testes contínuos de milhões de jobs e múltiplas réplicas .NET;
- estratégia de particionamento para eventos, jobs e auditoria;
- documentação de PostgreSQL HA, PITR e failover;
- suporte operacional a Redis TLS/Sentinel sem torná-lo fonte de verdade;
- upgrade/rollback testado entre releases adjacentes;
- ferramentas de diagnóstico de backlog e leases sem acesso a payload.

## Identidade e acesso

Itens candidatos, dependentes de threat model e contribuição:

- OIDC/SAML para o dashboard;
- MFA completo;
- sessões revogáveis;
- service accounts e API keys com escopo;
- integração com secret managers e KMS/HSM.

Esses itens não devem ser simulados por flags inseguras. Até serem
implementados, o dashboard administrativo deve ficar atrás de VPN,
identity-aware proxy ou outro controle de acesso do operador.

## Fora do escopo padrão

- substituir PostgreSQL por uma fila de mensagens;
- armazenar jobs ou payloads duráveis no Redis;
- prometer “exactly once” para HTTP;
- aceitar URL arbitrária de destino/reconciliação sem allowlist;
- tornar Node.js o runtime do processamento de jobs;
- acoplar o projeto a um serviço SaaS obrigatório.

## Como influenciar prioridades

Abra uma issue descrevendo:

- cenário e volume reais;
- risco de segurança/privacidade;
- impacto em compatibilidade e migrations;
- comportamento de falha e rollback;
- disponibilidade para contribuir com implementação e testes.

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) antes de propor mudança de
arquitetura.
