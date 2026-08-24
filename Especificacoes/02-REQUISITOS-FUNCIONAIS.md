# Requisitos funcionais

## Capacidades do produto

O SelfMinifier deve permitir ao usuário:

- analisar, antes de qualquer alteração, o escopo efetivo de arquivos;
- minificar JavaScript e CSS por meio de um motor homologado;
- configurar qualquer quantidade de origens de diretório e de arquivos explícitos;
- aplicar inclusões e exclusões globais, por origem e temporárias;
- escolher um perfil de minificação e visualizar o risco correspondente;
- escolher um dos dois modos de saída definidos em `06-CONFIGURACAO.md`;
- ajustar somente a execução atual sem alterar preferências persistentes;
- consultar backups conhecidos e selecionar manualmente uma pasta de backup;
- restaurar conteúdo conforme as regras de `08-BACKUP-E-ROLLBACK.md`;
- consultar relatórios operacionais e logs técnicos separados.

## Fluxo obrigatório

Nenhuma minificação começa imediatamente. A execução deve respeitar o fluxo conceitual:

`configuração` → `ajustes temporários` → `scanner` → `validações` → `classificação` → `análise de risco` → `simulação/resumo` → `confirmação explícita` → `execução`

A apresentação e a confirmação desse fluxo são definidas em `05-UX-CLI.md`. As proteções que podem impedir seu avanço estão em `10-SEGURANCA-E-INTEGRIDADE.md`.

## Resultados observáveis

- Cada item encontrado deve ser classificado como elegível, ignorado ou bloqueado, conforme aplicável.
- O resultado deve indicar arquivos encontrados, processados, ignorados e bloqueados, além de avisos e falhas.
- Itens ignorados e escopo inacessível seguem, respectivamente, `09-LOGS-E-RELATORIOS.md` e `10-SEGURANCA-E-INTEGRIDADE.md`.

As regras de seleção e precedência estão em `03-REGRAS-NEGOCIO.md`; os limites de minificação estão em `07-MINIFICACAO-E-MOTORES.md`.
