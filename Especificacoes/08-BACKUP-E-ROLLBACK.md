# Backup, estado técnico, restauração e rollback

## Estado técnico

O estado técnico é separado do INI e fica em `Dados\estado.json`. O diretório temporário interno do runtime fica em `Dados\Temporarios\`. SHA-256 é a prova primária de integridade.

O estado deve registrar informação suficiente para comprovar e recuperar operações, incluindo, conforme aplicável:

- caminhos de origem e saída;
- hashes da origem e do resultado;
- data da minificação;
- motor e versão do motor;
- tamanho minificado;
- modo de saída;
- metadados adicionais necessários à recuperação.

Para um original sobrescrito, a detecção confiável de “já minificado” exige:

`SHA-256 atual == SHA-256 minificado registrado`

Timestamps não são prova primária, e aparência visual não comprova estado. A troca de motor não autoriza reminificar diretamente um arquivo comprovadamente já minificado; quando aplicável, a fonte original deve ser restaurada primeiro.

## Histórico persistente de proveniência

`Dados\Historico` é a autoridade histórica de metadados técnicos. Cada execução concluída possui um registro imutável `Dados\Historico\<executionId>.json`, com `formatVersion: 1`, sem índice global. `Dados\estado.json` permanece o estado técnico atual e não substitui nem acumula o histórico.

O cabeçalho histórico registra:

- `executionId` existente, sem alteração;
- `meminifyVersion`, preservando o nome compatível do formato 1;
- timestamp, modo de saída e raiz física do projeto;
- lista dos artefatos efetivamente produzidos.

Cada artefato produzido recebe um `artifactId` persistente, independente de caminhos e de numeração sequencial, gerado por `crypto.randomBytes(12)` como 24 caracteres hexadecimais maiúsculos. O registro do artefato conserva origem, saída, hashes de entrada e saída, tamanhos, motor e versão, perfil, modo e timestamp.

No modo de sobrescrita, a proveniência conserva a raiz física de backup e o caminho relativo realmente usados, o hash do original e `compression: none`. No modo `.min`, a ausência de payload histórico de backup é explícita por `available: false`, caminhos/hash nulos e `compression: none`; a aplicação não copia a fonte apenas para fabricar recuperação histórica.

O payload de backup continua em `_source_versions` nesta fase. `Dados\Historico` contém somente o plano de controle necessário para interpretar cada execução segundo a localização vigente quando ela ocorreu.

Registros novos podem ligar `executionId` e `artifactId` ao estado atual, ao journal e ao manifesto. Registros antigos sem esses campos continuam válidos e não são migrados ou regravados.

A marca oficial usa a sintaxe fechada `/*! SelfMinifier-Tag: <artifactId> */`, em que o valor é exatamente o `artifactId` do artefato. A Tag é identidade, não prova de integridade. JavaScript preserva shebang como primeira linha e recebe a Tag depois dele; CSS preserva um `@charset` inicial válido e recebe a Tag depois dessa regra.

Para novas saídas, o fluxo é: minificar → inserir a Tag → obter os bytes finais completos → calcular SHA-256 incluindo a Tag → persistir o mesmo hash no journal, estado, histórico e manifesto, onde aplicável → escrever exatamente esses bytes. Não há remoção ou normalização do marcador antes do hash.

Uma Tag conhecida só comprova artefato já minificado quando o SHA-256 do arquivo completo coincide com o `outputHash` histórico, independentemente do caminho atual; cópias idênticas são válidas. Conteúdo alterado, Tag desconhecida, múltipla ou inválida não é reminificado automaticamente. Sem Tag, o reconhecimento legado por caminho e `minifiedHash` do estado continua disponível para artefatos antigos.

No protocolo write-ahead, caminho e SHA-256 esperado do histórico entram no journal antes da criação exclusiva do registro. Estado e manifesto obrigatórios são comprovados primeiro; o histórico é então gravado e comprovado; somente depois o journal recebe `completed`. Falha anterior à conclusão remove o histórico apenas pelo caminho e hash exatos, e qualquer divergência permanece `recovery-required`. Colisão de `executionId` bloqueia sem sobrescrever o registro existente.

## Pesquisa histórica e recuperação da origem

A pesquisa por `SelfMinifier-Tag` normaliza somente a apresentação do marcador e usa o `artifactId` exato para varrer sequencialmente os registros imutáveis de `Dados\Historico`. Ausência produz `TAG_NOT_FOUND`; mais de um registro autoritativo para a mesma identidade produz `HISTORY_ARTIFACT_ID_CONFLICT` e bloqueia sem selecionar o mais recente.

A consulta por caminho compara `sourcePath` e `outputPath` históricos e retorna todas as ocorrências em ordem determinística explicitada. Caminho é metadado: execuções distintas no mesmo caminho continuam sendo artefatos independentes, cada uma com seu próprio `artifactId`. A pesquisa permanece disponível quando o arquivo atual foi renomeado, movido ou excluído.

A integridade atual é uma observação opcional, separada do fato histórico. Quando um caminho físico é fornecido, a aplicação prova arquivo regular seguro, inspeciona a Tag exata e compara o SHA-256 dos bytes completos com o `outputHash` histórico. Os estados são `MATCH`, `CONTENT_CHANGED`, `TAG_MISMATCH`, `TAG_MISSING`, `TAG_INVALID` e `FILE_UNAVAILABLE`.

A disponibilidade do backup é observada exclusivamente na raiz gravada pelo histórico, sem fallback para `PastaBackups` atual. Histórico, manifesto, caminho relativo, identidade do artefato, hashes e compressão devem concordar. Manifestos v1 leem payload raw; manifestos v2 leem GZIP e comprovam o SHA-256 descompactado. Ausência, raiz indisponível, manifesto inválido, payload ausente, formato não suportado e divergência de hash permanecem estados distintos.

Recuperação histórica é exportação, não restauração. `recoverHistoricalOriginal` exige destino absoluto explícito fora dos caminhos históricos de origem e saída, pai físico seguro e alvo inexistente. A criação é exclusiva, grava os bytes originais exatos e confirma o SHA-256 exportado contra `inputHash` e `backup.originalHash`; contradição bloqueia. O arquivo atual nunca é substituído. Artefato `.min` com `backup.available=false` continua pesquisável, mas retorna `HISTORICAL_BACKUP_UNAVAILABLE` para recuperação.
## `BackupESobrescreverOriginais`

O backup guarda somente a fonte não minificada imediatamente antes de sua sobrescrita. Uma versão minificada nunca pode ser usada como backup de fonte.

O diretório neutro de backup é `_source_versions`. A sequência obrigatória é:

`fonte` → `SHA-256 da fonte` → `criar backup` → `validar existência do backup` → `validar SHA-256 do backup` → `minificar em memória/temporário` → `validar resultado` → `artifactId` → inserir `SelfMinifier-Tag` → `SHA-256` dos bytes finais completos → substituição segura no mesmo caminho → atualizar estado

Falha crítica em qualquer prova anterior à substituição impede a sobrescrita.

Um arquivo já minificado e inalterado não recebe novo backup, não é minificado, não é sobrescrito e deve ser reportado.

## Organização e manifesto de backup

Várias raízes de origem não podem colidir no backup. Cada execução usa pasta e identificadores de origem, por exemplo:

```text
_source_versions\
  20260821_101500\
    origem-001\
    origem-002\
    manifest.json
