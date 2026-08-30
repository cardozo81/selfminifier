import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('UI explicita cancelamento, entrada inválida e recursos indisponíveis', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /Opção inválida; nenhuma ação foi executada/);
  assert.match(source, /Análise cancelada; nenhum arquivo foi alterado/);
  assert.match(source, /Listar backups conhecidos e restaurar/);
  assert.match(source, /Restauração cancelada; nenhum arquivo foi alterado/);
  assert.match(source, /Nenhum relatório operacional disponível/);
  assert.match(source, /Nenhum log técnico disponível/);
  assert.match(source, /Invoke-SelfMinifierBridge/);
  assert.match(source, /StandardInput\.BaseStream/);
  assert.match(source, /Criar backup e sobrescrever os arquivos originais/);
  assert.match(source, /Preservar os arquivos originais e criar arquivos \.min/);
  assert.doesNotMatch(source, /Cancelar e voltar ao menu/);
  assert.match(source, /'1' \{ \[void\]\$Adjustments\.Remove\('outputMode'\).*return \}/);
  assert.match(source, /'2' \{ \$Adjustments\.outputMode = 'BackupESobrescreverOriginais'.*return \}/);
  assert.match(source, /'3' \{ \$Adjustments\.outputMode = 'PreservarOriginaisECriarMinificados'.*return \}/);
  assert.doesNotMatch(source, /4\. Aplicar os ajustes desta execução/);
  assert.doesNotMatch(source, /risco da execução ainda não possui estimativa|EXECUTION_RISK_ALGORITHM_PENDING/);
  assert.match(source, /command = 'scan-analysis'; adjustments = \$Adjustments/);
  assert.match(source, /Invoke-ScanAnalysis \$ajustes/);
  assert.match(source, /command = 'execute'[\s\S]*adjustments = \$Adjustments[\s\S]*confirmationFingerprint = \$analysis\.execution\.confirmationFingerprint/);
  assert.doesNotMatch(source, /authorizeOverwriteConflicts|Invoke-Analyze/);
  assert.doesNotMatch(source, /Modo temporário \(vazio mantém o persistente/);
  const bytes = await readFile(new URL('../src/app/ui.ps1', import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
});

test('UI configurações expõe menu final, view V2 read-only e delega Comportamento ao editor persistente existente', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /function Show-ConfigurationMenu/);
  assert.match(source, /1\. Pasta raiz do projeto/);
  assert.match(source, /2\. Tipos de arquivo/);
  assert.match(source, /3\. Exclusões/);
  assert.match(source, /4\. Perfil de minificação/);
  assert.match(source, /5\. Comportamento/);
  assert.match(source, /6\. Ver configuração atual/);
  assert.match(source, /0\. Voltar/);
  assert.match(source, /'2' \{ Show-ConfigurationMenu \}/);
  assert.match(source, /'5' \{ Invoke-PersistentConfiguration \}/);
  assert.match(source, /'6' \{ Show-CurrentConfiguration \}/);
  assert.match(source, /function Invoke-PersistentConfiguration/);
  assert.match(source, /command = 'update-output-mode'; outputMode = \$newMode; confirmed = \$true/);
  assert.match(source, /Nenhuma configuração foi alterada/);
  assert.match(source, /command = 'summary'/);
  assert.match(source, /\$config = \$summary\.configuration/);
  assert.match(source, /Pasta raiz do projeto:/);
  assert.match(source, /Tipos de arquivo \(TiposArquivo\):/);
  assert.match(source, /Perfil \(Perfil\):/);
  assert.match(source, /Comportamento de saída \(ModoSaida\):/);
  assert.match(source, /Pastas ignoradas:/);
  assert.match(source, /Arquivos ignorados:/);
  assert.match(source, /Nenhuma/);
  assert.match(source, /Nenhum/);
  assert.doesNotMatch(source, /Schema detectado:|não está no schema V2|schema -ne 'v2'/);
});

