# Histórico de alterações

## Não lançado

### 0.2.0

- Configuração Schema V2 exclusiva e editável pela interface, incluindo origem, tipos, exclusões, perfil, comportamento e visualização atual.
- Fluxo principal consolidado em **Minificar projeto**, com ajuste temporário de modo restrito ao fluxo, análise quantitativa, prévia opcional e revalidação por fingerprint antes da execução.
- Prévia sem paginação para até 10 candidatos e com páginas de 10 e controles contextuais a partir de 11 candidatos.
- Remoção definitiva do caminho operacional de Configuração V1 e atualização dos testes e manuais correspondentes.

### 0.1.2

- Compatibilidade explícita com Node.js 25.x, incluindo validação de Node.js 25.8.2.
- Política de runtime com major mínima 24 e bloqueio de majors futuras não listadas.
- Node.js 24.x permanece a linha LTS preferida; Node.js 25.x compatível não aciona instalação automática da linha 24.
- Dependência direta `ini` fixada em 6.0.0, compatível com Node.js 24.x e 25.x, preservando o contrato de configuração existente.
- Validação fail-closed dos engines declarados pelas dependências diretas e teste do launcher alinhado à política efetiva do host.

### 0.1.1

- Preparação explícita e segura das dependências locais ausentes ou divergentes durante `publicar.cmd`, com revalidação e continuação automática.
- Launcher de empacotamento sem bypass de Execution Policy, com código de saída preservado e mensagem visível no duplo clique.
- Empacotamento continua usando staging limpo de runtime com `npm ci --omit=dev`, separado do `node_modules` do checkout.

### Adicionado

- Estrutura documental inicial, convenções do repositório e harness para desenvolvimento assistido por IA.
- Fundação inicial de domínio, configuração INI estrita, validação de UTF-8 e testes focados com o runner nativo do Node.js.
- Contrato neutro de minificação, registry homologada e adapter esbuild para JavaScript e CSS.
- Scanner read-only com seleção glob via micromatch, exclusões técnicas, classificação JS/CSS, diagnósticos de links/readonly e deduplicação.
- Fundação de integridade com SHA-256 incremental, estado técnico, manifesto UTF-8 e backup de fontes validado por hash.
- Pré-análise imutável e execução transacional dos dois modos, com journal write-ahead, conflitos globais, rollback exato e recuperação de interrupções.
- Política Node.js homologada e bootstrap Windows leve, com instalação winget autorizada e validação reproduzível de npm/dependências.
- Interface PowerShell, bridge JSON, logs técnicos, relatórios operacionais e restauração manual segura.
- Manuais do usuário e técnico em Markdown, com build HTML offline local.
- Versão de desenvolvimento `0.1.1` e empacotamento local allowlisted com ZIP e checksum SHA-256 validados.
