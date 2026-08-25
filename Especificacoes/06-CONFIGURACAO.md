# Configuração

## Arquivos e responsabilidades

- Configuração persistente do usuário: `Configuracao\configuracao.ini`.
- Modelo versionado: `Configuracao\configuracao.ini.example`.
- O INI real do usuário não deve ser versionado.
- O INI armazena preferências, nunca estado técnico da aplicação.

Estado técnico e controle de recuperação são definidos em `08-BACKUP-E-ROLLBACK.md`.

## Schema suportado

O único schema de configuração suportado é identificado explicitamente por:

```ini
[Configuracao]
VersaoSchema=2
```

`VersaoSchema=2` é um discriminador permanente. Sua ausência, valor diferente de `2`, estrutura antiga `[Origem.xxx]`, chaves antigas `Incluir*`/`Excluir*` ou mistura entre estruturas V1 e V2 bloqueiam o carregamento. Não existe inferência, migração automática, conversão parcial ou reinterpretação silenciosa.

## Estrutura V2

A configuração V2 usa uma única raiz de projeto, percorrida recursivamente pelo Scanner V2, e uma seleção fechada de tipos:

```ini
[Configuracao]
VersaoSchema=2
Motor=esbuild
Perfil=Padrao
ModoSaida=BackupESobrescreverOriginais
PastaRaiz=C:\Projetos\MeuSite
TiposArquivo=CSS+JavaScript

IgnorarPasta01=node_modules
IgnorarPasta02=.git
IgnorarArquivo01=src\config.js
```

`TiposArquivo` aceita exatamente `CSS`, `JavaScript` ou `CSS+JavaScript`. Pastas e arquivos ignorados usam chaves numeradas `IgnorarPastaNN` e `IgnorarArquivoNN`, com caminhos relativos à raiz, sem glob, traversal ou caminhos absolutos.

A raiz deve ser um caminho Windows absoluto com unidade ou UNC. Variáveis de ambiente, curingas e segmentos `..` não são aceitos. Valores inválidos bloqueiam antes da descoberta.

## Modo de saída

A chave `ModoSaida=` aceita exatamente dois valores mutuamente exclusivos:

- `BackupESobrescreverOriginais`
- `PreservarOriginaisECriarMinificados`

O valor padrão é `BackupESobrescreverOriginais`. Qualquer outro valor bloqueia a execução.

No primeiro modo, o original só pode ser substituído depois de um backup validado da fonte não minificada. No segundo, a fonte nunca é alterada, não requer backup por não ser sobrescrita e a saída é criada ao lado dela com o nome definido em `03-REGRAS-NEGOCIO.md`. Destinos `.min` preexistentes são preservados e ignorados pelo planejamento V2.

Alterações persistentes de modo de saída carregam a configuração V2 normalizada, exigem confirmação, validam o resultado, gravam pelo serializer V2 e confirmam a releitura. Campos não relacionados são preservados.

## Validação

Não existe fallback silencioso para configuração inválida. Schema, enum, motor, caminho, perfil, tipo ou exclusão inválidos bloqueiam o avanço e informam a correção esperada.

Ausência ou inacessibilidade da raiz configurada segue `10-SEGURANCA-E-INTEGRIDADE.md`.

## Configuração efetiva temporária

A configuração persistente e a configuração efetiva são objetos distintos. O ajuste temporário atualmente suportado altera somente o modo de saída do fluxo corrente de **Minificar projeto**.

Um ajuste temporário alcança a análise e a execução desse fluxo, nunca modifica `Configuracao\configuracao.ini` e desaparece quando o fluxo termina ou quando um novo fluxo independente é iniciado. A persistência só ocorre quando o usuário entra explicitamente na área de configuração persistente e salva.

A seleção temporária do modo de saída apresenta exatamente:

- `1`: manter a configuração persistente atual;
- `2`: usar temporariamente `BackupESobrescreverOriginais`;
- `3`: usar temporariamente `PreservarOriginaisECriarMinificados`;
- `0`: cancelar a operação temporária atual.

As opções 1, 2 e 3 concluem a seleção sem etapa adicional de aplicação. A opção 0 descarta somente a seleção temporária em andamento, preserva o ajuste anterior do fluxo corrente, se houver, e nunca modifica o INI.
