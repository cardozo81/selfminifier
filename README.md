# SelfMinifier

Status atual: versão `0.2.0-rc.2`, com interface interativa, minificação transacional, restauração manual segura, documentação offline e empacotamento local validado.

O SelfMinifier (anteriormente Meminify) tem como objetivo oferecer minificação segura e controlada de arquivos JavaScript e CSS. O projeto é direcionado ao Windows, com interface interativa em PowerShell e execução baseada em Node.js.

As exigências autoritativas do produto ficam em [`Especificacoes/`](Especificacoes/). O desenvolvimento é incremental e assistido por IA, com mudanças pequenas, explícitas e validadas.

No fluxo atual, uma única pessoa trabalha diretamente na branch `main`. Git registra histórico, pontos de recuperação e marcos úteis; não há branches por tarefa nem pull requests automáticos.

## Navegação

- [`Especificacoes/`](Especificacoes/): fonte autoritativa de requisitos e decisões.
- [`_ias/INDEX.md`](_ias/INDEX.md): roteador de contexto para agentes de IA.
- [`_ias/MAPA-CODIGO.md`](_ias/MAPA-CODIGO.md): mapa evolutivo da implementação.
- [`CHANGELOG.md`](CHANGELOG.md): alterações relevantes do projeto.
- [`Documentacao/Fonte/`](Documentacao/Fonte/): fontes Markdown dos manuais.

Use `Executar.cmd` para iniciar o menu PowerShell. O menu principal consolidado oferece **Minificar projeto**, **Configurações**, **Backups e restauração**, **Relatórios** e **Logs técnicos**. Em **Minificar projeto**, o ajuste temporário opcional de modo segue para análise, prévia dos candidatos, revalidação por fingerprint e execução, sem alterar a configuração persistente. Para gerar os manuais HTML offline, execute `npm.cmd run build:docs`; as fontes Markdown são autoritativas e os arquivos gerados ficam em `Documentacao/Gerada`.

Já existem domínio/configuração, adapter esbuild, scanner read-only, integridade SHA-256, matriz determinística de risco de execução, execução transacional, bootstrap Windows, menu PowerShell, restauração manual, logs, relatórios e empacotamento local. O perfil `Personalizado` e a retenção automática permanecem pendentes; o GitHub Release `0.2.0-rc.1` já foi publicado como PRERELEASE.

Use `publicar.cmd` para gerar localmente `dist/SelfMinifier-0.2.0-rc.2.zip` e seu checksum SHA-256. O SelfMinifier 0.2.0-rc.2 suporta Node.js 24.x (LTS recomendado) e 25.x; a major mínima é 24 e majors futuras não são aceitas automaticamente. Com Node homologado, o início normal é offline e nunca executa `npm ci` nem `npm install`; dependência ausente ou divergente bloqueia e exige reextrair uma distribuição íntegra. O `publicar.cmd` pode preparar as dependências locais do checkout com `npm ci` somente após confirmação explícita. Esse fluxo não publica GitHub Release.