test('UI B1.2 expõe edição de origem e tipos de arquivo com confirmação numérica', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /function Invoke-EditProjectRoot/);
  assert.match(source, /function Invoke-EditFileTypes/);
  assert.match(source, /'1' \{ Invoke-EditProjectRoot \}/);
  assert.match(source, /'2' \{ Invoke-EditFileTypes \}/);
  assert.match(source, /Pasta raiz atual:/);
  assert.match(source, /Informe a nova pasta raiz do projeto/);
  assert.match(source, /Nova pasta raiz:/);
  assert.match(source, /1\. Salvar alteração/);
  assert.match(source, /command = 'update-configuration-v2'; projectRoot = \$entrada; confirmed = \$true/);
  assert.match(source, /command = 'update-configuration-v2'; fileTypes = \$novoValor; confirmed = \$true/);
  assert.match(source, /1\. CSS/);
  assert.match(source, /2\. JavaScript/);
  assert.match(source, /3\. CSS \+ JavaScript/);
  assert.match(source, /Tipos atuais:/);
  assert.match(source, /Novos tipos:/);
  assert.match(source, /Nenhuma configuração foi alterada/);
  assert.match(source, /'5' \{ Invoke-PersistentConfiguration \}/);
  assert.match(source, /'6' \{ Show-CurrentConfiguration \}/);
});

test('UI B1.3 expõe edição de exclusões com adição/remoção numerada', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /function Invoke-EditExclusions/);
  assert.match(source, /function Invoke-EditIgnoredFolders/);
  assert.match(source, /function Invoke-EditIgnoredFiles/);
  assert.match(source, /function Add-ExclusionEntry/);
  assert.match(source, /function Remove-ExclusionEntry/);
  assert.match(source, /'3' \{ Invoke-EditExclusions \}/);
  assert.match(source, /1\. Pastas ignoradas/);
  assert.match(source, /2\. Arquivos ignorados/);
  assert.match(source, /3\. Ver exclusões atuais/);
  assert.match(source, /1\. Adicionar pasta/);
  assert.match(source, /2\. Remover pasta/);
  assert.match(source, /3\. Ver lista/);
  assert.match(source, /1\. Adicionar arquivo/);
  assert.match(source, /2\. Remover arquivo/);
  assert.match(source, /Informe a pasta relativa que deve ser ignorada\./);
  assert.match(source, /Informe o arquivo relativo que deve ser ignorado\./);
  assert.match(source, /Exemplo = 'node_modules'/);
  assert.match(source, /Exemplo = 'src\\config\.js'/);
  assert.match(source, /Exemplo: \$\(\$info\.Exemplo\)/);
  assert.match(source, /1\. Adicionar/);
  assert.match(source, /1\. Remover/);
  assert.match(source, /0\. Cancelar/);
  assert.match(source, /O valor já está configurado\./);
  assert.match(source, /Não há pastas ignoradas para remover\./);
  assert.match(source, /Não há arquivos ignorados para remover\./);
  assert.match(source, /Seleção inválida; nenhuma configuração foi alterada\./);
  assert.match(source, /command = 'update-configuration-v2'; confirmed = \$true/);
  assert.match(source, /\$request\[\$info\.Field\] = \$novaLista/);
});

