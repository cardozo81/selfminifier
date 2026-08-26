# Logs e relatórios

## Separação

Log técnico e relatório operacional para o usuário são artefatos distintos.

## Log técnico

Local planejado:

`Dados\Logs\tecnico-YYYYMMDD-HHMMSS.log`

Pode conter:

- versão;
- fases e tempos;
- dependências;
- exceções e stack traces;
- caminhos técnicos;
- códigos de saída;
- diagnósticos.

Pesquisa por Tag/caminho, inspeção histórica e recuperação/exportação reutilizam esse log. Devem registrar comando, duração, sucesso ou bloqueio, códigos e metadados necessários à investigação, sem persistir conteúdo de arquivos ou dados apenas de apresentação. Falha ao registrar não muda o contrato funcional nem mascara o diagnóstico original.

## Relatórios operacionais

Locais planejados:

- `Dados\Relatorios\execucao-YYYYMMDD-HHMMSS.txt`
- `Dados\Relatorios\execucao-YYYYMMDD-HHMMSS.csv`

Os relatórios operacionais devem ser escritos em pt-BR e não devem expor stack traces brutos.

Os dados por arquivo devem incluir, conforme aplicável:

- caminho e tipo;
- status e motivo;
- tamanhos original e final;
- redução em bytes e percentual;
- última modificação;
- data da minificação;
- motor e versão;
- perfil;
- duração;
- modo de saída;
- destino produzido.

Todo item ignorado deve possuir motivo e permanecer nos totais. Nenhum item pode desaparecer silenciosamente das contagens.

Os períodos de retenção automática de logs e relatórios permanecem pendentes em `15-DECISOES.md`.
