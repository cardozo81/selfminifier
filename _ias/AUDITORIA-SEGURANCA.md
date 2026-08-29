# Auditoria de segurança e limites do redesign

Documento de contexto para agentes de IA. Registra o estado **atual** (v0.3.0) dos
invariantes permanentes de integridade e os limites que mudanças futuras não podem
enfraquecer. O contrato de configuração e scanner aqui descrito é V2-only.

Legenda: ✅ confirmado · ⚠️ parcial · ❓ incerto.

## Invariantes permanentes

| # | Invariante | Status | Implementação | Testes | Lacuna / incerteza |
| --- | --- | --- | --- | --- | --- |
| 1 | Conveniência de UX nunca reduz proteções de integridade | ✅ | `validateExecutionAuthorization` (execution/executor.js) exige `confirmed`, risco calculado e bloqueios vazios; bridge ignora autorização substituta (`riskAssessment`) e compara a impressão digital do plano confirmado | `test/execution.test.js` (risco adulterado rejeitado), `test/bridge.test.js` (autorização substituta ignorada) | Princípio arquitetural; a proteção é indireta via risco/confirmação |
| 2 | Decisões críticas de filesystem não dependem de inferência silenciosa | ✅ | Hashes SHA-256 e estados de destino explícitos em planner/executor/restore; nenhum fallback silencioso | `test/execution.test.js`, `test/restore.test.js` | Nenhuma |
| 3 | Symlinks não seguidos automaticamente | ✅ | Scanner usa `lstat`; a primitiva compartilhada `assertPhysicalPath` rejeita links em cada componente | `test/scanner.test.js`, `test/b3-a2.test.js` | Nenhuma |
| 4 | Junctions/reparse points não seguidos automaticamente | ✅ | Além de `lstat` e `realpath`, `physical-path.js` chama `fsutil.exe reparsepoint query` diretamente, sem shell, e só aceita o erro nativo 4390; qualquer tag ou resultado ambíguo bloqueia | `test/b3-a2.test.js` cria junction e confirma bloqueio; evidência local diferenciou diretório comum (4390) e junction (0xa0000003) | Dependência arquitetural explícita do `fsutil.exe` no Windows suportado; indisponibilidade bloqueia fail-closed |
| 5 | Caminhos não escapam da raiz configurada | ✅ | `isInside` em integrity/backup.js e restore/index.js; `SOURCE_OUTSIDE_ORIGIN`; manifesto exige `backupRelativePath` relativo sem `..` | `test/integrity.test.js`, `test/restore.test.js` | Hoje a raiz é por origem (`originRoot`), não uma raiz única de projeto; o redesign altera esse modelo |
| 6 | Path traversal falha fechado | ✅ | Rejeição de `..`, caminhos absolutos e identificadores inseguros (`SAFE_IDENTIFIER` em integrity/backup.js; validação de manifesto) | `test/integrity.test.js` (manifesto) | Nenhuma |
| 7 | Arquivos divergentes nunca sobrescritos silenciosamente | ✅ | `replaceFileExact`/`removeExactFile` conferem hash atual; `SOURCE_CHANGED`, `TARGET_CHANGED`, `LATE_DESTINATION_CONFLICT` | `test/execution.test.js` (conflito tardio; mudança externa → recovery-required), `test/restore.test.js` | Nenhuma |
| 8 | Atributo somente leitura nunca removido automaticamente | ✅ | Nenhum código remove/limpa atributo readonly (sem chmod/attrib) | Sem teste dedicado | Cobertura por revisão de código; não há teste explícito da não-remoção |
| 9 | Arquivos somente leitura pulados e reportados | ✅ | Scanner `isReadonlyFile` → `READONLY_FILE` em ignorados | `test/scanner.test.js` (readonly produz diagnóstico) | Nenhuma |
| 10 | `.min` nunca apagado só por conter `.min` no nome | ✅ | Restauração remove somente itens `create-output` por caminho e hash exatos; `replace-output` vira `PREEXISTING_MIN_NOT_RESTORED`; exclusão por curinga é proibida | `test/restore.test.js` (`.min remove somente saída criada`; `doesNotMatch(/\*\.min\.\*/)`) | Nenhuma |
| 11 | Restauração apaga só arquivos comprovados da execução | ✅ | Planos revalidam manifesto/estado/hash; journal write-ahead; `removeExactFile` confere hash | `test/restore.test.js` | Nenhuma |
| 12 | Configuração inválida crítica falha fechado | ✅ | `schema.js` aceita exatamente V2/V3 e rejeita V1, versões desconhecidas e mistura; V3 prova `PastaBackups`, escrita e disjunção física antes do uso | `test/configuration-v2.test.js`, `test/b3-a2.test.js`, `test/bridge.test.js` | Nenhuma |
| 13 | Registros de execução/restauração preservam integridade suficiente | ✅ | Journal inclui `stateBefore`, hashes por item, `recovery`, `manifestExpectedHash`; `validateExecutionJournal` valida consistência de conclusão | `test/execution.test.js` (contradição de estado), `test/restore.test.js` | Nenhuma |
| 14 | Testes não enfraquecidos para passar comportamento inseguro | ✅ | Testes atuais afirmam bloqueio (readonly, symlink, risco, curinga proibido, recovery-required) | Diversos | Meta-invariante; continua válido hoje |

## Módulos que sustentam a integridade (não enfraquecer)

- `src/integrity/*` — SHA-256, JSON UTF-8 atômico, estado, histórico, manifesto, backup validado e prova física/reparse fail-closed.
- `src/scanner/filesystem.js` — `lstat`, leitura read-only, exclusões técnicas obrigatórias, identidade física, detecção de readonly e link.
- `src/execution/{planner,executor,journal,recovery,filesystem,risk}.js` — pré-análise imutável, write-ahead, rollback exato e recuperação determinística.
- `src/restore/index.js` — planos imutáveis, revalidação do gate e mutação por hash exato.
- `src/configuration/{parse,schema,v2,v3,backup-root,index}.js` — V2 congelado, V3 explícito, resolver único e persistência fail-closed.

## Limites para o redesign

- A configuração persistente e a efetiva são distintas; somente V2/V3 são suportados. V2 só migra para V3 por `update-backup-root` confirmado; não há migração automática nem downgrade.
- A raiz histórica realmente usada é autoridade de restauração. Raiz externa indisponível bloqueia e permanece visível; nenhuma raiz atual é fallback.
- O scanner deve continuar baseado em `lstat`, read-only, sem seguir symlink/junction/reparse point. As exclusões técnicas (`node_modules`, `.git`, `_source_versions`, `Dados/Temporarios`) não podem ser desativadas.
- Arquivos `.min.js`/`.min.css` continuam fora da seleção de fontes (hoje em `execution/planner.js`, função `isMinifiedName`).
- O núcleo de restauração (`src/restore/index.js`) e a execução transacional não devem ser enfraquecidos; mudanças de UX devem permanecer na apresentação (`src/app/ui.ps1` e `src/app/bridge.mjs`).