test('UI B1.4 remove placeholders e adiciona perfil com confirmação numérica', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Interface e mensagens/);
  assert.doesNotMatch(source, /Pastas e dados do programa/);
  assert.doesNotMatch(source, /Restaurar configurações padrão/);
  assert.doesNotMatch(source, /não está disponível nesta etapa da implementação/);
  assert.doesNotMatch(source, /Show-ConfigNotAvailable/);
  assert.match(source, /function Invoke-EditProfile/);
  assert.match(source, /'4' \{ Invoke-EditProfile \}/);
  assert.match(source, /Perfil atual:/);
  assert.match(source, /Novo perfil:/);
  assert.match(source, /1\. Conservador/);
  assert.match(source, /2\. Padrão/);
  assert.match(source, /3\. Máximo/);
  assert.doesNotMatch(source, /Personalizado/);
  assert.match(source, /command = 'update-configuration-v2'; profile = \$novoPerfil; confirmed = \$true/);
  assert.match(source, /1\. Criar configuração/);
  assert.match(source, /1\. Salvar alteração/);
  assert.doesNotMatch(source, /Confirmar-Acao 'Criar a configuração a partir do modelo/);
  assert.doesNotMatch(source, /Confirmar-Acao 'Salvar esta configuração para as próximas execuções/);
});

test('UI B2 consolida Minificar projeto e remove entradas principais duplicadas', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /1\. Minificar projeto/);
  assert.match(source, /2\. Configurações/);
  assert.match(source, /3\. Backups e restauração/);
  assert.match(source, /4\. Relatórios/);
  assert.match(source, /5\. Logs técnicos/);
  assert.match(source, /0\. Sair/);
  assert.doesNotMatch(source, /1\. Analisar arquivos/);
  assert.doesNotMatch(source, /2\. Minificar/);
  assert.doesNotMatch(source, /3\. Ajustar somente esta execução/);
  assert.match(source, /'1' \{ Invoke-MinifyProject \}/);
  assert.match(source, /'2' \{ Show-ConfigurationMenu \}/);
  assert.match(source, /'3' \{ Show-RestoreMenu \}/);
  assert.match(source, /'4' \{ Show-Artefatos reports \}/);
  assert.match(source, /'5' \{ Show-Artefatos logs \}/);
  assert.match(source, /function Invoke-MinifyProject/);
  assert.match(source, /Projeto: \$\(\$config\.projectRoot\)/);
  assert.match(source, /Tipos: \$\(Get-TiposArquivoDescricao \$config\.fileTypes\)/);
  assert.match(source, /Perfil: \$\(Get-PerfilDescricao \$config\.profile\)/);
  assert.match(source, /Modo de saída: \$\(Get-ModoSaidaDescricao \$modoEfetivo\)/);
  assert.match(source, /1\. Analisar projeto/);
  assert.match(source, /2\. Ajustar somente esta execução/);
  assert.match(source, /'1' \{ Invoke-ScanAnalysis \$ajustes \}/);
  assert.match(source, /'2' \{ Invoke-TemporaryAdjustment \$ajustes \}/);
  assert.match(source, /A minificação está bloqueada:/);
  assert.match(source, /Nenhum arquivo será minificado nesta análise\./);
  assert.match(source, /O projeto mudou após a análise\. Analise novamente antes de minificar\./);
  assert.match(source, /1\. Ver arquivos que serão minificados/);
  assert.match(source, /Get-ModoSaidaDescricao \$execution\.plan\.outputMode/);
});

test('UI B2.1 corrige prévia paginada e ciclo de vida do ajuste temporário', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /function Invoke-TemporaryAdjustment/);
  assert.match(source, /param\(\[hashtable\]\$Adjustments\)/);
  assert.match(source, /\$ajustes = @\{\}/);
  assert.match(source, /Invoke-TemporaryAdjustment \$ajustes/);
  assert.match(source, /Invoke-ScanAnalysis \$ajustes/);
  assert.doesNotMatch(source, /script:TemporaryAdjustments/);
  assert.doesNotMatch(source, /Cancelar e voltar ao menu/);
  assert.match(source, /"Total: \$total"/);
  assert.match(source, /"Página \$page de \$totalPages"/);
  assert.match(source, /if \(\$page -lt \$totalPages\) \{ Write-Host '1\. Próxima página' \}/);
  assert.match(source, /if \(\$page -gt 1\) \{ Write-Host '2\. Página anterior' \}/);
  assert.doesNotMatch(source, /Página \$page de \$totalPages \(Total: \$total\)/);
});

