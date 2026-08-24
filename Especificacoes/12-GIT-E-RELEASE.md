# Git e releases

## Fluxo atual aprovado

- O desenvolvimento é conduzido por uma única pessoa, em uma máquina, com assistência de IA e sem desenvolvimento concorrente.
- `main` é a branch ativa de desenvolvimento.
- Não se cria uma branch por prompt, funcionalidade, correção ou alteração documental.
- Branches não são criadas automaticamente.
- O fluxo atual não utiliza pull requests; sua introdução exige necessidade futura concreta.
- Git é usado para histórico, checkpoints, rastreabilidade e recuperação.
- Somente mudanças coerentes, significativas e validadas devem ser commitadas.
- O push deve ser feito para `origin/main` quando a tarefa concluída representar um checkpoint remoto útil.
- Estados sabidamente quebrados, incompletos ou não validados não devem ser enviados.
- Mensagens de commit e comentários destinados a pessoas devem ser escritos em pt-BR, UTF-8, com acentos e `ç` corretos.
- Force-push nunca deve ser usado, salvo pedido explícito em uma tarefa futura.
- A estrutura do repositório deve crescer incrementalmente, sem placeholders vazios para arquitetura futura.
- Não reescanear repetidamente ou verificar arquivos não relacionados do repositório.
- Usar o contexto persistente do projeto (`_ias`, `AGENTS.md`, especificações) em vez de reler todo o repositório.

Verificações Git devem ser feitas quando forem relevantes a commit/push, release, operação destrutiva ou estado inesperado. Não se deve repetir sincronização remota sem motivo concreto.

Testes e validações aplicáveis ao checkpoint seguem `11-TESTES-E-QUALIDADE.md`.

## Versionamento e marcos

Tags poderão identificar releases ou marcos futuros. A estratégia de branches só pode ser reconsiderada se as circunstâncias do projeto mudarem materialmente.

O empacotamento local segue `13-DISTRIBUICAO.md`. A publicação futura de GitHub Release é uma operação separada e não pode ser misturada à geração do pacote local.
