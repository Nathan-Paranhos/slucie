# Política de segurança

## Como reportar

Não abra uma issue pública para vulnerabilidades. Envie um relato para
`nathan@aithostech.com.br`. Quando o repositório publicado exibir a opção
**Report a vulnerability** na aba Security, o Private Vulnerability Reporting
também poderá ser usado.

Inclua, quando possível:

- versão, commit e forma de implantação;
- pré-condições e impacto;
- passos mínimos para reprodução;
- prova de conceito sem dados reais de terceiros;
- mitigação sugerida.

Não envie segredos, payloads pessoais ou dumps de produção. Você receberá uma
confirmação inicial em até cinco dias úteis. Prazos de correção e divulgação
serão combinados conforme gravidade e complexidade.

## Escopo

São especialmente relevantes:

- bypass de autenticação de provider;
- quebra de RLS ou leitura entre tenants;
- execução arbitrária, SSRF ou injeção SQL;
- vazamento de segredos, KEKs, payloads ou credenciais;
- bypass de fencing/idempotência com efeito financeiro duplicado;
- falha de purge que retenha dados além da política;
- dependências comprometidas no caminho de build.

Relatos de indisponibilidade volumétrica sem bypass de limite, ausência de
headers em ambiente exclusivamente local e versões sem suporte podem não ser
tratados como vulnerabilidade.

## Versões suportadas

Enquanto não houver uma release estável, somente o branch principal recebe
correções. Após a primeira release, este quadro será atualizado:

| Versão | Suporte |
|---|---|
| `main` | desenvolvimento ativo |
| releases anteriores | ainda não aplicável |

## Práticas esperadas do operador

O modelo seguro requer:

- HTTPS público e TLS nas conexões de dados em produção;
- roles diferentes para API, worker, dashboard e leitura;
- KEK fora do PostgreSQL, do repositório e dos backups;
- rotação de segredos e revogação imediata após incidente;
- rede privada para PostgreSQL e Redis;
- allowlist de egress para handlers e reconciliação;
- backup, PITR e restore drills;
- revisão das configurações de cada provider.

Detalhes estão em [docs/security.md](docs/security.md).