test('UI F1 mostra candidatos e tamanho total em KB', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /Arquivos candidatos:/);
  assert.match(source, /Tamanho dos candidatos:/);
  assert.match(source, /function Format-Kilobytes/);
  assert.match(source, /\$Analysis\.counts\.candidateBytes/);
  assert.match(source, /1KB/);
  assert.doesNotMatch(source, /Arquivos elegíveis/);
});

test('UI F2 mostra resumo consolidado de redução a partir do resultado', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /Minificados:/);
  assert.match(source, /Tamanho antes:/);
  assert.match(source, /Tamanho após:/);
  assert.match(source, /Redução:/);
  assert.match(source, /function Format-ReductionPercent/);
  assert.match(source, /\$execution\.result\.summary\.processedCount/);
  assert.match(source, /\$execution\.result\.summary\.originalBytes/);
  assert.match(source, /\$execution\.result\.summary\.finalBytes/);
  assert.match(source, /\$execution\.result\.summary\.reductionBytes/);
  assert.match(source, /\$execution\.result\.summary\.reductionPercent/);
});

test('UI F4 apresenta primeira execução com menu restrito e criação guiada', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /CONFIGURAÇÃO NECESSÁRIA/);
  assert.match(source, /CONFIGURAÇÃO INVÁLIDA/);
  assert.match(source, /O SelfMinifier ainda não possui uma configuração válida\./);
  assert.match(source, /O arquivo configuracao\.ini existe, mas não pôde ser validado\./);
  assert.match(source, /Nenhuma configuração será corrigida ou substituída automaticamente\./);
  assert.match(source, /1\. Criar configuração inicial/);
  assert.match(source, /1\. Corrigir configuração/);
  assert.match(source, /2\. Backups, restauração e histórico/);
  assert.match(source, /function Invoke-CreateInitialConfiguration/);
  assert.match(source, /command = 'create-configuration'; projectRoot = \$entrada/);
  assert.match(source, /command = 'create-configuration'; projectRoot = \$entrada; confirmed = \$true/);
  assert.match(source, /Confirmar-Acao 'Confirmar a criação da configuração'/);
  assert.match(source, /Pasta raiz:/);
  assert.match(source, /Tipos de arquivo:/);
  assert.match(source, /Perfil:/);
  assert.match(source, /Modo de saída:/);
  assert.match(source, /Pastas ignoradas:/);
  assert.match(source, /function Start-SelfMinifierUi/);
  assert.match(source, /CONFIGURATION_MISSING/);
});

test('UI F4 humaniza status, separa telas e preserva resultado até continuar', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /function Get-ExecutionStatusLabel/);
  assert.match(source, /'completed' \{ return 'Concluída' \}/);
  assert.match(source, /function Confirmar-Continuar/);
  assert.match(source, /Pressione Enter para continuar\.\.\./);
  assert.match(source, /function Limpar-Tela/);
  assert.match(source, /Clear-Host/);
  assert.match(source, /Minificação em andamento\.\.\./);
  assert.match(source, /Analisando o projeto\.\.\./);
  assert.match(source, /Aguarde\./);
  assert.match(source, /MINIFICAÇÃO CONCLUÍDA/);
  assert.match(source, /ANÁLISE CONCLUÍDA/);
  assert.match(source, /function Show-ExecutionResult/);
  assert.match(source, /Status: \$\(Get-ExecutionStatusLabel/);
  assert.match(source, /Operação concluída com sucesso\./);
  assert.doesNotMatch(source, /%\s*\.\.\.|progresso|Progress/);
});

