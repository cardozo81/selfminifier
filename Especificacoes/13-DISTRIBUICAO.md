# Distribuição

## Entrada de publicação local

O lançador local planejado é `publicar.cmd`. Ele deve apenas delegar para:

`scripts\release\publicar.ps1`

CMD não contém a lógica de empacotamento.

## Pipeline fail-closed

O empacotamento local futuro deve bloquear em qualquer prova insuficiente e percorrer:

1. validação do ambiente;
2. validação da versão;
3. validação do worktree, quando aplicável;
4. validação de UTF-8 e mojibake;
5. validação de `package.json` e `package-lock.json`;
6. testes apropriados ao pacote;
7. build da documentação HTML;
8. montagem limpa do pacote;
9. validação do pacote montado;
10. geração do ZIP;
11. cálculo de SHA-256.

Artefatos gerados ficam em `dist\`.

## Layout aprovado do pacote local

`package.json` é a autoridade única de versão. O pacote usa a raiz versionada `dist\SelfMinifier-<version>\` e gera `dist\SelfMinifier-<version>.zip` e `dist\SelfMinifier-<version>.zip.sha256`.

A montagem usa allowlist e preserva os caminhos relativos do runtime:

```text
SelfMinifier-<version>\
  Executar.cmd
  Executar.ps1
  package.json
  package-lock.json
  node_modules\
  LEIA-ME.txt
  Configuracao\configuracao.ini.example
  src\
  resources\
  Documentacao\Gerada\Manual-Usuario\index.html
  Documentacao\Gerada\Manual-Tecnico\index.html
```

`src\` contém somente módulos JavaScript, MJS e PowerShell; `resources\` contém somente JSON requerido pelo runtime. `node_modules\` é gerado exclusivamente para a distribuição por instalação limpa e reproduzível em staging descartável, usando `package.json`, `package-lock.json` e somente dependências de produção. O checkout de desenvolvimento nunca é a fonte dessa árvore. O ZIP contém exatamente uma raiz `SelfMinifier-<version>/`.

`Executar.cmd` é a entrada recomendada para uso normal por duplo clique e delega para `Executar.ps1` relativo ao próprio pacote, sem alterar a política de execução. `LEIA-ME.txt` é a orientação prática destinada ao usuário; o README de desenvolvimento não integra o pacote.

O `Executar.cmd` empacotado usa UTF-8 sem BOM e CRLF validado por bytes. Ele não usa `ExecutionPolicy Bypass`, não altera política persistente, preserva o código de saída e pausa somente em falha. Se a política efetiva for `Restricted`, bloqueia com explicação e aponta para o manual offline.

O checksum usa SHA-256 em texto convencional: hash hexadecimal minúsculo, dois espaços e o nome do ZIP.

## Identidade de versão

`package.json` é a fonte única da versão SemVer. A identidade validada mantém a invariância `package.json.version = SelfMinifier-<version> = SelfMinifier-<version>.zip = SelfMinifier-<version>.zip.sha256 = futura tag v<version> = futura versão do GitHub Release`. A futura publicação deve reutilizar exatamente o ZIP e o checksum validados localmente. Tags publicadas são imutáveis; conteúdo alterado exige nova versão. Esta tarefa não cria tag nem release.

## Exclusões da distribuição

O pacote não deve incluir conteúdo exclusivo de desenvolvimento ou dados locais, incluindo:

- `.git` e `.github`;
- `_ias` e `Especificacoes`;
- testes e fixtures;
- scripts exclusivos de desenvolvimento;
- logs, relatórios e estado locais;
- configuração pessoal do desenvolvedor;
- `dist` anterior;
- `node_modules` de desenvolvimento ou copiado do checkout; somente a árvore de runtime gerada no staging de publicação é permitida.

A composição final deve ser construída em destino limpo e validada antes da compactação.

## Separação de operações

Empacotamento local e publicação de GitHub Release são operações independentes. A automação futura de GitHub Release não pode ser incorporada ao processo que gera o pacote local.

Versões exatas de dependências futuras continuam sendo decididas quando cada dependência for introduzida.
