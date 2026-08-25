# Manual do Usuário — SelfMinifier

## Finalidade e segurança

O SelfMinifier minifica arquivos JavaScript e CSS no Windows. Toda alteração exige confirmação explícita, validação prévia e prova de integridade por SHA-256. Em dúvida, erro de configuração, origem inacessível ou estado técnico não comprovado, a operação é bloqueada.

Não existe risco zero. O risco do perfil é exibido separadamente do risco estimado da execução, que sempre é calculado antes de uma execução válida. Se algum dado necessário não puder ser determinado, a execução é bloqueada sem autorização substituta.

## Requisitos e primeira execução

- Windows com Windows PowerShell.
- Node.js compatível: linha 24.x (LTS recomendada) ou 25.x; a major mínima é 24 e majors futuras não são aceitas automaticamente.
- Dependências locais do projeto.

Para o uso normal, execute `Executar.cmd` com duplo clique na raiz. Ele apenas inicia `Executar.ps1` relativo ao pacote, sem alterar a política de execução do PowerShell. `Executar.ps1` é a alternativa técnica/direta. O bootstrap valida Node, npm, `package.json`, `package-lock.json` e dependências. Se Node estiver ausente ou não homologado, pode oferecer a instalação exata autorizada via winget. Recusar a instalação não altera o sistema.

As dependências de runtime já acompanham a distribuição. Com Node homologado instalado, o início normal funciona offline e não executa `npm ci` nem `npm install`. Dependência ausente ou divergente bloqueia a abertura; reextraia uma distribuição íntegra.

A política do Windows PowerShell precisa permitir scripts locais. O SelfMinifier não usa Bypass, não reduz e não altera permanentemente essa política. Sob `Restricted`, `Executar.cmd` mostra a restrição, aponta para este manual e termina com erro. Qualquer mudança apropriada de política deve ser decidida e executada explicitamente pelo usuário ou administrador conforme as regras da máquina ou organização.

Após o bootstrap, o menu principal é:

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

## Configuração

A configuração persistente é `Configuracao\configuracao.ini`; o modelo versionado é `Configuracao\configuracao.ini.example`. Se o arquivo real não existir, o menu informa o caminho e só o cria a partir do modelo após confirmação. Ele nunca sobrescreve uma configuração existente.

O modelo `.example` é distribuído sem preferências pessoais. O INI real é do usuário: não acompanha o pacote, não é versionado e só pode ser criado ou atualizado por uma ação persistente confirmada. A interface é o meio recomendado; edição manual é uma opção avançada. Valores manuais inválidos bloqueiam a operação, sem correção ou fallback silencioso.

Apagar `configuracao.ini` remove apenas as preferências persistentes; não remove backups, estado, relatórios ou logs. Em uma abertura posterior, a ausência é detectada e a criação pode ser oferecida explicitamente. Atualizações do aplicativo nunca sobrescrevem um INI existente; qualquer migração futura deve ser explícita.

Os formatos aceitos são os schemas V2 e V3. O V2 mantém exatamente a semântica existente, sempre com `VersaoSchema=2` e backups internos em `<pasta da aplicação>\_source_versions`:

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

`PastaRaiz` define uma única raiz de projeto, percorrida recursivamente. `TiposArquivo` aceita `CSS`, `JavaScript` ou `CSS+JavaScript`. Exclusões usam `IgnorarPastaNN` e `IgnorarArquivoNN` com caminhos relativos, sem curingas ou `..`.

O V3 preserva todos esses campos e acrescenta `PastaBackups`. Ausente ou vazia, ela significa armazenamento interno; preenchida, deve indicar uma pasta externa absoluta, existente, acessível, gravável, fisicamente separada de `PastaRaiz` e sem symlink, junction, reparse point ou alias. Caminhos relativos, `..`, curingas e variáveis de ambiente são rejeitados.

Configurações sem `VersaoSchema`, com versão diferente de 2 ou 3, com seções antigas `[Origem.xxx]`, com chaves `Incluir*`/`Excluir*` ou com estruturas misturadas são rejeitadas. `PastaBackups` em V2 também é rejeitada. O SelfMinifier não migra ao iniciar: V2 só passa a V3 quando o usuário altera explicitamente o local de backups em **Configurações → Comportamento**. Voltar ao armazenamento interno mantém V3 e não apaga nem move backups existentes.

### Modos de saída e perfis

O modo persistente padrão é **Criar backup e sobrescrever os arquivos originais**. Ele cria e valida uma cópia compactada com GZIP (`.gz`) na raiz efetiva antes de substituir o original: `_source_versions` interno em V2/V3 sem pasta externa, ou `PastaBackups` em V3 externo. Backups legados não compactados continuam restauráveis. A alternativa é **Preservar os arquivos originais e criar arquivos `.min`**, que conserva a fonte e cria um destino `.min.js` ou `.min.css` ao lado dela. O menu Configurações permite editar origem, tipos, exclusões, perfil, modo de saída e local de backups, sempre por escolhas e confirmações numéricas; **Ver configuração atual** distingue V2 interno, V3 interno e V3 externo e mostra o caminho efetivo.

Os perfis disponíveis são `Conservador` (risco muito baixo), `Padrao` (baixo) e `Maximo` (moderado) e podem ser trocados pelo menu; `Personalizado` não é selecionável nesta versão. O motor homologado atual é esbuild para JavaScript e CSS, sem bundling.

