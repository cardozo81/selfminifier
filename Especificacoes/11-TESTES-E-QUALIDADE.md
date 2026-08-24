# Testes e qualidade

## Política

- Testes são introduzidos junto com a funcionalidade que validam.
- Testes e validações devem ser focados e proporcionais à mudança.
- Suítes amplas não devem ser criadas prematuramente.
- Testes não devem existir apenas para aumentar sua quantidade ou produzir aparência de cobertura.
- A validação completa do sistema é apropriada antes de release ou publicação e após mudanças transversais ou de alto risco.
- A matriz futura é cumulativa; ela não determina que todos os testes sejam criados antecipadamente.
- Validação de UTF-8 e mojibake é obrigatória quando texto destinado a pessoas ou codificação de arquivos for afetado.
- A execução da suíte completa não é obrigatória a cada alteração de código; testes direcionados ao comportamento afetado costumam ser a evidência adequada.
- Validação mais ampla é apropriada em marcos relevantes, releases, mudanças críticas ou quando a evidência direcionada for insuficiente.

## Matriz cumulativa

À medida que cada comportamento for implementado, a cobertura deve incluir:

### Configuração e seleção

- parsing do INI e configuração inválida;
- precedência entre glob, inclusões e exclusões;
- deduplicação;
- múltiplas raízes.

### Minificação

- contrato de minificador, adaptadores e perfis;
- minificação JavaScript e CSS;
- os dois modos de saída;
- nomenclatura `.min`.

### Integridade e backup

- backup da fonte, hash e manifesto;
- sobrescrita segura;
- detecção de arquivo já minificado;
- falha parcial;
- restauração de backup;
- confirmação para restaurar arquivo modificado depois da minificação;
- arquivos readonly;
- symlinks e junctions.

### Transação `.min`

- listagem completa de conflitos;
- confirmação global de sobrescrita;
- cancelamento sem mutação residual;
- conflito tardio inesperado;
- rollback exato sem exclusão por curinga;
- preservação e restauração transacional de `.min` preexistente;
- controle `ultima-execucao.bkp`;
- restauração manual que exclui somente `.min` criado na última execução;
- confirmação antes de excluir `.min` alterado depois da criação.

### Operação e plataforma

- codificação e mojibake;
- logs e relatórios;
- bootstrap e política de runtime.
- matriz e determinação obrigatória do risco de execução;
- bytes CRLF e execução do launcher por `cmd.exe` real;
- startup offline com dependências de runtime geradas por instalação limpa;
- bloqueio legível sob Execution Policy que não permita scripts locais.

Nenhum desses testes deve ser criado antes da funcionalidade correspondente.
