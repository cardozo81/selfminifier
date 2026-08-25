# Experiência de uso e interface de linha de comando

## Interface implementada

PowerShell é a interface interativa implementada. CMD pode existir somente como lançador fino para operações específicas de build ou release.

A interface deve ser guiada e compreensível sem exigir que o usuário conheça npm, esbuild, sintaxe interna de glob, hashes ou adaptadores. Rótulos e mensagens apresentados ao usuário são obrigatoriamente em pt-BR.

## Menu principal

```text
SELFMINIFIER
────────────────────────────────────
1. Minificar projeto
2. Configurações
3. Backups e restauração
4. Relatórios
5. Logs técnicos
0. Sair
```

## Fluxo principal de minificação

O fluxo implementado é: **Minificar projeto → ajuste temporário opcional do modo de saída → análise → resumo quantitativo → prévia opcional dos candidatos → iniciar minificação → revalidação por fingerprint → resultado**.

A prévia apresenta o total e a lista sem controles de paginação quando existem de 1 a 10 candidatos. Com 11 ou mais candidatos, usa páginas de 10 itens e mostra somente os controles de página anterior ou próxima que forem válidos na posição atual.

## Apresentação semântica

- verde: sucesso;
- amarelo: aviso;
- vermelho: erro ou bloqueio;
- ciano: títulos e caminhos;
- branco: conteúdo normal;
- cinza: conteúdo secundário.

Cor nunca pode ser o único meio de comunicar estado ou severidade.

## Risco

A interface deve distinguir claramente:

- risco próprio do perfil;
- risco estimado da execução;
- fatores que aumentam esse risco.

É proibido declarar “risco zero”. Os perfis e seus níveis de risco estão em `07-MINIFICACAO-E-MOTORES.md`.

O risco estimado da execução usa os níveis técnicos `Baixo`, `Moderado`, `Alto` e `Critico` (`Crítico` na apresentação). A matriz da versão 0.1.0 é:

| Modo de saída | Conservador | Padrao | Maximo |
| --- | --- | --- | --- |
| `PreservarOriginaisECriarMinificados` | Baixo | Moderado | Alto |
| `BackupESobrescreverOriginais` | Moderado | Alto | Critico |

No modo `.min`, destinos preexistentes são preservados e ignorados pelo planejamento V2; não existe autorização de sobrescrita desses destinos. A quantidade de arquivos é apresentada separadamente como escopo da operação e não altera o risco na versão 0.1.0.

Classificação de risco é informativa e apoia a autorização; nunca substitui proteções de integridade. Entrada necessária indeterminada bloqueia a execução. Não existe autorização substituta para continuar sem risco calculado. Estados não comprovados, configuração inválida, links proibidos, readonly impeditivo, backup não validado, conflito tardio não autorizado e inconsistências de journal/estado/manifesto são bloqueios, não níveis adicionais de risco.

## Pré-análise e confirmação

Antes da confirmação, a interface deve mostrar, no mínimo:

- origens efetivas e recursividade;
- arquivos explícitos;
- padrões de inclusão e exclusão;
- modo de saída;
- perfil e risco;
- caminho de backup, quando aplicável;
- arquivos encontrados, elegíveis e ignorados;
- avisos e bloqueios.

O escopo efetivo deve permanecer visível durante a interação e ser apresentado novamente imediatamente antes da execução. A confirmação deve ser explícita e só pode ocorrer depois das validações.

Origem configurada ausente ou inacessível deve ser apresentada como parte do escopo, permitindo ao fluxo interativo corrigi-la, alterá-la ou desabilitá-la temporariamente, ou cancelar. Nenhuma dessas ações temporárias altera o INI sem entrada explícita na configuração persistente e salvamento.

Conflitos de destino `.min`, restaurações sobre arquivos alterados e exclusões manuais de saídas alteradas exigem as confirmações específicas descritas em `08-BACKUP-E-ROLLBACK.md`.