test('UI usa linguagem compreensível para a raiz do projeto e IDs de backup [Bn]', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /PASTA RAIZ DO PROJETO/);
  assert.match(source, /Pasta raiz atual:/);
  assert.match(source, /Informe a nova pasta raiz do projeto\. 0 = Cancelar/);
  assert.match(source, /Pasta raiz do projeto \(caminho completo\)/);
  assert.match(source, /a pasta onde estão os arquivos do projeto que serão analisados e minificados/);
  assert.doesNotMatch(source, /PastaRaiz/);
  assert.match(source, /BACKUPS CONHECIDOS/);
  assert.match(source, /function Show-AppScreen/);
  assert.match(source, /\$backupId = 'B' \+ \(\$index \+ 1\)/);
  assert.match(source, /Digite o ID do backup a restaurar \(ex\.: B1\)/);
  assert.doesNotMatch(source, /cancelar:'\)/);
  assert.match(source, /B\(\[1-9\]\[0-9\]\*\)/);
  assert.match(source, /ID inválido; use o formato B1, B2/);
  assert.match(source, /ID fora da lista; escolha um ID exibido/);
});

test('UI D1 expõe tela de uso de armazenamento e item do menu principal', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /6\. Uso de armazenamento/);
  assert.match(source, /'6' \{ Show-StorageUsage \}/);
  assert.match(source, /function Show-StorageUsage/);
  assert.match(source, /USO DE ARMAZENAMENTO/);
  assert.match(source, /Total contabilizado:/);
  assert.match(source, /Não inclui estado técnico de runtime, recuperação ou dados temporários\./);
  assert.match(source, /function Format-StorageSize/);
  assert.match(source, /command = 'storage-usage'/);
});

test('UI D2 expõe limpeza de relatórios e logs técnicos com confirmação', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /7\. Limpar relatórios/);
  assert.match(source, /8\. Limpar logs técnicos/);
  assert.match(source, /'7' \{ Invoke-ArtifactCleanup reports \}/);
  assert.match(source, /'8' \{ Invoke-ArtifactCleanup logs \}/);
  assert.match(source, /function Invoke-ArtifactCleanup/);
  assert.match(source, /command = 'cleanup-artifacts'/);
  assert.match(source, /Candidatos à limpeza:/);
  assert.match(source, /A exclusão é permanente e não pode ser desfeita\./);
  assert.match(source, /Confirmar a exclusão dos artefatos exibidos/);
});

test('todas as telas interativas identificadas usam o ciclo de tela comum', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  const screens = [
    'Start-SelfMinifierUi', 'Invoke-MinifyProject', 'Show-ConfigurationMenu', 'Show-RestoreMenu',
    'Show-Artefatos', 'Show-StorageUsage', 'Invoke-ArtifactCleanup', 'Show-MissingConfigurationMenu', 'Show-InvalidConfigurationMenu',
    'Invoke-EditProjectRoot', 'Invoke-KnownBackupRestoreSelection', 'Invoke-EditFileTypes',
    'Invoke-PersistentConfiguration', 'Invoke-EditOutputMode', 'Invoke-EditBackupRoot',
    'Invoke-EditExclusions', 'Invoke-EditIgnoredFolders', 'Invoke-EditIgnoredFiles',
    'Add-ExclusionEntry', 'Remove-ExclusionEntry', 'Show-CurrentConfiguration',
    'Show-IgnoredFoldersList', 'Show-IgnoredFilesList', 'Show-CurrentExclusions',
    'Invoke-EditProfile', 'Invoke-TemporaryAdjustment', 'Invoke-ScanAnalysis',
    'Show-CandidatePreview', 'Invoke-CreateInitialConfiguration', 'Show-CorrectConfiguration',
    'Invoke-SearchHistoricalTag', 'Invoke-SearchHistoryByPath', 'Invoke-HistoricalArtifactFlow',
    'Invoke-HistoricalRecoveryExport',
  ];
  for (const name of screens) {
    const start = source.indexOf(`function ${name} {`);
    assert.ok(start !== -1, name);
    const next = source.indexOf('\nfunction ', start + 1);
    const body = next === -1 ? source.slice(start) : source.slice(start, next);
    assert.match(body, /Show-AppScreen/, name);
  }
});
