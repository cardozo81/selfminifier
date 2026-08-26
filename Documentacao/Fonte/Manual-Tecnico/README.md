# Manual Técnico - SelfMinifier

## Arquitetura implementada

O fluxo de dependências é `PowerShell → Node CLI → núcleo`. `Executar.ps1` executa o bootstrap e carrega `src/app/ui.ps1`; a interface chama `src/app/bridge.mjs` por JSON. A camada PowerShell apresenta escopo e confirmações, mas não aplica regras de scanner, minificação, integridade ou transação.

O bridge coordena configuração, análise, execução, restauração, logs e relatórios. Diagnósticos estruturados são retornados sem stack traces para a interface; detalhes técnicos seguem para logs.

A UI consolida análise e execução em **Minificar projeto**. Cada entrada nesse fluxo cria uma tabela local de ajustes temporários; o override de `outputMode` alcança análise e execução, mas é descartado ao sair. A prévia usa lotes de 10 somente quando há 11 ou mais candidatos e expõe apenas controles de navegação válidos. A execução revalida o fingerprint apresentado antes de qualquer mutação.

## Configuração e domínio

`src/configuration` lê UTF-8 estrito, aceita exatamente `VersaoSchema=2` e `VersaoSchema=3`, detecta chaves duplicadas e rejeita V1, versões desconhecidas e estruturas mistas. V2 conserva a raiz interna `<applicationRoot>\_source_versions`; V3 acrescenta `backupRoot`, correspondente a `PastaBackups`, como caminho externo validado ou `null` para semântica interna. `deriveEffectiveConfiguration()` aceita somente o override temporário de `outputMode`.

Edições de raiz/tipos/exclusões/perfil e de `outputMode` preservam o schema carregado. O bridge `update-backup-root` é a única transição V2→V3: valida o caminho externo, grava atomicamente, relê e comprova que campos não relacionados permaneceram iguais. Limpar a raiz mantém V3 com `backupRoot=null`; não há migração automática nem downgrade silencioso.

`resolveEffectiveBackupRoot()` é a autoridade única: V2 e V3 interno resolvem para a pasta controlada pela aplicação; V3 externo resolve para `backupRoot`. O INI real permanece em `Configuracao\configuracao.ini`; o modelo V2 fica em `Configuracao\configuracao.ini.example`. Não há fallback silencioso para dados inválidos.

## Scanner e minificação

`src/scanner` percorre a raiz V2 em modo read-only, aplica a seleção fechada CSS/JavaScript, deduplica identidades físicas e reporta links, readonly e exclusões técnicas. `src/minifiers` define o contrato neutro e compõe o registry homologado com o adapter esbuild. O adapter suporta JavaScript e CSS; perfis `Conservador`, `Padrao` e `Maximo` são traduzidos internamente. `Personalizado` falha fechado porque seu schema ainda não existe.

## Integridade, backup e execução

`src/integrity` fornece SHA-256, JSON UTF-8 atômico, estado técnico, manifesto e cópias de backup validadas. O modo de sobrescrita grava em `<effectiveBackupRoot>/<executionId>/<originId>/<relativePath>.gz` e mantém `manifest.json` (formato 2) na pasta da execução. O payload é compactado com GZIP e a prova de integridade continua sendo o SHA-256 do conteúdo descompactado, que deve coincidir com o SHA-256 da origem. A raiz é provada antes do plano e revalidada por caminho canônico e identidade física antes de cada backup; desaparecimento ou troca bloqueia sem fallback.

`src/execution/planner.js` cria uma pré-análise imutável. `src/execution/executor.js` usa journal write-ahead em `Dados\Restauracao\ultima-execucao.bkp`: plano, intenção, mutação, hash final, estado e conclusão. Para `.min`, destinos preexistentes são preservados por `skip-existing`; o rollback remove somente caminhos exatos criados e registrados. `recovery-required` é usado quando o rollback não pode ser comprovado sem adivinhação.

`src/integrity/history.js` mantém a autoridade histórica em `Dados\Historico\<executionId>.json`, um registro UTF-8 formatVersion 1 por execução concluída e sem índice global. Cada artefato produzido recebe `artifactId` de 96 bits por `crypto.randomBytes(12)`, em hexadecimal maiúsculo. Estado atual, journal e manifesto novos podem referenciar essa identidade; formatos antigos sem o campo permanecem válidos.

`src/integrity/selfminifier-tag.js` controla a sintaxe fechada `/*! SelfMinifier-Tag: <artifactId> */`, sua inspeção e a inserção depois de shebang JavaScript ou `@charset` CSS. O planner consulta sequencialmente `Dados\Historico` pelo `artifactId`: Tag conhecida e SHA-256 completo coincidente é classificada como já minificada mesmo após rename/cópia; conteúdo divergente, Tag desconhecida, múltipla ou inválida fica fora da execução automática. Sem Tag, a compatibilidade legada por estado/caminho/hash permanece.

