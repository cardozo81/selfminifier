# Premissas do projeto

## Produto

O SelfMinifier é uma ferramenta para Windows destinada à minificação controlada e segura de arquivos JavaScript e CSS. A direção arquitetural aprovada é:

`interface interativa em PowerShell` → `aplicação Node.js` → `núcleo` → `abstração neutra de minificador` → `adaptadores homologados`

O motor, os tipos suportados e os limites de minificação são definidos em `07-MINIFICACAO-E-MOTORES.md`.

A evolução multiplataforma é dívida técnica estratégica futura (DT-MP, registrada em `15-DECISOES.md`) e não altera o suporte atual: o Windows permanece a única plataforma suportada, e nenhuma outra plataforma é declarada suportada antes de qualificação explícita.

## Regra fundamental

```text
CERTEZA + REGRA EXPLÍCITA
→ EXECUTA

DÚVIDA / AMBIGUIDADE / ESTADO NÃO COMPROVADO
→ NÃO MODIFICA
→ REPORTA
```

Princípio obrigatório: **“Nenhuma conveniência de UX poderá reduzir as proteções de integridade.”**

As condutas proibidas e as proteções específicas estão em `10-SEGURANCA-E-INTEGRIDADE.md`.

## Prioridades do produto

1. Integridade dos arquivos
2. Segurança e comportamento explícito
3. Possibilidade de recuperação
4. Rastreabilidade
5. Previsibilidade
6. Clareza para o usuário
7. Compatibilidade
8. Redução obtida pela minificação
9. Conveniência

## Idioma e codificação

- Todo conteúdo destinado a pessoas deve ser escrito em pt-BR.
- Identificadores internos de código podem usar EN-US.
- Todo texto deve usar UTF-8; mojibake é proibido.
- Acentos, `ç` e demais caracteres do português devem ser preservados corretamente.
- Entrada e saída textual em Node.js devem declarar UTF-8 explicitamente.
- A codificação em PowerShell e Windows deve receber validação específica.
- Scripts PowerShell executados pelo Windows PowerShell usam UTF-8 com BOM; launchers `.cmd` usam UTF-8 sem BOM e finais de linha CRLF.
- A futura documentação HTML deve conter `<meta charset="utf-8">` e `<html lang="pt-BR">`.
- Remover acentos para contornar um problema de encoding não é aceitável.
- Substituir texto Unicode correto por ASCII não é uma solução aceitável.
- Usar escapes Unicode desnecessários em texto destinado a pessoas também não é aceitável.
- Problemas de encoding devem ser corrigidos na causa (arquivo, leitura ou escrita), nunca mascarados.

Exemplos de texto correto:

```text
Configuração
Minificação
Não foi possível
Usuário
```

Mojibake proibido (representado por pontos de código para não reintroduzir corrupção):

```text
Configura\u00C3\u00A7\u00C3\u00A3o
Minifica\u00C3\u00A7\u00C3\u00A3o
N\u00C3\u00A3o
Usu\u00C3\u00A1rio
```

Não é aceitável normalizar o texto correto para:

```text
Configuracao
Minificacao
Nao foi possivel
Usuario
```

## Desenvolvimento

- O desenvolvimento é incremental, conduzido por uma única pessoa e assistido por IA.
- O fluxo atual trabalha diretamente na branch `main`, sem uma branch por tarefa e sem pull request.
- Testes e validações devem ser focados e proporcionais ao comportamento introduzido.
- A estrutura do repositório cresce somente quando necessária; diretórios vazios e placeholders de arquitetura futura são proibidos.
- Commits e pushes são feitos apenas em checkpoints coerentes, significativos e validados.
- Prompts para IA devem ser concisos e normalmente podem usar EN-US.
- `AGENTS.md`, `_ias/INDEX.md` e estas especificações reduzem repetição de contexto e orientam os agentes às fontes autoritativas.

O fluxo Git completo está em `12-GIT-E-RELEASE.md`, e a política de qualidade está em `11-TESTES-E-QUALIDADE.md`.