O risco estimado da execução é:

- Preservar originais e criar `.min`: Conservador = Baixo; Padrao = Moderado; Maximo = Alto.
- Criar backup e sobrescrever originais: Conservador = Moderado; Padrao = Alto; Maximo = Crítico.

No modo `.min`, destinos preexistentes são listados, preservados e ignorados; não existe autorização para sobrescrevê-los. A quantidade de arquivos é mostrada separadamente como escopo da operação e não muda o nível em 0.1.0. Bloqueios de integridade nunca são convertidos em risco nem relaxados por essa classificação.

## Analisar e minificar

Escolha **Minificar projeto** para ver a raiz do projeto, os tipos efetivos, o perfil e o modo de saída efetivo e, então, **Analisar projeto** ou **Ajustar somente esta execução**. A análise mostra CSS/JavaScript encontrados, ignorados, já minificados e elegíveis, com os motivos de exclusão, e permite **Ver arquivos que serão minificados** ou **Iniciar minificação**. Com 1 a 10 candidatos, a prévia mostra total e lista sem controles de paginação. Com 11 ou mais, usa páginas de 10 e exibe somente os controles anterior/próximo válidos. A análise não modifica arquivos.

**Iniciar minificação** reutiliza a execução V2 validada, que refaz a pré-análise e valida a impressão digital imediatamente antes de escrever. Se o projeto mudou após a análise, a execução é bloqueada e o usuário deve analisar novamente.

Se não houver arquivos a minificar ou se houver bloqueios, a interface explica o resultado e não oferece minificação; nenhum arquivo é alterado.

Se um destino `.min` já existir, ele é listado, preservado e ignorado. A execução V2 nunca o sobrescreve.

## Ajustes temporários

**Configurações persistentes** são gravadas em `configuracao.ini` somente por uma ação persistente com confirmação explícita. Elas contêm a raiz do projeto, tipos CSS/JavaScript, exclusões relativas, perfil, modo de saída e motor homologado.

**Ajustar somente esta execução** está integrado ao fluxo **Minificar projeto** e apresenta exatamente: 1 para manter o modo persistente, 2 para usar backup e sobrescrita, 3 para preservar originais e criar `.min`, e 0 para cancelar. As escolhas 1/2/3 terminam a seleção sem etapa adicional e retornam ao fluxo de minificação. O modo fica apenas em memória, alcança análise e execução e desaparece quando o fluxo termina ou quando outro fluxo independente é iniciado; 0 preserva o ajuste anterior do fluxo corrente, descarta somente a seleção em andamento e nunca modifica o INI.

## Backups e restauração manual

No modo de sobrescrita, a restauração combina backups internos legados com a proveniência persistida em `Dados\Historico`. A raiz registrada na execução é a autoridade, mesmo depois de a configuração atual mudar. Se uma raiz externa histórica estiver indisponível, a execução continua visível com o caminho esperado e a restauração é bloqueada; nunca há fallback para a raiz atual ou para `_source_versions`. Manifesto, histórico, cópia, hashes, caminhos, identidade física e estado técnico são validados antes de formar um plano.

Se o arquivo atual ainda corresponde ao hash minificado registrado, basta a confirmação normal. Se foi alterado ou está ausente, há uma confirmação adicional; recusá-la preserva esse item. O arquivo minificado atual não recebe backup durante a restauração.

No modo `.min`, a opção restaura somente a última execução concluída removendo exatamente saídas que foram criadas nela. Saídas `.min` preexistentes e sobrescritas não são removidas nem restauradas. Uma saída já ausente é apenas reportada; uma saída alterada após a criação exige confirmação adicional antes da exclusão.

Uma restauração interrompida ou ambígua entra em `recovery-required`. Nesse estado, não force nova minificação ou restauração: preserve os arquivos, consulte os logs e corrija o estado somente por um procedimento comprovado.

## Relatórios e logs

Após análise, execução ou restauração, o SelfMinifier pode gerar relatórios operacionais UTF-8 em `Dados\Relatorios` (TXT e CSV) e logs técnicos UTF-8 em `Dados\Logs`. O menu permite listar e visualizar esses arquivos em modo somente leitura.

Relatórios mostram totais, itens ignorados com motivo, resultados de restauração e falhas. Logs técnicos podem conter caminhos, diagnósticos e stack traces; eles não são exibidos como mensagem normal do menu.

## Problemas comuns

- **Configuração ausente ou inválida:** corrija `Configuracao\configuracao.ini` ou crie-o explicitamente a partir do modelo.
- **Origem inacessível, link ou arquivo somente leitura:** o scanner informa o motivo e bloqueia quando o escopo não pode ser comprovado.
- **Destino `.min` preexistente:** revise a lista; o arquivo é preservado e ignorado, sem sobrescrita.
- **Node não homologado:** instale uma linha LTS homologada; não use versões Current, EOL ou globais.
- **PowerShell bloqueia scripts locais/Restricted:** o SelfMinifier não contorna a política. Consulte o administrador ou a política da organização; qualquer alteração deve ser explícita e apropriada ao ambiente.
- **Dependências internas ausentes ou inválidas:** reextraia um pacote íntegro. A inicialização não baixa nem reinstala dependências.
- **`recovery-required`:** não tente contornar o bloqueio; consulte o log técnico e preserve o estado para recuperação comprovada.