O executor aloca o `artifactId` somente na fase segura de execução, insere a Tag na saída minificada e calcula `outputHash` sobre os bytes finais completos, sem retirar ou normalizar a Tag. `expectedOutputHash`, `minifiedHash`, `outputHash` e `minifiedSha256` recebem o mesmo valor onde aplicáveis. O histórico também conserva os hashes, a raiz efetiva e o caminho relativo do backup, com `compression: gzip` para novos backups e `compression: none` para legados raw. O manifesto continua em `formatVersion: 2` por representar GZIP; estado, journal, journal de restauração e histórico permanecem em `formatVersion: 1`.

## Pesquisa e recuperação histórica

`src/history/index.js` implementa os casos de uso read-only `searchHistoryByTag`, `searchHistoryByPath`, `inspectHistoricalArtifact` e a mutação separada `recoverHistoricalOriginal`. A autoridade continua sendo a varredura sequencial de `Dados\Historico\<executionId>.json`; não existe índice persistente. A busca por caminho ordena explicitamente por data, execução e `artifactId`, sem fabricar revisão ou continuidade de identidade.

A inspeção separa fatos persistidos de observações atuais. Arquivo atual deliberadamente informado passa por prova física, inspeção da Tag e SHA-256 dos bytes completos. A disponibilidade do backup usa `backupRoot` e `backupRelativePath` históricos, cruza manifesto e histórico, lê v1 raw ou v2 GZIP pelas primitivas existentes e não consulta `PastaBackups` atual como fallback.

`recoverHistoricalOriginal` exige `inputHash === backup.originalHash`, payload íntegro, pai físico seguro e destino absoluto inexistente. A criação exclusiva reutiliza `createNewFileExact` e confirma o hash final. Origem e saída históricas são destinos proibidos; nenhum estado, journal ou arquivo atual é modificado. `backup.available=false` bloqueia com `HISTORICAL_BACKUP_UNAVAILABLE`.

O bridge expõe `search-history-by-tag`, `search-history-by-path`, `inspect-historical-artifact` e `recover-historical-original`. Cada chamada registra no logger técnico existente comando, duração, status, código de bloqueio e metadados compactos; conteúdo de arquivos não é registrado. Falha de logging não altera o contrato funcional nem mascara o diagnóstico original.

`src/app/ui.ps1` apresenta essas operações no submenu do item principal **Backups e restauração**, sem renumerar o menu. As opções de restauração normal continuam chamando `plan-restore`/`execute-restore`; pesquisa por Tag e por caminho conduz a uma inspeção que separa o registro persistido das observações atuais. A recuperação só aparece quando `recoveryCapability=true`, exige destino explícito inexistente e confirmação numérica, e chama `recover-historical-original` como exportação separada. Cancelar ou voltar não dispara operação.

## Restauração manual

`src/restore/index.js` combina diretórios internos legados e registros históricos. Quando há histórico, ele define a pasta esperada; uma raiz externa indisponível permanece listada como `unavailable` e bloqueia sem substituição. O plano cruza histórico, manifesto, `artifactId`, hash, caminho original, mapeamento de origem e estado; a execução revalida raiz física e payload antes da mutação.

A restauração `.min` lê somente a última execução concluída e remove apenas operações `create-output`. Operações `replace-output` são registradas como não aplicáveis. Saídas ausentes, alteradas, recusadas, restauradas ou excluídas permanecem rastreadas. O progresso manual é persistido em `Dados\Restauracao\restauracao-em-andamento.bkp`; um estado incompleto ou `recovery-required` bloqueia nova mutação.

## Logs, relatórios e diretórios de dados

`src/observability/index.mjs` produz logs técnicos em `Dados\Logs` e relatórios TXT/CSV em `Dados\Relatorios`. As quatro operações históricas reutilizam `writeTechnicalLog` para sucesso e bloqueio, sem criar outro subsistema. Relatórios não expõem stack traces e preservam motivos de itens ignorados ou pulados. A visualização pelo menu é read-only.

Diretórios técnicos relevantes:

- `Dados\estado.json`: registros de fontes e saídas comprovadas.
- `Dados\Historico`: metadados históricos imutáveis por execução concluída; não contém payload de backup.
- `Dados\Temporarios`: área técnica excluída pelo scanner.
- `Dados\Restauracao`: journal de execução, journal de restauração e cópias transitórias.
- `_source_versions`: raiz interna compatível para backups V2 e V3 sem pasta externa.
- `PastaBackups`: raiz física externa opcional em V3; não contém índice global e não recebe migração automática.

Não há política automática de retenção ou remoção histórica.

## Runtime e bootstrap

`src/runtime/environment.js` valida Node, npm, package/lock, dependências locais e uma transformação funcional curta pelo esbuild empacotado. A política em `resources/runtime-policy.json` exige major mínima 24 e aceita explicitamente Node 24.x e 25.x; 24 é a linha LTS preferida, 25 é suportada sem preferência, e majors futuras não listadas falham fechado. A instalação interativa aprovada continua sendo `24.19.0` por winget. O bootstrap nunca executa `npm ci`/`npm install`: dependência ausente, divergente ou runtime de plataforma inoperante bloqueia. A publicação produz `node_modules` de runtime por `npm ci --omit=dev` em staging descartável e a inicialização normal usa essa árvore offline.

