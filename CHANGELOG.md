# Histórico de alterações

## Versões

### 0.2.0-rc.1

- Configuração Schema V2 exclusiva e editável pela interface: origem, tipos, exclusões, perfil, comportamento e visualização atual; remoção definitiva do caminho operacional de Configuração V1.
- Fluxo principal consolidado em **Minificar projeto**, com ajuste temporário de modo restrito ao fluxo, análise quantitativa, prévia sem paginação até 10 candidatos e paginada a partir de 11, e revalidação por fingerprint antes da execução.
- Configuração Schema V3 com `PastaBackups` para armazenamento externo de backups, validação fail-closed de separação física e lexical de `PastaRaiz` e transição V2→V3 explícita pela interface.
- Fundação de proveniência persistente com `SelfMinifier-Tag` e `artifactId` criptográfico de 96 bits, usando SHA-256 dos bytes finais para classificar conteúdo já minificado sem reminificação automática.
- Backups compactados com GZIP e manifesto v2, mantendo compatibilidade de restauração com backups legados não compactados.
- Pesquisa histórica por SelfMinifier-Tag e por caminho, inspeção que separa dado persistido de estado atual e recuperação histórica como exportação exclusiva para destino explícito, sem sobrescrever origem ou saída atuais.
- Restauração normal e recuperação histórica integradas ao menu **Backups e restauração**, com estados de integridade e disponibilidade explícitos e confirmações numéricas.
- Integridade e segurança fail-closed: prova física de caminhos, rejeição de reparse points, journal write-ahead, rollback exato e bloqueio `recovery-required` sem autorização substituta.
- Otimização de desempenho da validação histórica sequencial.
- Correções de encoding UTF-8 nos launchers e preservação da comunicação JSON do bridge sob console UTF-8.
- Documentação alinhada: manuais revisados contra o código, plataforma Windows documentada, dívida futura (Linux/macOS, retenção e arquivamento) registrada como não implementada, e geração HTML corrigida (ênfase e estilo de código).

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
