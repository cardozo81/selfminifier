# Manual do Usuário — SelfMinifier

Este manual descreve o uso seguro do SelfMinifier 0.4.1. As fontes Markdown em `Documentacao\Fonte` são autoritativas; o HTML em `Documentacao\Gerada` é uma cópia offline gerada pelo projeto.

## 1. Requisitos, instalação e primeira execução

O produto é suportado e testado no Windows 11 Pro x64, com Windows PowerShell 5.1 e Node.js 24.x ou 25.x. A linha 24 LTS é preferida; majors futuras não são aceitas automaticamente. Não há suporte declarado para Linux, macOS, ARM64, PowerShell 7/Core, nem requisitos mínimos validados de CPU, memória ou espaço em disco.

Na distribuição, clique duas vezes em `Executar.cmd`. O launcher chama `Executar.ps1` a partir da própria instalação e não altera a Execution Policy. As dependências já acompanham o pacote: a inicialização normal é offline e não executa `npm ci` nem `npm install`. Node ausente ou não homologado, dependência ausente/divergente e PowerShell sob `Restricted` bloqueiam o início; a instalação autorizada oferecida pode usar exatamente Node `24.19.0` via winget.

Na primeira execução, se `Configuracao\configuracao.ini` não existir, aparece **CONFIGURAÇÃO NECESSÁRIA**. Escolha **Criar configuração inicial**, informe explicitamente a `PastaRaiz` e revise o resumo. A configuração só é gravada após confirmação explícita. Backups, restauração e histórico permanecem acessíveis sem configuração operacional válida. Uma configuração existente inválida gera **CONFIGURAÇÃO INVÁLIDA** e nunca é corrigida ou substituída automaticamente.

## 2. Menu principal e segurança

Com a configuração válida, o menu oferece:

```text
1. Minificar projeto
2. Configurações
3. Backups e restauração
4. Relatórios
5. Logs técnicos
6. Uso de armazenamento
7. Limpar relatórios
8. Limpar logs técnicos
0. Sair
```

Toda mutação exige análise, confirmação explícita e prova de integridade. O SelfMinifier bloqueia quando a origem, o destino, o caminho físico, a configuração, o risco ou o estado técnico não podem ser comprovados. A Tag identifica um artefato; o SHA-256 dos bytes finais completos comprova sua integridade.

## 3. Configuração e raiz do projeto

A configuração persistente fica em `Configuracao\configuracao.ini`; `configuracao.ini.example` é somente o modelo distribuído. Ela define `PastaRaiz`, tipos (`CSS`, `JavaScript` ou `CSS+JavaScript`), exclusões relativas, motor, perfil e modo de saída.

São aceitos somente os schemas V2 e V3, com `VersaoSchema=2` ou `3`. V2 usa backups internos em `<raiz da aplicação>\_source_versions`. V3 acrescenta `PastaBackups`: uma pasta externa absoluta, existente, acessível, gravável, fisicamente separada da raiz do projeto e sem symlink, junction ou reparse point. V2 não aceita `PastaBackups`. Formatos antigos, seções `[Origem.xxx]`, chaves `Incluir*`/`Excluir*`, curingas, `..` e estruturas misturadas são rejeitados.

A interface é o caminho recomendado para editar. A alteração do local de backups é a única transição explícita V2→V3; voltar ao armazenamento interno mantém V3 e não move nem apaga backups. Excluir o INI remove apenas preferências, nunca dados, backups, histórico, relatórios ou logs.

## 4. Análise, perfis e modos de saída

Em **Minificar projeto**, confira a raiz, tipos, perfil e modo efetivos. A análise é somente leitura e mostra escopo, arquivos candidatos, já minificados, ignorados, tamanhos e motivos de exclusão. Enquanto trabalha, a tela informa **Analisando o projeto... Aguarde.**. A prévia lista até 10 itens por página somente quando há 11 ou mais candidatos.

Os perfis são `Conservador`, `Padrao` e `Maximo`; `Personalizado` não está disponível. O motor homologado é esbuild, sem bundling. O risco determinístico é separado da quantidade de arquivos:

- preservar originais e criar `.min`: Conservador **Baixo**, Padrao **Moderado**, Maximo **Alto**;
- criar backup e sobrescrever originais: Conservador **Moderado**, Padrao **Alto**, Maximo **Crítico**.

Existem exatamente dois modos:

- **Criar backup e sobrescrever os originais:** valida uma cópia GZIP (`.gz`) antes de substituir cada fonte;
- **Preservar os originais e criar `.min`:** cria `.min.js` ou `.min.css` ao lado da fonte.

No modo `.min`, destinos preexistentes são mostrados, preservados e ignorados; nunca são sobrescritos. A redução pode ser negativa e isso não é falha.

