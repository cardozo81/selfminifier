# Mapa do código

Este mapa registra somente arquivos que existem e suas responsabilidades reais.

## Fundação Node.js

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `package.json` | Metadados, modo ES module, scripts e dependências declaradas | `esbuild@0.28.2` |
| `package-lock.json` | Lockfile reproduzível das dependências | npm |
| `Configuracao/configuracao.ini.example` | Exemplo versionado da estrutura de configuração aprovada | Especificação 06 |
| `resources/minifier-registry.json` | Registro estático dos motores homologados da versão 1 | Especificação 07 |

## Domínio e configuração

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `src/domain/index.js` | Constantes de perfis, modos, schemas V2/V3, tipos de arquivo e defaults aprovados | Nenhuma |
| `src/configuration/errors.js` | Erro estruturado de configuração e códigos diagnósticos | Nenhuma |
| `src/configuration/utf8.js` | Leitura UTF-8 fatal e escrita atômica UTF-8 por temporário + rename | Node.js `fs/promises`, `util` |
| `src/configuration/parse.js` | Scanner INI compartilhado com detecção de seções/chaves duplicadas e linhas inválidas | `src/configuration/errors.js` |
| `src/configuration/v2.js` | Schema V2 congelado: parsing, validação, serialização e persistência | `src/domain/index.js`, `parse.js`, `schema.js`, `utf8.js` |
| `src/configuration/v3.js` | Schema V3: campos V2 + `PastaBackups`, parsing/serialização determinísticos e persistência | Módulos de configuração |
| `src/configuration/backup-root.js` | Validação externa, disjunção física e resolver autoritativo da raiz efetiva | Integridade física, runtime paths |
| `src/configuration/schema.js` | Identificação fail-closed de V2/V3, versões desconhecidas e estruturas antigas/mistas | `src/domain/index.js`, `parse.js` |
| `src/configuration/index.js` | API V2/V3 e configuração efetiva temporária limitada a `outputMode` | Módulos de configuração |

## Minificação

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `src/minifiers/minifier.js` | Contrato neutro, resultados e diagnósticos normalizados | Node.js `Buffer` |
| `src/minifiers/registry.js` | Leitura e validação do registry homologado, sem pacotes arbitrários | `resources/minifier-registry.json` |
| `src/minifiers/esbuild-adapter.js` | Validação, capabilities, tradução de perfis e transformação JS/CSS | `esbuild@0.28.2` |
| `src/minifiers/index.js` | Composição da registry padrão com o adapter esbuild | Módulos de minificação |

## Scanner

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `src/scanner/errors.js` | Erros estruturados do scanner | Nenhuma |
| `src/scanner/filesystem.js` | Descoberta read-only, exclusões técnicas, links, permissões e identidades físicas | Node.js `fs/promises`, `path` |
| `src/scanner/index.js` | Scanner V2-only: seleção CSS/JavaScript, deduplicação, exclusões e diagnósticos determinísticos | Módulos do scanner |

