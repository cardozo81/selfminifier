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
- A pesquisa histórica varre sequencialmente `Dados\Historico` por Tag/`artifactId` ou caminhos de metadados, sem índice global. A recuperação histórica é uma exportação exclusiva para destino explícito e seguro: usa somente a raiz de backup registrada na execução, valida manifesto v3 GZIP e hashes históricos coerentes, classifica outros formatos como não suportados, nunca sobrescreve o arquivo atual e permanece separada da restauração normal.
- Symlinks e junctions não são seguidos automaticamente na versão 1.
- Toda mutação confirmada deve possuir rastreamento recuperável correspondente.
- O desenvolvimento é incremental, assistido por IA e realizado diretamente em `main`, sem branch por tarefa e sem pull request no fluxo atual.
- Testes são focados, proporcionais e introduzidos junto com os comportamentos.
- Commits e pushes representam checkpoints significativos e validados, não microalterações.
- As dependências `ini@7.0.0` e `esbuild@0.28.2` foram introduzidas em versões exatas e estão bloqueadas no lockfile; versões futuras são selecionadas quando cada dependência for introduzida e devem permanecer reproduzíveis.
- O diretório temporário interno do runtime é `Dados\Temporarios\` e permanece uma exclusão técnica obrigatória do scanner.
- O rastreamento resistente a interrupções usa journal JSON UTF-8 write-ahead em `Dados\Restauracao\ultima-execucao.bkp`, persistido por temporário durável e `rename` antes das mutações registradas.
- O runtime Node.js exige major mínima 24 e suporta explicitamente as linhas 24 e 25, prefere 24 LTS e autoriza instalação automática somente da versão `24.19.0` pelo pacote winget `OpenJS.NodeJS.LTS`; chamadas npm no PowerShell usam `npm.cmd`. Majors futuras não listadas falham fechado.
- A versão atual é `0.4.1`, com `package.json` como autoridade única; nomes de pasta, ZIP e checksum são derivados dessa versão.
- O pacote local usa uma raiz `SelfMinifier-<version>` e allowlist de launcher, manifestos npm, módulos `src`, recursos, modelo de configuração, documentação HTML gerada e dependências de runtime produzidas por instalação limpa em staging, sem copiar `node_modules` de desenvolvimento nem conteúdo local.
- O risco de execução 0.1.0 usa matriz determinística por modo/perfil nos níveis `Baixo`, `Moderado`, `Alto` e `Critico`; destinos `.min` preexistentes são preservados e ignorados pelo planejamento V2, quantidade de arquivos é escopo separado e risco indeterminado bloqueia sem autorização substituta.
- Launchers `.cmd` distribuídos usam CRLF validado por bytes. O SelfMinifier não contorna nem reduz a Execution Policy; `Restricted` bloqueia com orientação para o manual offline.
- A inicialização normal da distribuição é offline com Node homologado e dependências empacotadas válidas; dependências ausentes ou divergentes bloqueiam sem `npm ci` ou instalação silenciosa.

Os detalhes normativos de cada decisão pertencem aos documentos temáticos indicados por `_ias/INDEX.md`.

## Identidade de versão

- A política segue SemVer; a versão pré-1.0 atual é `0.4.1`, derivada exclusivamente de `package.json`, formando pasta, ZIP e checksum. As tags `v0.2.0-rc.1`, `v0.2.0-rc.2` e `v0.2.0-rc.3` e os GitHub Releases `0.2.0-rc.1`, `0.2.0-rc.2` e `0.2.0-rc.3` já foram publicados como PRERELEASE.
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

## Roadmap técnico diferido após 0.4.0

A partir da stable `0.4.0`, as evoluções abaixo ficam deliberadamente **deferidas**. O objetivo imediato é colocar a `0.4.0` em uso controlado no Windows e coletar evidência real de defeitos, limitações e melhorias funcionais antes de ampliar novamente o produto.

Esse registro define somente o escopo mínimo necessário para retomada futura por execução humana ou assistida por IA. Não autoriza implementação automática, não fixa versão futura e não transforma hipóteses em requisitos aprovados.

### Uso controlado da 0.4.0

- A `0.4.0` é a stable oficial para uso controlado no escopo Windows atualmente homologado.
- Projetos relevantes devem manter proteção externa independente, como controle de versão e/ou backup apropriado ao contexto de uso.
- Observações reais devem ser classificadas antes de qualquer correção como defeito reproduzível, melhoria funcional, melhoria de UX, oportunidade de desempenho ou watch item de ambiente/filesystem.
- Uma ocorrência isolada sem reprodução não justifica alteração preventiva do core.
- Evidência coletada em uso controlado pode repriorizar o roadmap, mas não deve provocar expansão automática de escopo.

### D3/D4 — lifecycle histórico, remoção controlada e arquivamento

**Objetivo mínimo:** permitir reduzir o custo físico de payloads históricos sem apagar sua existência lógica nem enfraquecer proveniência, recuperação ou auditabilidade.

Fases mínimas para retomada:

1. **Estudo e contrato:** inspecionar histórico, backup e recuperação atuais; definir invariantes, compatibilidade com registros antigos e semântica mínima para disponibilidade, arquivamento, remoção e indisponibilidade. Não assumir previamente tombstone, catálogo, ZIP, relocation ou novo schema.
2. **Implementação controlada:** somente após contrato aprovado, introduzir as operações e persistência estritamente necessárias; preservar metadados históricos permanentes, registrar transições relevantes e provar integridade/localização de conteúdo arquivado quando aplicável.
3. **Validação proporcional:** testes focados nas novas invariantes, compatibilidade histórica e safety gates afetados; full suite, packaging e smoke somente no gate de release, se houver publicação.

Invariantes de partida: `RESTORED != INVALID`; remoção deliberada não pode ser indistinguível de desaparecimento inesperado; payload removido não apaga a existência histórica da execução.

### F5 — progresso real baseado em eventos

**Objetivo mínimo:** oferecer feedback de operações demoradas somente com unidades/eventos concretos, sem porcentagem artificial.

Fases mínimas para retomada:

1. **Contrato e implementação mínima:** mapear operações longas, definir eventos concretos entre Node, bridge e UI e manter progresso transitório separado de eventos históricos persistentes.
2. **Validação proporcional:** testar emissão/ordem dos eventos e ausência de regressão funcional; executar full suite apenas no gate de release.

Não criar fake progress, sleeps artificiais ou persistência histórica de telemetria apenas para alimentar a UI.

### DT-ME — compatibilidade de motores

**Objetivo mínimo:** desacoplar o núcleo de detalhes específicos do esbuild por contrato de adaptador, mantendo somente motores explicitamente homologados.

Fases mínimas para retomada:

1. **Contrato de engine:** definir capabilities, tipos de arquivo, entrada/saída, falhas, timeout, versão, configuração relevante, integração com Tag/SHA e proveniência. Não escolher motores adicionais por conveniência.
2. **Implementação:** encapsular o esbuild no contrato aprovado e adicionar outro motor somente quando houver requisito e qualificação suficientes para provar a arquitetura multi-engine.
3. **Qualificação:** testes de conformidade por adaptador, falhas fail-closed, integridade e matriz dos motores declarados como suportados.

Não existe fallback implícito entre motores.

### DT-MP — compatibilidade multiplataforma

**Objetivo mínimo:** tornar o núcleo portável e suportar somente plataformas executadas e qualificadas em ambiente real, preservando integralmente as proteções de filesystem.

Fases mínimas para retomada:

1. **Auditoria de acoplamento ao Windows:** identificar paths, shell, PowerShell, atributos, reparse/junction, packaging e demais semânticas específicas; isolar contratos de plataforma sem regredir o Windows.
2. **Qualificação Linux:** implementar apenas diferenças comprovadas e executar testes em ambiente Linux real antes de declarar suporte.
3. **Qualificação macOS:** executar testes em ambiente macOS real antes de declarar suporte; desenvolvimento/orquestração pode continuar em Windows, mas simulação Windows não homologa macOS.
4. **Matriz de suporte:** documentar explicitamente quais plataformas e versões foram de fato qualificadas.

Windows pode continuar sendo o ambiente principal das IAs e do desenvolvimento; uma plataforma adicional só pode ser declarada suportada após execução e qualificação reais nessa plataforma.

### H1 — hardening e preparação para 1.0

**Objetivo mínimo:** consolidar o produto existente, sem usar o marco 1.0 como justificativa para adicionar funcionalidades não requeridas.

Fases mínimas para retomada:

1. **Auditoria final:** identificar blockers reais, drift documental, gaps de teste e divergências entre suporte declarado e comprovado.
2. **Correções:** tratar somente blockers e inconsistências necessárias para a baseline 1.0.
3. **Qualificação:** executar a matriz final aplicável de plataformas, motores, compatibilidade histórica, instalação limpa, backup/restauração, lifecycle e demais operações declaradas como suportadas.

A versão `1.0.0` somente deve ser proposta depois que seu conjunto de requisitos estiver explicitamente fechado e comprovado.

## Dívida técnica de desempenho — listagem de backups (DT-BL) — implementada

O diagnóstico H1-P1 encontrou validação profunda antes da seleção: aproximadamente 5 s para um backup com dois arquivos e 19 s para três backups, varreduras históricas de estilo O(N²) e provas físicas/reparse repetidas por candidato.

O DT-BL foi implementado sem alterar proveniência, formato ou autoridade: a listagem cria uma fotografia histórica validada, imutável e somente em memória por operação. Ela descobre candidatos e deriva sua autoridade do snapshot; não chama o planejador de restauração, não abre manifesto/estado/payload, não calcula SHA de payload ou destino, não descompacta GZIP e não classifica o arquivo atual. Itens apenas descobertos retornam como `unverified`; uma proveniência histórica estruturalmente inválida continua bloqueada.

A validação profunda começa em `createBackupRestorePlan` após a seleção e continua obrigatória antes da restauração: autoridade e raiz históricas, manifesto, mapeamentos, links/reparse, payload raw/GZIP, SHA-256, estado e classificação do destino. A execução ainda revalida o gate de segurança, identidade física, journal write-ahead, destino e payload imediatamente antes da mutação.

### Evidência quantitativa local

No mesmo ambiente Windows e com fixture temporária equivalente de dois arquivos por backup, `listKnownBackups` mediu 805,744 ms para um backup e 893,883 ms para três backups. O plano profundo isolado para um backup/dois arquivos mediu 3.347,717 ms, demonstrando que a prova foi adiada para a seleção, não removida.

Estruturalmente, a listagem faz uma leitura completa de `Dados\Historico` por contexto/operação; `findHistoricalBackupAuthority` consulta esse snapshot uma vez por candidato, sem nova varredura; `createBackupRestorePlan` é chamado zero vezes na listagem. As únicas provas físicas remanescentes na lista são as necessárias para validar o histórico e descobrir a raiz interna; não há provas de manifesto, payload ou destino por candidato. A contagem de processos `fsutil.exe` não é exposta como métrica pela aplicação e não foi artificialmente instrumentada.

Não foi criado índice persistente, fallback para configuração atual, token de bridge ou nova fonte de verdade. Não há SLA ou limiar de desempenho inventado.