```

O manifesto deve mapear os identificadores às raízes originais e registrar, no mínimo:

- ID da execução;
- timestamp;
- versão do SelfMinifier;
- origem original;
- caminho absoluto original;
- caminho relativo no backup;
- motor e versão;
- perfil;
- tamanhos original e minificado;
- SHA-256 original e minificado;
- status;
- data da minificação.

## Restauração de backup

O modo de sobrescrita deve permitir listar backups conhecidos e selecionar manualmente uma pasta de backup. Antes da restauração, devem ser validados manifesto, arquivos, hashes, destino e integridade.

A restauração repõe a fonte não minificada no caminho original. O arquivo atualmente minificado não deve receber backup antes dessa restauração.

Se o arquivo atual mudou depois da minificação, isto é:

`SHA-256 atual != SHA-256 minificado registrado`

o usuário deve ser avisado e confirmar explicitamente a sobrescrita das mudanças atuais. Sem confirmação, esse arquivo não é restaurado.

## Conflitos de destino no modo `.min`

Antes de qualquer escrita, todos os destinos planejados devem ser calculados e verificados.

Se um ou mais destinos `.min` já existirem, a interface deve listar todos os conflitos, mostrar os caminhos exatos e pedir uma única confirmação global que autorize suas sobrescritas. Nenhum processamento começa antes dessa decisão.

Sem confirmação, toda a execução é cancelada e nenhum arquivo sem conflito pode permanecer gerado. A detecção deve ocorrer antes de mutações para que o cancelamento normalmente não exija limpeza.

Se surgir um conflito novo e não autorizado entre a pré-análise e a escrita, a autorização anterior não se estende a ele. A execução deve abortar, reverter transacionalmente as mudanças da tentativa atual e reportar.

## Transação no modo `.min`

A execução deve ser transacional até onde for tecnicamente comprovável:

`todas as mutações planejadas têm sucesso` **ou** `as mudanças desta execução são revertidas`

Cada mutação deve ser rastreada exatamente. Limpezas com curingas, como excluir `*.min.*`, são proibidas.

- Se um destino não existia e foi criado pela tentativa, o rollback exclui exatamente esse arquivo.
- Se um destino existia e sua sobrescrita foi autorizada, seu conteúdo anterior e SHA-256 devem ser preservados temporariamente antes da substituição.
- Se uma etapa posterior falhar, somente os novos destinos desta transação são excluídos, e os destinos preexistentes sobrescritos são restaurados.
- O rollback deve ser validado e qualquer falha deve ser reportada em modo fail-closed.

Esse rollback de falha não se confunde com a restauração manual de uma execução concluída com sucesso.

## Restauração manual da última execução `.min`

Para a última execução bem-sucedida em `PreservarOriginaisECriarMinificados`, “restaurar última execução” significa excluir somente arquivos `.min` que:

- não existiam antes daquela execução;
- foram criados por aquela execução;
- estão registrados exatamente no controle da última execução.

É proibido procurar arquivos por curingas. Um `.min` preexistente cuja sobrescrita foi autorizada não é excluído por essa regra.

Se um novo `.min` registrado já não existir, ele não deve ser recriado e deve ser reportado como ausente. Se seu SHA-256 atual diferir do registrado na criação, ele não pode ser excluído automaticamente: o usuário deve ser avisado de que houve alteração e confirmar explicitamente. Sem confirmação, o arquivo permanece.

## Controle da última execução

O controle técnico dedicado fica em `Dados\Restauracao\ultima-execucao.bkp`. A extensão `.bkp` identifica um controle de recuperação e não implica cópia binária de fontes; seu formato é JSON estruturado em UTF-8.

O controle deve conter informação suficiente para desfazer somente os efeitos permitidos da última execução, incluindo, conforme aplicável:

- versão do formato;
- ID e timestamp da execução;
- versão do SelfMinifier;
- modo de saída e status da execução;
- caminhos exatos de origem e destino;
- tipo da operação;
- valores SHA-256 relevantes;
- referência de backup ou recuperação.

Por compatibilidade com os registros gerados pela v0.1.x, o campo serializado que registra a versão do produto mantém o nome `meminifyVersion`. Esse nome faz parte do contrato de `formatVersion` 1 e não deve ser renomeado.

Devem ser diferenciados, no mínimo, “saída criada nesta execução” e “saída preexistente sobrescrita”.

## Protocolo write-ahead

O journal usa persistência por arquivo temporário durável e `rename`, com estados explícitos de execução e de cada item. O fluxo mínimo é:

1. persistir o plano e o snapshot anterior do estado técnico;
2. preparar e validar a referência exata de backup ou recuperação;
3. persistir a intenção com hashes anterior e esperado;
4. executar somente a mutação registrada;
5. comprovar o resultado por SHA-256 e marcar o item como confirmado;
6. atualizar `Dados\estado.json` somente depois dessa confirmação;
7. marcar a execução como concluída somente após todos os itens e metadados obrigatórios estarem comprovados.

Os estados de execução são `planned`, `prepared`, `running`, `completed`, `rolled-back` e `recovery-required`. Os itens distinguem planejamento, preparação, intenção de mutação, confirmação, rollback e necessidade de recuperação.

Antes de uma nova execução mutante, o journal deve ser validado. Transações incompletas são revertidas somente quando caminhos, hashes e cópias de recuperação provam deterministicamente a ação. Divergência externa ou referência inválida bloqueia a nova execução em `recovery-required`. Nenhuma recuperação usa curinga.

O snapshot anterior de `Dados\estado.json` integra o journal. Rollback comprovado restaura esse snapshot ou remove o estado criado pela tentativa; rollback ambíguo não fabrica consistência entre estado e arquivos.

O rastreamento deve sobreviver suficientemente a uma execução parcial para impedir alterações não rastreadas, preservando a garantia:

**Nenhuma mutação confirmada no sistema de arquivos pode existir sem rastreamento recuperável correspondente.**