## Runtime e integridade

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `src/runtime/version.js` | Leitura compartilhada da identidade e versão autoritativa do `package.json` | Node.js `fs/promises` |
| `src/runtime/paths.js` | Raiz de instalação e caminhos técnicos normativos relativos ao runtime | Node.js `path`, `url` |
| `src/runtime/policy.js` | Leitura e validação da política Node.js homologada | `resources/runtime-policy.json` |
| `src/runtime/dependencies.js` | Validação de package/lock e dependências locais | Node.js `fs/promises` |
| `src/runtime/environment.js` | Descoberta/validação de Node/npm, sonda funcional do esbuild empacotado, instalação autorizada de Node via winget e bloqueio de runtime inválido | Node.js `child_process`, módulos runtime |
| `src/integrity/errors.js` | Erros estruturados de integridade | Nenhuma |
| `src/integrity/hash.js` | SHA-256 incremental de arquivos | Node.js `crypto`, `fs` |
| `src/integrity/json-store.js` | Leitura UTF-8 estrita e persistência JSON por arquivo temporário e rename | Node.js built-ins |
| `src/integrity/history.js` | `artifactId` criptográfico, schema histórico formatVersion 1, criação imutável, leitura, listagem e busca sequencial fail-closed | Node.js `crypto`, `fs/promises`, integridade |
| `src/integrity/physical-path.js` | Prova lexical/canônica, identidade física, rejeição nativa de reparse points e sonda de escrita exclusiva | Node.js built-ins, `fsutil.exe` no Windows |
| `src/integrity/schema.js` | Validação dos registros técnicos e entradas de manifesto | Módulos de integridade |
| `src/integrity/state.js` | Validação e persistência de `Dados/estado.json` | Módulos de integridade |
| `src/integrity/manifest.js` | Criação, validação e persistência do manifesto de backup | Módulos de integridade |
| `src/integrity/gzip.js` | GZIP/GUNZIP em streaming e prova do conteúdo descompactado | Node.js `zlib`, `stream/promises`, `fs` |
| `src/integrity/backup.js` | Mapeamento, identidade estável, cópia GZIP e validação SHA-256 do backup de fontes na raiz efetiva | Node.js `fs/promises`, `path`, `gzip.js` |
| `src/integrity/index.js` | API pública da fundação de integridade | Módulos de integridade |

## Pré-análise e execução transacional

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `src/execution/errors.js` | Erros estruturados de planejamento, execução e recuperação | Nenhuma |
| `src/execution/planner.js` | Pré-análise V2 imutável, destinos `.min`, `skip-existing`, hashes e confirmação de execução | Scanner, domínio e integridade |
| `src/execution/risk.js` | Matriz determinística de risco 0.1.0; o planner V2 calcula sem elevar destinos `.min` preservados | Domínio e erros de execução |
| `src/execution/journal.js` | Schema e persistência do journal write-ahead da última execução | Integridade e domínio |
| `src/execution/filesystem.js` | Criação/substituição exata, cópias de recuperação e provas SHA-256 | Node.js built-ins, integridade |
| `src/execution/recovery.js` | Rollback exato e recuperação determinística de execução interrompida | Journal, estado e filesystem transacional |
| `src/execution/executor.js` | Coordenação dos dois modos, minificação, estado, manifesto e rollback | Minificador, integridade e execução |
| `src/execution/index.js` | API pública de pré-análise e execução transacional | Módulos de execução |

## Bootstrap Windows

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `Executar.ps1` | Estabelece a raiz, oferece instalação autorizada quando Node falta e inicia o bootstrap Node | Windows PowerShell, `winget.exe` opcional |
| `Executar.cmd` | Lançador de duplo clique que delega de forma relativa para o PowerShell | Windows CMD, `Executar.ps1` |
| `src/bootstrap/cli.mjs` | Entrada leve do bootstrap, mensagens pt-BR e handoff somente se existir menu futuro | Módulos runtime |
| `resources/runtime-policy.json` | Política versionada de linhas e instalação Node homologadas | Especificação 07 |

## Interface interativa

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `src/app/bridge.mjs` | Bridge JSON para resumo, pré-análise, impressão digital do plano confirmado, execução e criação segura da configuração | Configuração, scanner e execução |
| `src/app/ui.ps1` | Menu PowerShell consolidado, fluxo **Minificar projeto**, prévia de candidatos, ajustes temporários por fluxo e confirmações numéricas | `src/app/bridge.mjs` |
| `Executar.ps1` | Bootstrap validado e abertura do menu interativo | `src/bootstrap/cli.mjs`, `src/app/ui.ps1` |

## Observabilidade

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `src/observability/index.mjs` | Logs técnicos UTF-8, relatórios operacionais TXT/CSV e leitura/listagem read-only | Resultados de análise/execução, Node.js `fs/promises` |
| `test/observability.test.js` | Testes focados de logs, relatórios, CSV, falhas, recuperação e leitura read-only | `src/observability/index.mjs`, bridge |
| `test/ui.test.js` | Validação textual dos menus, configuração e fluxo principal PowerShell | `src/app/ui.ps1` |
| `test/ui-workflow.test.js` | Validação executável da paginação da prévia e do ciclo de vida do ajuste temporário B2/B2.1 | `src/app/ui.ps1`, Windows PowerShell |

