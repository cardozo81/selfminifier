# Auditoria de segurança e limites do redesign

Documento de contexto para agentes de IA. Registra o estado **atual** (v0.2.0) dos
invariantes permanentes de integridade e os limites que mudanças futuras não podem
enfraquecer. O contrato de configuração e scanner aqui descrito é V2-only.

Legenda: ✅ confirmado · ⚠️ parcial · ❓ incerto.

## Invariantes permanentes

| # | Invariante | Status | Implementação | Testes | Lacuna / incerteza |
| --- | --- | --- | --- | --- | --- |
| 1 | Conveniência de UX nunca reduz proteções de integridade | ✅ | `validateExecutionAuthorization` (execution/executor.js) exige `confirmed`, risco calculado e bloqueios vazios; bridge ignora autorização substituta (`riskAssessment`) e compara a impressão digital do plano confirmado | `test/execution.test.js` (risco adulterado rejeitado), `test/bridge.test.js` (autorização substituta ignorada) | Princípio arquitetural; a proteção é indireta via risco/confirmação |
| 2 | Decisões críticas de filesystem não dependem de inferência silenciosa | ✅ | Hashes SHA-256 e estados de destino explícitos em planner/executor/restore; nenhum fallback silencioso | `test/execution.test.js`, `test/restore.test.js` | Nenhuma |
| 3 | Symlinks não seguidos automaticamente | ✅ | Scanner usa `lstat` e reporta `LINK_IGNORED`; `assertPathHasNoLinks` (integrity/backup.js) e `UNSAFE_DESTINATION` (execution/planner.js) rejeitam links | `test/scanner.test.js` (symlink reportado e nunca atravessado) | Nenhuma |
| 4 | Junctions/reparse points não seguidos automaticamente | ⚠️ | Junctions caem no caminho de symlink (`stats.isSymbolicLink()` no `lstat`; `fileType` = `symlink-or-junction`) | `test/scanner.test.js` cria `symlink(..., 'junction')` e espera `LINK_IGNORED` | Reparse points que não são symlink/junction não possuem guarda explícita; possível travessia de entradas especiais do Windows |
| 5 | Caminhos não escapam da raiz configurada | ✅ | `isInside` em integrity/backup.js e restore/index.js; `SOURCE_OUTSIDE_ORIGIN`; manifesto exige `backupRelativePath` relativo sem `..` | `test/integrity.test.js`, `test/restore.test.js` | Hoje a raiz é por origem (`originRoot`), não uma raiz única de projeto; o redesign altera esse modelo |
| 6 | Path traversal falha fechado | ✅ | Rejeição de `..`, caminhos absolutos e identificadores inseguros (`SAFE_IDENTIFIER` em integrity/backup.js; validação de manifesto) | `test/integrity.test.js` (manifesto) | Nenhuma |
| 7 | Arquivos divergentes nunca sobrescritos silenciosamente | ✅ | `replaceFileExact`/`removeExactFile` conferem hash atual; `SOURCE_CHANGED`, `TARGET_CHANGED`, `LATE_DESTINATION_CONFLICT` | `test/execution.test.js` (conflito tardio; mudança externa → recovery-required), `test/restore.test.js` | Nenhuma |
| 8 | Atributo somente leitura nunca removido automaticamente | ✅ | Nenhum código remove/limpa atributo readonly (sem chmod/attrib) | Sem teste dedicado | Cobertura por revisão de código; não há teste explícito da não-remoção |
| 9 | Arquivos somente leitura pulados e reportados | ✅ | Scanner `isReadonlyFile` → `READONLY_FILE` em ignorados | `test/scanner.test.js` (readonly produz diagnóstico) | Nenhuma |
| 10 | `.min` nunca apagado só por conter `.min` no nome | ✅ | Restauração remove somente itens `create-output` por caminho e hash exatos; `replace-output` vira `PREEXISTING_MIN_NOT_RESTORED`; exclusão por curinga é proibida | `test/restore.test.js` (`.min remove somente saída criada`; `doesNotMatch(/\*\.min\.\*/)`) | Nenhuma |
| 11 | Restauração apaga só arquivos comprovados da execução | ✅ | Planos revalidam manifesto/estado/hash; journal write-ahead; `removeExactFile` confere hash | `test/restore.test.js` | Nenhuma |
| 12 | Configuração inválida crítica falha fechado | ✅ | `src/configuration/schema.js` exige `VersaoSchema=2`; `src/configuration/v2.js` rejeita schema, enum, motor, perfil, modo, raiz, tipos e exclusões inválidos sem fallback | `test/configuration-v2.test.js`, `test/configuration-ui.test.js`, `test/bridge.test.js` | Nenhuma |
| 13 | Registros de execução/restauração preservam integridade suficiente | ✅ | Journal inclui `stateBefore`, hashes por item, `recovery`, `manifestExpectedHash`; `validateExecutionJournal` valida consistência de conclusão | `test/execution.test.js` (contradição de estado), `test/restore.test.js` | Nenhuma |
| 14 | Testes não enfraquecidos para passar comportamento inseguro | ✅ | Testes atuais afirmam bloqueio (readonly, symlink, risco, curinga proibido, recovery-required) | Diversos | Meta-invariante; continua válido hoje |

## Módulos que sustentam a integridade (não enfraquecer)

- `src/integrity/*` — SHA-256, JSON UTF-8 atômico, estado técnico, manifesto, backup validado e `assertPathHasNoLinks`.
- `src/scanner/filesystem.js` — `lstat`, leitura read-only, exclusões técnicas obrigatórias, identidade física, detecção de readonly e link.
- `src/execution/{planner,executor,journal,recovery,filesystem,risk}.js` — pré-análise imutável, write-ahead, rollback exato e recuperação determinística.
- `src/restore/index.js` — planos imutáveis, revalidação do gate e mutação por hash exato.
- `src/configuration/{parse,schema,v2,index}.js` — detecção explícita de `VersaoSchema=2`, parsing estrito, validação e persistência fail-closed.

## Limites para o redesign

- A configuração persistente (`Configuracao/configuracao.ini`) e a efetiva de execução são objetos distintos; somente `VersaoSchema=2` é suportado, sem inferência ou migração de formatos antigos.
- O scanner deve continuar baseado em `lstat`, read-only, sem seguir symlink/junction/reparse point. As exclusões técnicas (`node_modules`, `.git`, `_source_versions`, `Dados/Temporarios`) não podem ser desativadas.
- Arquivos `.min.js`/`.min.css` continuam fora da seleção de fontes (hoje em `execution/planner.js`, função `isMinifiedName`).
- O núcleo de restauração (`src/restore/index.js`) e a execução transacional não devem ser enfraquecidos; mudanças de UX devem permanecer na apresentação (`src/app/ui.ps1` e `src/app/bridge.mjs`).
