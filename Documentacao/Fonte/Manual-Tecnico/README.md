# Manual Técnico — SelfMinifier

## Arquitetura implementada

O fluxo de dependências é `PowerShell → Node CLI → núcleo`. `Executar.ps1` executa o bootstrap e carrega `src/app/ui.ps1`; a interface chama `src/app/bridge.mjs` por JSON. A camada PowerShell apresenta escopo e confirmações, mas não aplica regras de scanner, minificação, integridade ou transação.

O bridge coordena configuração, análise, execução, restauração, logs e relatórios. Diagnósticos estruturados são retornados sem stack traces para a interface; detalhes técnicos seguem para logs.

## Configuração e domínio

`src/configuration` lê UTF-8 estrito, detecta chaves duplicadas, normaliza listas numeradas e valida enums/booleanos/origens. `src/domain/index.js` concentra modos de saída, tipos de origem e perfis. `deriveEffectiveConfiguration()` cria uma configuração temporária sem mutar a persistente.

O INI real permanece em `Configuracao\configuracao.ini`; o modelo fica em `Configuracao\configuracao.ini.example`. Não há fallback silencioso para dados inválidos.

## Scanner e minificação

`src/scanner` descobre arquivos em modo read-only, aplica glob com micromatch, deduplica identidades físicas e reporta links, readonly e exclusões técnicas. `src/minifiers` define o contrato neutro e compõe o registry homologado com o adapter esbuild. O adapter suporta JavaScript e CSS; perfis `Conservador`, `Padrao` e `Maximo` são traduzidos internamente. `Personalizado` falha fechado porque seu schema ainda não existe.

## Integridade, backup e execução

`src/integrity` fornece SHA-256, JSON UTF-8 atômico, estado técnico, manifesto e cópias de backup validadas. O modo de sobrescrita grava fontes em `_source_versions/<execução>` e persiste `manifest.json` com mapeamento de origem, tamanhos e hashes.

`src/execution/planner.js` cria uma pré-análise imutável. `src/execution/executor.js` usa journal write-ahead em `Dados\Restauracao\ultima-execucao.bkp`: plano, intenção, mutação, hash final, estado e conclusão. Para `.min`, conflitos são detectados antes da escrita e o rollback remove ou restaura somente caminhos exatos registrados. `recovery-required` é usado quando o rollback não pode ser comprovado sem adivinhação.

## Restauração manual

`src/restore/index.js` cria planos imutáveis e revalida o gate de segurança imediatamente antes da mutação. A restauração por backup exige manifesto, hash da cópia, caminho original, mapeamento de origem e registro de estado compatível. Cada fonte restaurada remove o registro que afirmava que ela ainda era minificada.

A restauração `.min` lê somente a última execução concluída e remove apenas operações `create-output`. Operações `replace-output` são registradas como não aplicáveis. Saídas ausentes, alteradas, recusadas, restauradas ou excluídas permanecem rastreadas. O progresso manual é persistido em `Dados\Restauracao\restauracao-em-andamento.bkp`; um estado incompleto ou `recovery-required` bloqueia nova mutação.

## Logs, relatórios e diretórios de dados

`src/observability/index.mjs` produz logs técnicos em `Dados\Logs` e relatórios TXT/CSV em `Dados\Relatorios`. Relatórios não expõem stack traces e preservam motivos de itens ignorados ou pulados. A visualização pelo menu é read-only.

Diretórios técnicos relevantes:

- `Dados\estado.json`: registros de fontes e saídas comprovadas.
- `Dados\Temporarios`: área técnica excluída pelo scanner.
- `Dados\Restauracao`: journal de execução, journal de restauração e cópias transitórias.
- `_source_versions`: backups de fontes para o modo de sobrescrita.

Não há política automática de retenção ou remoção histórica.

## Runtime e bootstrap

`src/runtime/environment.js` valida Node, npm, package/lock, dependências locais e uma transformação funcional curta pelo esbuild empacotado. A política em `resources/runtime-policy.json` exige major mínima 24 e aceita explicitamente Node 24.x e 25.x; 24 é a linha LTS preferida, 25 é suportada sem preferência, e majors futuras não listadas falham fechado. A instalação interativa aprovada continua sendo `24.19.0` por winget. O bootstrap nunca executa `npm ci`/`npm install`: dependência ausente, divergente ou runtime de plataforma inoperante bloqueia. A publicação produz `node_modules` de runtime por `npm ci --omit=dev` em staging descartável e a inicialização normal usa essa árvore offline.

A confirmação da UI carrega a impressão digital SHA-256 do plano mostrado. O bridge refaz a pré-análise imediatamente antes de executar e bloqueia se escopo, hashes, destinos, conflitos ou demais condições confirmáveis divergirem.

O risco de execução é calculado deterministicamente por modo e perfil antes da confirmação. Conflitos `.min` preexistentes elevam um nível, com teto `Critico`; escopo de arquivos é metadado separado. Não existe autorização substituta para risco indeterminado.

Use `npm.cmd` no PowerShell para evitar bloqueio de `npm.ps1` pela política de execução.

## UTF-8, qualidade e desenvolvimento

Texto humano e artefatos documentais usam UTF-8. `scripts/quality/check-encoding.mjs` verifica arquivos textuais e sequências de mojibake conhecidas. O projeto usa `node:test` com fixtures temporárias para configuração, scanner, execução, integridade, observabilidade e restauração.

O desenvolvimento ocorre diretamente em `main`, com commits validados e allowlist explícita de arquivos ao preparar um checkpoint. Não use `git add .`, force-push, fallback silencioso ou exclusão por curingas.

## Documentação offline

As fontes autoritativas ficam em `Documentacao\Fonte`. Execute `npm.cmd run build:docs` para gerar HTML local em `Documentacao\Gerada`. O build não acessa a rede, não modifica o Markdown e usa `Documentacao\Assets\manual.css`; o HTML gerado não substitui as fontes Markdown nem as especificações.

## Empacotamento local

`publicar.cmd` delega para `scripts\release\publicar.ps1`. O pipeline valida ambiente, versão `package.json`, package/lock, dependências, UTF-8, testes e documentação antes de montar uma allowlist em `dist\SelfMinifier-<version>`. Em seguida valida o conteúdo, cria um ZIP com uma única raiz versionada e grava o SHA-256 correspondente.

O pacote inclui launcher, manifestos npm, `src`, `resources`, modelo de configuração, HTML offline e `node_modules` de runtime gerado de forma limpa. Exclui testes, especificações, `_ias`, scripts de desenvolvimento, dados locais, configuração pessoal, backups, `node_modules` do checkout e `dist` anterior. O `Executar.cmd` empacotado é validado em CRLF e respeita a Execution Policy, bloqueando sob `Restricted` sem bypass. O empacotamento não publica GitHub Release.
