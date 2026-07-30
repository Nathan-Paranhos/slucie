# Liberação para produção

Este checklist é um bloqueio de liberação: marcar uma etapa sem executar a
evidência correspondente não torna a instalação segura.

## Identidade: OIDC com MFA obrigatório

O dashboard exige OIDC quando `NODE_ENV=production`. Configure um cliente
confidencial no provedor corporativo e registre exatamente:

```text
https://console.seu-dominio.com/api/session/oidc/callback
```

Defina no secret manager (nunca no Git):

```text
SLUICE_OIDC_ISSUER=https://id.seu-dominio.com
SLUICE_OIDC_CLIENT_ID=...
SLUICE_OIDC_CLIENT_SECRET=...
SLUICE_OIDC_REQUIRED_ACR=...
```

`SLUICE_OIDC_REQUIRED_ACR` deve ser o valor que o IdP somente emite após MFA
válido. O Sluice confere `issuer`, `audience`, assinatura JWKS, `nonce`, PKCE,
`email_verified` e o ACR. O e-mail do token precisa pertencer a um usuário
ativo com membership ativo no banco; o IdP não cria nem eleva usuários.

Evidência de aceite: login local rejeitado, login SSO sem MFA rejeitado, login
SSO com MFA aceito, usuário removido do tenant bloqueado na próxima autenticação.

## Egress do worker

O worker já valida HTTPS, hostname permitido, DNS/IP público e desativa
redirects. A rede deve impor a mesma política: permita somente TCP/443 do
segmento `worker_egress` para os IPs/FQDNs dos destinos aprovados; negue todo o
restante, inclusive RFC1918, loopback, metadata e DNS não corporativo.

Em Kubernetes, implemente isso com `NetworkPolicy` mais um proxy de egress que
aplica allowlist por SNI/FQDN. Em VM/Compose, aplique a regra no firewall do
host ou em firewall dedicado; a bridge Docker não consegue aplicar uma
allowlist de FQDN com segurança. Teste uma entrega aprovada e confirme que
conexões para um IP privado e um domínio não listado falham.

## Backup, WAL e restore drill

Use uma ferramenta de backup físico compatível com PostgreSQL 17 (por exemplo,
pgBackRest ou WAL-G) para enviar base backup e WAL a armazenamento externo
criptografado e imutável. O destino, as credenciais e o KMS são específicos da
infraestrutura e não são configurados por este repositório.

Antes de liberar, registre RPO/RTO e execute em rede isolada:

1. restaure um base backup e avance até um ponto no tempo escolhido;
2. recupere as KEKs históricas do secret manager separado;
3. rode `database/tests/contracts.sql` no banco restaurado;
4. valide RLS, os jobs `pg_cron`, readiness e uma ingestão sintética;
5. confirme que o evento criado depois do ponto de recuperação não aparece;
6. guarde data, operador, duração, hash/ID do backup e resultado.

O release é bloqueado se o restore drill tiver mais de 90 dias ou exceder o
RTO acordado.

## Pentest e verificação contínua

O repositório executa CI, CodeQL, revisão de dependências e auditoria de
dependências. Eles não substituem um pentest. Contrate um teste independente
com escopo mínimo: dashboard/OIDC, endpoints de webhook, isolamento entre
tenants, SSRF/egress, rate limit, retenção/LGPD e configuração de proxy TLS.

Só libere após corrigir achados críticos/altos ou obter aceite de risco formal
do responsável. Anexe ao release o escopo, data, versão/commit testado e plano
de correção; não anexe payloads, segredos ou dados pessoais.

## Cenário integrado obrigatório

Além das verificações unitárias, contratos SQL e builds, execute o E2E
conectado contra a imagem/Compose candidata antes da liberação:

```bash
cd apps/dashboard
SLUICE_CONNECTED_E2E=1 npm run test:connected
```

O cenário requer um owner/admin ativo e valida dashboard conectado, autorização,
ações auditadas, reconciliação e os cinco adaptadores de webhook. Registre no
artefato de release as URLs de ambiente, o commit/imagens testados, data e
resultado, sem incluir a sessão temporária, senhas, segredos ou payloads.