A confirmação da UI carrega a impressão digital SHA-256 do plano mostrado. O bridge refaz a pré-análise imediatamente antes de executar e bloqueia se escopo, hashes, destinos, conflitos ou demais condições confirmáveis divergirem.

O risco de execução é calculado deterministicamente por modo e perfil antes da confirmação. Destinos `.min` preexistentes são preservados e ignorados, portanto não elevam o risco V2; escopo de arquivos é metadado separado. Não existe autorização substituta para risco indeterminado.

Use `npm.cmd` no PowerShell para evitar bloqueio de `npm.ps1` pela política de execução.

## Plataforma suportada

A plataforma suportada e testada nesta RC é Windows. A validação usou Windows 11 Pro x64 (arquitetura AMD64/x64), Node.js v24.17.0 e Windows PowerShell 5.1. O produto e os testes exercitam Windows PowerShell 5.1; PowerShell 7/Core não é assumido equivalente automaticamente e não foi validado como substituto. A prova de reparse point no Windows usa `fsutil.exe`. A instalação autorizada de Node pode usar `winget`.

A política de Node exige major mínima 24 e aceita as linhas 24.x e 25.x, com 24 LTS preferida. Não há, nesta RC, validação ou suporte declarado para: versão mínima do Windows, RAM mínima, CPU mínima, espaço em disco mínimo, ARM64, Linux ou macOS. Esses pontos não foram validados e não devem ser assumidos como suportados.

## UTF-8, qualidade e desenvolvimento

Texto humano e artefatos documentais usam UTF-8. `scripts/quality/check-encoding.mjs` valida arquivos textuais, exige fisicamente finais de linha CRLF nos launchers `.cmd` do working tree (rejeitando LF isolado, CR isolado e misturas) e detecta sequências conhecidas de mojibake; o A-circunflexo isolado é aceito como legítimo, e só é caracterizado como mojibake CP1252 quando seguido de caractere não ASCII. O projeto usa `node:test` com fixtures temporárias para configuração, scanner, execução, integridade, observabilidade e restauração.

O desenvolvimento ocorre diretamente em `main`, com commits validados e allowlist explícita de arquivos ao preparar um checkpoint. Não use `git add .`, force-push, fallback silencioso ou exclusão por curingas.

## Documentação offline

As fontes autoritativas ficam em `Documentacao\Fonte`. Execute `npm.cmd run build:docs` para gerar HTML local em `Documentacao\Gerada`. O build não acessa a rede, não modifica o Markdown e usa `Documentacao\Assets\manual.css`; o HTML gerado não substitui as fontes Markdown nem as especificações.

## Empacotamento local

`publicar.cmd` delega para `scripts\release\publicar.ps1`. O pipeline valida ambiente, versão `package.json`, package/lock, dependências, UTF-8, testes e documentação antes de montar uma allowlist em `dist\SelfMinifier-<version>`. Em seguida valida o conteúdo, cria um ZIP com uma única raiz versionada e grava o SHA-256 correspondente.

O pacote inclui launcher, manifestos npm, `src`, `resources`, modelo de configuração, HTML offline e `node_modules` de runtime gerado de forma limpa. Exclui testes, especificações, `_ias`, scripts de desenvolvimento, dados locais, configuração pessoal, backups, `node_modules` do checkout e `dist` anterior. O `Executar.cmd` empacotado é validado em CRLF e respeita a Execution Policy, bloqueando sob `Restricted` sem bypass. O empacotamento não publica GitHub Release.

## Dívida futura (não implementada)

Os itens a seguir são registrados como planejamento futuro e não estão implementados nesta RC.

- Linux e macOS: prioridade futura Linux, depois macOS se viável. A arquitetura desejada é um núcleo SelfMinifier compartilhado com adaptador por plataforma. Não há implementação nem suporte parcial declarado nesta RC.
- Retenção e limpeza: estudo futuro sobre metadados históricos, backups, logs, relatórios e gestão de espaço. A prioridade de preservação é metadados de proveniência sobre payloads grandes de backup. Não há limpeza automática nesta RC.
- Arquivamento/remoção histórica: se dados históricos ou payload de backup forem arquivados, compactados ou removidos, a pesquisa por SelfMinifier-Tag não deve transformar silenciosamente um artefato conhecido em UNKNOWN. Uma solução futura deve reportar, quando aplicável: artefato existiu, artifactId/SelfMinifier-Tag, execução original, ação de retenção, timestamp da ação, status atual, local do arquivo/ZIP, disponibilidade de recuperação e perda explícita do payload quando removido. Arquiteturas futuras possíveis: (A) preservar o JSON histórico e remover somente o payload grande; (B) arquivar registros históricos completos e deixar catálogo/tombstone; (C) deixar tombstone reduzido em `Dados\Historico`; (D) catálogo de retenção explícito. Nada de índice persistente, tombstone, formato de arquivo ou fluxo de limpeza é implementado agora.