**Ajustar somente esta execução** oferece 1 para manter o modo persistente, 2 para backup e sobrescrita, 3 para preservar originais e criar `.min`, e 0 para cancelar. O ajuste alcança análise e execução, fica apenas em memória e nunca altera o INI.

## 5. Execução e resultado

Ao iniciar, o SelfMinifier refaz a pré-análise e compara a impressão digital do plano confirmado. Mudança de escopo, hash, destino, conflito ou condição de segurança bloqueia e exige nova análise. A execução é transacional e pode entrar em `recovery-required` se o estado não puder ser comprovado.

A tela **MINIFICAÇÃO CONCLUÍDA** separa arquivos planejados, processados, minificados e conflitos preservados, além de tamanho antes, tamanho depois, redução e percentual. Uma Tag conhecida com SHA-256 coincidente identifica uma saída já minificada mesmo após cópia ou renomeação. Tag ausente, inválida, desconhecida, repetida ou com conteúdo alterado não é minificada automaticamente.

## 6. Backups, restauração e recuperação histórica

**Restauração normal** valida o candidato selecionado, manifesto, histórico, caminhos, identidade física, hashes e estado técnico antes de formar o plano. A raiz registrada na execução é a autoridade; não há fallback para a configuração atual ou outra pasta. Se o arquivo atual foi alterado ou está ausente, uma confirmação adicional é exigida. O arquivo minificado atual não recebe backup durante a restauração.

No modo `.min`, a restauração da última execução concluída remove somente saídas criadas por ela. Saídas preexistentes não são removidas. Item ausente é reportado; item alterado exige confirmação adicional. Interrupção ou ambiguidade leva a `recovery-required`: preserve os arquivos, consulte logs e não force nova mutação.

**Recuperação histórica** é diferente: pesquisa registros imutáveis em `Dados\Historico` por SelfMinifier-Tag ou caminho e exporta a origem comprovada para outro arquivo. Não restaura no lugar, não escolhe o destino automaticamente e não modifica origem ou saída atual. Informe um caminho absoluto ainda inexistente e confirme.

A Tag usa exatamente 24 caracteres hexadecimais no marcador `/*! SelfMinifier-Tag: 7F31A2C82A884E91B04F22D7 */`. `MATCH` significa Tag e SHA-256 coincidentes; `CONTENT_CHANGED`, `TAG_MISMATCH`, `TAG_MISSING`, `TAG_INVALID` e `FILE_UNAVAILABLE` descrevem estados distintos. Backup `AVAILABLE` pode ser recuperado; raiz indisponível, payload ausente, manifesto inválido, hash divergente e `UNSUPPORTED_FORMAT` bloqueiam sem substituição.

## 7. Armazenamento, relatórios, logs e limpeza

**Uso de armazenamento** diagnostica `Dados`, backups internos ou externos, histórico, restauração, temporários, logs e relatórios. O diagnóstico é somente leitura. Não existe retenção automática.

Logs técnicos ficam em `Dados\Logs`; relatórios TXT/CSV ficam em `Dados\Relatorios`. A visualização é somente leitura. Relatórios mantêm totais, motivos de itens ignorados, resultados e falhas; detalhes técnicos podem permanecer nos logs.

**Limpar relatórios** e **Limpar logs técnicos** fazem uma prévia e exigem confirmação. Só são candidatos `tecnico-*.log`, `execucao-*.txt` e `execucao-*.csv`. Antes de cada exclusão, o caminho físico, o SHA-256, o atributo somente leitura e a identidade do arquivo são revalidados. Arquivo alterado, ausente, inseguro, somente leitura ou estrangeiro é preservado e reportado. Backups, histórico, estado e configuração não são afetados.

## 8. Problemas comuns e exemplos

- **Configuração ausente:** use **Criar configuração inicial** e informe a raiz; o arquivo existente nunca é sobrescrito.
- **Configuração inválida:** corrija somente os campos inválidos de forma deliberada; não espere migração automática.
- **Node ou dependências inválidos:** use Node 24.x/25.x e reextraia uma distribuição íntegra; a abertura não baixa dependências.
- **PowerShell bloqueado:** não contorne a política; consulte o administrador e a seção de requisitos.
- **Origem inacessível, link ou somente leitura:** o item será ignorado ou a execução será bloqueada conforme a prova disponível.
- **Destino `.min` existente:** ele será preservado e ignorado.
- **`recovery-required`:** pare, preserve o estado e use logs e procedimento comprovado.

Para testar sem alterar a fonte, configure o modo de preservação, analise o projeto, revise a lista e confirme somente depois da impressão digital permanecer válida. Para substituir originais, escolha o modo de backup, confira a raiz efetiva de backups e revise o plano de restauração antes de qualquer confirmação.