## Restauração manual

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `src/restore/index.js` | Planos imutáveis e execução segura de restauração por backup ou última execução `.min` | Manifesto, estado, journal, SHA-256 e filesystem transacional |
| `test/restore.test.js` | Testes temporários de integridade, confirmações, `.min`, falha parcial e cancelamento | Bridge e núcleo de restauração |
| `src/runtime/paths.js` | Inclui o caminho técnico do journal de restauração manual | Node.js `path` |

## Documentação offline

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `Documentacao/Fonte/Manual-Usuario/README.md` | Manual de uso em Markdown autoritativo | Funcionalidades implementadas |
| `Documentacao/Fonte/Manual-Tecnico/README.md` | Manual técnico em Markdown autoritativo | Mapa do código e contratos implementados |
| `Documentacao/Assets/manual.css` | Estilo local compartilhado dos manuais HTML | Nenhuma |
| `scripts/docs/build-docs.mjs` | Build HTML offline determinístico para os dois manuais | Node.js `fs/promises` |
| `test/docs.test.js` | Testes focados de geração HTML, UTF-8 e ausência de dependência externa | Build de documentação |

## Empacotamento local

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `publicar.cmd` | Launcher fino do empacotamento local | Windows CMD, `scripts/release/publicar.ps1` |
| `scripts/release/publicar.ps1` | Orquestra gates, montagem, ZIP e checksum SHA-256 | Node.js, npm.cmd, Compress-Archive |
| `scripts/release/package.mjs` | Autoridade de versão, staging limpo de dependências, CRLF do CMD, allowlist, montagem e validação | Runtime, npm e Node.js built-ins |
| `LEIA-ME.txt` | Orientação prática distribuída ao usuário final | Pacote local, Manual do Usuário |
| `test/packaging.test.js` | Testes de nomes versionados, allowlist, proibições, ZIP, checksum e limpeza segura | Módulo de empacotamento, PowerShell |

## Qualidade e testes

| Arquivo | Responsabilidade | Dependências relevantes |
| --- | --- | --- |
| `test/version.test.js` | Testes de versão autoritativa e exposição na ponte/UI | `node:test`, runtime e bridge |
| `scripts/quality/check-encoding.mjs` | Validação estrita de UTF-8 e sequências conhecidas de mojibake, ignorando dependências e saídas | Node.js built-ins |
| `test/configuration-v2.test.js` | Testes focados do schema V2-only, rejeição de formatos antigos/mistos, round-trip e override temporário | `node:test`, módulos de configuração |
| `test/encoding.test.js` | Testes focados de texto UTF-8 e detecção de mojibake | `node:test`, script de encoding |
| `test/minifiers.test.js` | Testes focados de registry, adapter, perfis, JS, CSS e resultados neutros | `node:test`, adapter esbuild |
| `test/scanner.test.js` | Testes focados do Scanner V2: tipos, exclusões, confinamento, links, readonly, hard links e determinismo | `node:test`, módulos do scanner |
| `test/integrity.test.js` | Testes focados de SHA-256, estado, manifesto, backup e diretório temporário | `node:test`, módulos de integridade |
| `test/history.test.js` | Testes focados de `artifactId`, histórico imutável, dois modos, hashes, backup físico, compatibilidade transacional e falhas de persistência | `node:test`, integridade e execução |
| `test/execution.test.js` | Testes focados de pré-análise, write-ahead, conflitos, execução, rollback e interrupção | `node:test`, módulos de execução |
| `test/runtime.test.js` | Testes focados de política Node, package/lock, dependências e bootstrap sem instalação real | `node:test`, módulos runtime |

Retenção automática e publicação de GitHub Release ainda não existem; não são representadas como placeholders neste mapa.
