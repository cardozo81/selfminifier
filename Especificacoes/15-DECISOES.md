# Decisões

## Aprovadas

- O produto é voltado ao Windows, com interface interativa planejada em PowerShell e aplicação em Node.js.
- O comportamento é fail-closed e a integridade dos arquivos tem prioridade máxima.
- Conteúdo destinado a pessoas usa pt-BR; arquivos textuais usam UTF-8; mojibake é proibido.
- A versão 1 suporta JavaScript e CSS por meio do esbuild homologado, sem bundling.
- Perfis são intenções neutras traduzidas apenas por adaptadores.
- Existem exatamente dois modos de saída: sobrescrita com backup validado e preservação da fonte com saída `.min`.
- SHA-256 é a prova primária de integridade; timestamps e aparência visual não substituem essa prova.
- `Dados\Historico\<executionId>.json` é a autoridade histórica imutável, sem índice global; `artifactId` usa 96 bits criptograficamente aleatórios e identifica o artefato, enquanto `estado.json` permanece estado atual. `SelfMinifier-Tag` contém exatamente esse `artifactId`; o SHA-256 dos bytes finais completos, incluindo a Tag, comprova integridade e impede reminificação automática quando a proveniência não coincide.
- A pesquisa histórica varre sequencialmente `Dados\Historico` por Tag/`artifactId` ou caminhos de metadados, sem índice global. A recuperação histórica é uma exportação exclusiva para destino explícito e seguro: usa somente a raiz de backup registrada na execução, valida manifesto v1 raw ou v2 GZIP e hashes históricos coerentes, nunca sobrescreve o arquivo atual e permanece separada da restauração normal.
- Symlinks e junctions não são seguidos automaticamente na versão 1.
- Toda mutação confirmada deve possuir rastreamento recuperável correspondente.
- O desenvolvimento é incremental, assistido por IA e realizado diretamente em `main`, sem branch por tarefa e sem pull request no fluxo atual.
- Testes são focados, proporcionais e introduzidos junto com os comportamentos.
- Commits e pushes representam checkpoints significativos e validados, não microalterações.
- As dependências `ini@7.0.0` e `esbuild@0.28.2` foram introduzidas em versões exatas e estão bloqueadas no lockfile; versões futuras são selecionadas quando cada dependência for introduzida e devem permanecer reproduzíveis.
- O diretório temporário interno do runtime é `Dados\Temporarios\` e permanece uma exclusão técnica obrigatória do scanner.
- O rastreamento resistente a interrupções usa journal JSON UTF-8 write-ahead em `Dados\Restauracao\ultima-execucao.bkp`, persistido por temporário durável e `rename` antes das mutações registradas.
- O runtime Node.js exige major mínima 24 e suporta explicitamente as linhas 24 e 25, prefere 24 LTS e autoriza instalação automática somente da versão `24.19.0` pelo pacote winget `OpenJS.NodeJS.LTS`; chamadas npm no PowerShell usam `npm.cmd`. Majors futuras não listadas falham fechado.
- A versão de desenvolvimento atual é `0.2.0-rc.2`, com `package.json` como autoridade única; nomes de pasta, ZIP e checksum são derivados dessa versão.
- O pacote local usa uma raiz `SelfMinifier-<version>` e allowlist de launcher, manifestos npm, módulos `src`, recursos, modelo de configuração, documentação HTML gerada e dependências de runtime produzidas por instalação limpa em staging, sem copiar `node_modules` de desenvolvimento nem conteúdo local.
- O risco de execução 0.1.0 usa matriz determinística por modo/perfil nos níveis `Baixo`, `Moderado`, `Alto` e `Critico`; destinos `.min` preexistentes são preservados e ignorados pelo planejamento V2, quantidade de arquivos é escopo separado e risco indeterminado bloqueia sem autorização substituta.
- Launchers `.cmd` distribuídos usam CRLF validado por bytes. O SelfMinifier não contorna nem reduz a Execution Policy; `Restricted` bloqueia com orientação para o manual offline.
- A inicialização normal da distribuição é offline com Node homologado e dependências empacotadas válidas; dependências ausentes ou divergentes bloqueiam sem `npm ci` ou instalação silenciosa.

Os detalhes normativos de cada decisão pertencem aos documentos temáticos indicados por `_ias/INDEX.md`.

## Identidade de versão

- A política segue SemVer; a versão pré-1.0 atual é `0.2.0-rc.2`, derivada exclusivamente de `package.json`, formando pasta, ZIP e checksum; a tag `v0.2.0-rc.1` e o GitHub Release `0.2.0-rc.1` já foram publicados como PRERELEASE.
- Tags são imutáveis; uma publicação futura reutiliza exatamente os artefatos validados, e a distribuição gerada permanece fora do Git.

## Raiz de instalação e caminhos persistentes

A raiz de instalação é derivada da localização dos módulos distribuídos, não do diretório de trabalho atual nem de `src/app`. Configuração, `Dados`, backups, estado, journals, logs, relatórios, temporários e demais recursos relativos ao aplicativo permanecem sob essa raiz; o diretório de trabalho do usuário pode ser arbitrário.

## Convenção de encoding do PowerShell

Scripts PowerShell (`.ps1`/`.psm1`) executados pelo Windows PowerShell usam UTF-8 com BOM para interpretação confiável de pt-BR; Node.js, JSON, Markdown e demais formatos seguem sua codificação UTF-8 apropriada.

## Pendentes

As seguintes decisões permanecem deliberadamente sem valor inventado. A área futura indicada orienta a próxima consolidação:

- política de retenção automática de backups — recuperação e backup;
- políticas de retenção automática de logs e relatórios — logs e relatórios;
- eventual limiar mínimo de redução para aceitar um resultado — minificação e qualidade;
- opções detalhadas permitidas no perfil `Personalizado` — perfis e adaptadores;
- versões exatas de futuras dependências — fase que introduzir cada dependência;

Esses pontos exigem decisão explícita em tarefa futura. Nenhum padrão, fallback ou valor deve ser inferido enquanto permanecerem pendentes.
