# Manual Técnico e de Manutenção — SelfMinifier

Este manual descreve a implementação atual do SelfMinifier 0.4.1, seus contratos persistidos e os gates de manutenção. Fontes autoritativas: Markdown em `Documentacao\Fonte` e especificações em `Especificacoes`; HTML é gerado e não é editável como autoridade.

## 1. Arquitetura e bootstrap

O fluxo é `Executar.cmd → Executar.ps1 → PowerShell UI → Node CLI → núcleo`. A UI apresenta escolhas e confirmações; regras de scanner, configuração, minificação, integridade e transação permanecem fora do PowerShell. `src/app/bridge.mjs` coordena configuração, análise, execução, restauração, histórico, logs e relatórios por mensagens estruturadas. Stack traces não seguem para a UI.

`src/runtime/environment.js` valida Node, npm, `package.json`, lockfile, dependências locais e uma transformação funcional pelo esbuild empacotado. A política aceita explicitamente Node 24.x e 25.x, prefere 24 LTS e rejeita majors futuras. O bootstrap normal é offline: não executa `npm ci` nem `npm install`. A árvore de runtime do pacote é criada separadamente em staging por `npm ci --omit=dev`.

`Start-SelfMinifierUi` distingue configuração ausente de inválida e mantém backups, restauração e histórico nos menus restritos. O feedback da UI é factual, sem percentuais inventados; análise e resultado permanecem visíveis até continuação do usuário.

## 2. Configuração e schemas

`src/configuration` lê INI UTF-8, rejeita duplicidades, versões desconhecidas e estruturas mistas, e aceita somente `VersaoSchema=2` ou `3`. V2 usa `_source_versions`; V3 acrescenta `backupRoot` (`PastaBackups`) ou `null`. `deriveEffectiveConfiguration()` aceita apenas o override temporário de `outputMode`.

`update-backup-root` é a única transição V2→V3: valida caminho externo, grava atomicamente, relê e prova que campos não relacionados permaneceram iguais. `resolveEffectiveBackupRoot()` é a autoridade única para raiz interna ou externa. Não há migração, correção ou fallback silencioso.

A criação inicial exige `projectRoot` explícito, valida diretório físico e grava padrões canônicos por `writeV2Configuration`; depois relê e valida pelo caminho normal. INI existente e modelo `.example` nunca são sobrescritos automaticamente.

## 3. Scanner, motores e minificação

`src/scanner` percorre a raiz em modo read-only, aplica seleção fechada CSS/JavaScript, exclusões técnicas, deduplicação de identidade física e rejeição de links/reparse points conforme o contrato. `src/minifiers` define o contrato neutro e o registry atual contém somente o adapter esbuild, sem bundling. Os perfis `Conservador`, `Padrao` e `Maximo` são intenções traduzidas pelo adapter; `Personalizado` falha fechado.

O planner cria uma pré-análise imutável, com fingerprint, escopo, hashes, destinos, conflitos e risco. Antes de escrever, o bridge reanalisa e exige equivalência com o plano confirmado. Destinos `.min` preexistentes usam `skip-existing` e nunca são sobrescritos.

## 4. Execução transacional, Tag e SHA-256

No modo de sobrescrita, a sequência é: hash da fonte, criação e validação do backup, minificação temporária, validação do resultado, alocação do `artifactId`, inserção da Tag, hash dos bytes finais e substituição segura no mesmo caminho. No modo `.min`, o rollback remove somente destinos criados e registrados.

`src/execution/executor.js` mantém journal write-ahead em `Dados\Restauracao\ultima-execucao.bkp`, persistido por temporário durável e rename antes das mutações. Interrupção, divergência ou rollback não comprovável leva a `recovery-required` e bloqueia nova mutação.

`src/integrity/selfminifier-tag.js` aplica `/*! SelfMinifier-Tag: <artifactId> */`, depois de shebang JavaScript ou `@charset` CSS quando presente. `artifactId` tem 96 bits aleatórios, é hexadecimal maiúsculo e aparece no histórico. A Tag é identidade, não prova de integridade: o SHA-256 é calculado sobre os bytes finais completos, incluindo a Tag. Tag conhecida com hash divergente, desconhecida, múltipla ou inválida fica fora da execução automática.

Contratos novos registram `selfMinifierVersion`. Histórico e journal de execução usam `formatVersion: 2`; manifesto GZIP usa `formatVersion: 3`; estado e journal de restauração permanecem em `formatVersion: 1`. O manifesto grava o hash da fonte e o payload GZIP comprova o conteúdo descompactado.

## 5. Backups, histórico e proveniência

`src/integrity/history.js` mantém um JSON UTF-8 imutável por execução concluída em `Dados\Historico\<executionId>.json`, sem índice global. O registro conserva versão, execução, artefato, Tag, caminhos, hashes, modo, motor/perfil e raiz efetiva de backup. `Dados\estado.json` é somente estado técnico atual e não substitui o histórico.

