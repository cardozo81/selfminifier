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
- A versão atual é `0.3.0`, com `package.json` como autoridade única; nomes de pasta, ZIP e checksum são derivados dessa versão.
- O pacote local usa uma raiz `SelfMinifier-<version>` e allowlist de launcher, manifestos npm, módulos `src`, recursos, modelo de configuração, documentação HTML gerada e dependências de runtime produzidas por instalação limpa em staging, sem copiar `node_modules` de desenvolvimento nem conteúdo local.
- O risco de execução 0.1.0 usa matriz determinística por modo/perfil nos níveis `Baixo`, `Moderado`, `Alto` e `Critico`; destinos `.min` preexistentes são preservados e ignorados pelo planejamento V2, quantidade de arquivos é escopo separado e risco indeterminado bloqueia sem autorização substituta.
- Launchers `.cmd` distribuídos usam CRLF validado por bytes. O SelfMinifier não contorna nem reduz a Execution Policy; `Restricted` bloqueia com orientação para o manual offline.
- A inicialização normal da distribuição é offline com Node homologado e dependências empacotadas válidas; dependências ausentes ou divergentes bloqueiam sem `npm ci` ou instalação silenciosa.

Os detalhes normativos de cada decisão pertencem aos documentos temáticos indicados por `_ias/INDEX.md`.

## Identidade de versão

- A política segue SemVer; a versão pré-1.0 atual é `0.3.0`, derivada exclusivamente de `package.json`, formando pasta, ZIP e checksum. As tags `v0.2.0-rc.1`, `v0.2.0-rc.2` e `v0.2.0-rc.3` e os GitHub Releases `0.2.0-rc.1`, `0.2.0-rc.2` e `0.2.0-rc.3` já foram publicados como PRERELEASE.
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

## Evoluções estratégicas pendentes (dívidas técnicas)

Duas evoluções futuras possuem a mesma prioridade estratégica de planejamento e permanecem deliberadamente fora da implementação atual (F4/`0.2.0`). Ambas são insumo autoritativo para a futura fase de definição de requisitos; nenhuma delas está implementada e nenhuma decisão em aberto deve ser tratada como aprovada.

| Identificador | Evolução | Escopo temático |
| --- | --- | --- |
| DT-MP | Compatibilidade de plataforma — suportar plataformas explicitamente qualificadas sem enfraquecer integridade | `01-PREMISSAS.md`, `04-ARQUITETURA.md` |
| DT-ME | Compatibilidade de motores — suportar N adaptadores explicitamente homologados sem acoplar o núcleo | `07-MINIFICACAO-E-MOTORES.md`, `04-ARQUITETURA.md` |

### Relação estratégica

```text
STRATEGIC COMPATIBILITY EVOLUTION

DT-MP — Platform compatibility
└── support explicitly qualified platforms without weakening integrity

DT-ME — Engine compatibility
└── support N explicitly homologated adapters without coupling the core
```

### Invariantes

- O Windows permanece o único suporte atual validado; multiplataforma é trabalho futuro e não é alegação de produto atual.
- O esbuild permanece o único motor atualmente homologado; nenhum candidato é homologado por mera plausibilidade técnica.
- Conveniência multiplataforma nunca deve enfraquecer integridade, recuperação ou garantias fail-closed existentes.
- Não há fallback implícito de motor; os princípios fail-closed permanecem autoritativos.

### Decisões em aberto (não decididas)

- **DT-MP:** quais sistemas operacionais adicionais serão suportados primeiro; versões mínimas; permanência do PowerShell como tecnologia de UI fora do Windows; existência de nova abstração de UI; formato de launcher, instalador e pacote; detalhes de implementação de filesystem; regras de migração de caminhos; cadência de release por plataforma.
- **DT-ME:** quais motores adicionais serão suportados; se Terser, SWC, Lightning CSS ou outro candidato será homologado; número total de motores; seleção global versus seleção por tipo de arquivo; schema final de configuração; representação `MotorJavaScript`/`MotorCSS` ou equivalente; estratégia de migração da configuração existente; motor padrão por tipo; política de fallback; limiares de benchmark; detalhes da política de deprecação/remoção de motores; versões exatas de futuras dependências.

Nenhum desses pontos deve ser preenchido com valor inventado; pertencem à futura fase de definição de requisitos.

## Dívida técnica de desempenho — listagem de backups (DT-BL) — implementada

O diagnóstico H1-P1 encontrou validação profunda antes da seleção: aproximadamente 5 s para um backup com dois arquivos e 19 s para três backups, varreduras históricas de estilo O(N²) e provas físicas/reparse repetidas por candidato.

O DT-BL foi implementado sem alterar proveniência, formato ou autoridade: a listagem cria uma fotografia histórica validada, imutável e somente em memória por operação. Ela descobre candidatos e deriva sua autoridade do snapshot; não chama o planejador de restauração, não abre manifesto/estado/payload, não calcula SHA de payload ou destino, não descompacta GZIP e não classifica o arquivo atual. Itens apenas descobertos retornam como `unverified`; uma proveniência histórica estruturalmente inválida continua bloqueada.

A validação profunda começa em `createBackupRestorePlan` após a seleção e continua obrigatória antes da restauração: autoridade e raiz históricas, manifesto, mapeamentos, links/reparse, payload raw/GZIP, SHA-256, estado e classificação do destino. A execução ainda revalida o gate de segurança, identidade física, journal write-ahead, destino e payload imediatamente antes da mutação.

### Evidência quantitativa local

No mesmo ambiente Windows e com fixture temporária equivalente de dois arquivos por backup, `listKnownBackups` mediu 805,744 ms para um backup e 893,883 ms para três backups. O plano profundo isolado para um backup/dois arquivos mediu 3.347,717 ms, demonstrando que a prova foi adiada para a seleção, não removida.

Estruturalmente, a listagem faz uma leitura completa de `Dados\Historico` por contexto/operação; `findHistoricalBackupAuthority` consulta esse snapshot uma vez por candidato, sem nova varredura; `createBackupRestorePlan` é chamado zero vezes na listagem. As únicas provas físicas remanescentes na lista são as necessárias para validar o histórico e descobrir a raiz interna; não há provas de manifesto, payload ou destino por candidato. A contagem de processos `fsutil.exe` não é exposta como métrica pela aplicação e não foi artificialmente instrumentada.

Não foi criado índice persistente, fallback para configuração atual, token de bridge ou nova fonte de verdade. Não há SLA ou limiar de desempenho inventado.