`src/restore/index.js` lista candidatos por snapshot histórico efêmero, sem abrir manifesto, payload ou montar plano profundo. A validação profunda ocorre após seleção e reconfirma autoridade, manifesto, mapeamento, hashes, identidade física, destino e estado imediatamente antes da mutação. Backups internos legados podem ser descobertos, mas formatos históricos não comprovados não recebem fallback.

A raiz e o caminho relativo gravados pela execução são a autoridade histórica. A configuração atual e `PastaBackups` atual não substituem essa proveniência. Somente manifesto `formatVersion: 3` com GZIP é suportado para recuperação histórica; ausência, raiz indisponível, manifesto inválido, payload ausente, hash divergente e formato não suportado são estados distintos.

## 6. Restauração e recuperação histórica

A restauração normal planeja e executa reposição de fontes ou remoção da última saída `.min` criada. Operações `replace-output` são não aplicáveis à restauração `.min`; ausências, alterações, recusas, sucessos e falhas continuam rastreadas. `restauracao-em-andamento.bkp` mantém progresso manual.

`src/history/index.js` implementa `searchHistoryByTag`, `searchHistoryByPath`, `inspectHistoricalArtifact` e `recoverHistoricalOriginal`. A pesquisa varre `Dados\Historico` sequencialmente e ordena caminhos do mais recente para o mais antigo sem fabricar cadeia de revisões. A recuperação exige hash de entrada compatível, backup GZIP íntegro, pai físico seguro e destino absoluto inexistente; usa `createNewFileExact`, não sobrescreve e não altera origem, saída, estado ou journal.

## 7. Segurança do filesystem e observabilidade

Caminhos de projeto, backup, destino e limpeza são provados lexical e fisicamente. Symlink, junction, reparse point, alias, troca de identidade, readonly inesperado e raiz inacessível bloqueiam ou preservam o item. Cada mutação confirmada tem rastreamento recuperável.

`src/observability/index.mjs` grava logs em `Dados\Logs` e relatórios TXT/CSV em `Dados\Relatorios`. As operações históricas reutilizam `writeTechnicalLog`; falha de logging não mascara o diagnóstico funcional e conteúdo de arquivos não é registrado.

`previewArtifactCleanup` produz snapshot somente em memória com nome canônico, tamanho e SHA-256. `executeArtifactCleanup` revalida identidade física, arquivo regular, hash e readonly antes de `removeExactFile`. Só entram `tecnico-*.log`, `execucao-*.txt` e `execucao-*.csv`; o resultado é `completed` ou `partial`. Não há retenção automática de histórico, backups, logs ou relatórios.

Diretórios relevantes: `Dados\Historico` (metadados), `Dados\Restauracao` (journals e temporários de transação), `Dados\Temporarios` (exclusão técnica do scanner), `_source_versions` (backup interno) e `PastaBackups` (raiz externa V3, sem índice global).

## 8. Documentação, testes e qualidade

As fontes ficam em `Documentacao\Fonte\Manual-Usuario\README.md` e `Documentacao\Fonte\Manual-Tecnico\README.md`. `npm.cmd run build:docs` lê essas fontes, incorpora `Documentacao\Assets\manual.css` e gera HTML offline com `lang="pt-BR"`, charset UTF-8 e viewport. O gerador é deliberadamente leve; não há CDN, fonte externa, analytics ou dependência remota.

Use testes focados com `npm.cmd test -- test/docs.test.js` e os testes diretamente afetados. `scripts/quality/check-encoding.mjs` verifica UTF-8, mojibake e CRLF dos launchers. O build não deve editar Markdown nem ser substituído por patch manual no HTML.

## 9. Qualificação, empacotamento e publicação estável

`publicar.cmd` delega a `scripts\release\publicar.ps1`. O pipeline valida ambiente, versão única de `package.json`, lockfile, dependências, UTF-8, testes, documentação e allowlist de conteúdo, então monta `dist\SelfMinifier-<version>`, ZIP e SHA-256. O pacote contém runtime produzido em staging limpo e uma única raiz versionada; não inclui dados locais, testes, especificações, `_ias` ou dependências de desenvolvimento.

Qualificação, commit, push, pacote, tag e release são gates separados. Esta documentação não altera versão, tag, release ou artefato. A publicação estável deve reutilizar exatamente o artefato localmente validado e manter a identidade `package.json.version = pasta = ZIP = checksum = tag`.

## 10. Limites atuais e roadmap diferido

O suporte atual é Windows x64, Windows PowerShell 5.1, Node 24/25 e esbuild para JavaScript/CSS. Não há fallback implícito de motor, suporte multiplataforma, perfil Personalizado, retenção automática, arquivamento histórico ou limiar mínimo de redução.

Permanecem diferidos: compatibilidade de plataforma (DT-MP), compatibilidade de motores (DT-ME), lifecycle/arquivamento histórico (D3/D4), progresso real baseado em eventos (F5) e hardening para 1.0 (H1). Nenhum item autoriza schema, fallback, migração, índice, tombstone, motor ou plataforma novos sem requisitos e qualificação explícitos.