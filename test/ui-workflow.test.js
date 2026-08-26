import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const windowsTest = process.platform === 'win32' ? test : test.skip;

function runPowerShell(script, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'selfminifier-ui-'));
  const file = join(dir, 'harness.ps1');
  try {
    writeFileSync(file, '\uFEFF' + script, 'utf8');
    return execFileSync('powershell.exe', ['-NoProfile', '-File', file, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PAGINATION_HARNESS = `
param([int]$Total, [string]$Inputs)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path (Get-Location).Path 'src\\app\\ui.ps1')
$script:captured = [System.Collections.Generic.List[string]]::new()
function Show-Mensagem { param([string]$Text, [ConsoleColor]$Color = [ConsoleColor]::White) $script:captured.Add($Text) }
function Write-Host { param([object]$Object, [ConsoleColor]$ForegroundColor = [ConsoleColor]::White) $script:captured.Add([string]$Object) }
$script:queue = [System.Collections.Generic.Queue[string]]::new()
foreach ($value in $Inputs -split ',') { if ($value -ne '') { $script:queue.Enqueue($value) } }
function Read-Host { param([string]$Prompt) if ($script:queue.Count -gt 0) { return $script:queue.Dequeue() } return '0' }
$items = @()
for ($i = 0; $i -lt $Total; $i++) {
    $ft = if ($i % 2 -eq 0) { 'css' } else { 'javascript' }
    $items += [pscustomobject]@{ fileType = $ft; relativePath = "arquivo-$i" }
}
$analysis = [pscustomobject]@{ execution = [pscustomobject]@{ items = $items } }
Show-CandidatePreview $analysis
($script:captured -join "\n")
`;

windowsTest('prévia mostra somente o total para 1 a 10 candidatos', () => {
  for (const total of [1, 10]) {
    const output = runPowerShell(PAGINATION_HARNESS, ['-Total', String(total), '-Inputs', '0']);
    assert.ok(output.includes(`Total: ${total}`), `total ${total}: ${output}`);
    assert.ok(!output.includes('Página '), `sem paginação para ${total}: ${output}`);
    assert.ok(!output.includes('Próxima página'), `sem próxima para ${total}`);
    assert.ok(!output.includes('Página anterior'), `sem anterior para ${total}`);
    assert.ok(output.includes('0. Voltar'), `voltar para ${total}`);
  }
});

windowsTest('prévia pagina com total correto e navegação válida', () => {
  const page1 = runPowerShell(PAGINATION_HARNESS, ['-Total', '11', '-Inputs', '0']);
  assert.ok(page1.includes('Página 1 de 2'), page1);
  assert.ok(page1.includes('Total: 11'), page1);
  assert.ok(page1.includes('1. Próxima página'), page1);
  assert.ok(!page1.includes('2. Página anterior'), page1);

  const page2 = runPowerShell(PAGINATION_HARNESS, ['-Total', '11', '-Inputs', '1,0']);
  assert.ok(page2.includes('Página 2 de 2'), page2);
  assert.equal((page2.match(/1\. Próxima página/g) ?? []).length, 1, page2);
  assert.equal((page2.match(/2\. Página anterior/g) ?? []).length, 1, page2);

  const threePages = runPowerShell(PAGINATION_HARNESS, ['-Total', '25', '-Inputs', '1,1,0']);
  assert.ok(threePages.includes('Página 1 de 3'), threePages);
  assert.ok(threePages.includes('Página 2 de 3'), threePages);
  assert.ok(threePages.includes('Página 3 de 3'), threePages);
  assert.ok(threePages.includes('Total: 25'), threePages);
  assert.equal((threePages.match(/1\. Próxima página/g) ?? []).length, 2, threePages);
  assert.equal((threePages.match(/2\. Página anterior/g) ?? []).length, 2, threePages);
});

const FLOW_HARNESS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path (Get-Location).Path 'src\\app\\ui.ps1')
$script:bridgeCalls = [System.Collections.Generic.List[string]]::new()
$script:scanModes = [System.Collections.Generic.List[string]]::new()
$script:lastExecute = $null
function Invoke-SelfMinifierBridge {
    param([hashtable]$Request)
    switch ($Request.command) {
        'summary' {
            $script:bridgeCalls.Add('summary')
            return [pscustomobject]@{
                ok = $true
                configuration = [pscustomobject]@{
                    schemaVersion = 2; engine = 'esbuild'; profile = 'Padrao'
                    outputMode = 'PreservarOriginaisECriarMinificados'
                    projectRoot = 'C:\\Projeto'; fileTypes = @('css','javascript')
                    ignoredFolders = @(); ignoredFiles = @()
                }
            }
        }
        'scan-analysis' {
            $script:bridgeCalls.Add('scan-analysis')
            if ($Request.adjustments -and $Request.adjustments.ContainsKey('outputMode')) { $script:scanModes.Add($Request.adjustments.outputMode) } else { $script:scanModes.Add('') }
            return [pscustomobject]@{
                ok = $true
                analysis = [pscustomobject]@{
                    projectRoot = 'C:\\Projeto'; fileTypes = @('css','javascript')
                    exclusions = [pscustomobject]@{ folders = 0; files = 0 }
                    counts = [pscustomobject]@{ cssFound = 1; javascriptFound = 0; ignored = 0; alreadyMinified = 0; eligible = 1 }
                    ignoredByReason = @()
                    candidates = [pscustomobject]@{ css = @(); javascript = @() }
                    errors = @(); warnings = @()
                    execution = [pscustomobject]@{
                        status = 'ready'
                        items = @([pscustomobject]@{ fileType = 'css'; relativePath = 'site.css' })
                        conflicts = @()
                        diagnostics = [pscustomobject]@{ blockers = @(); warnings = @(); errors = @() }
                        confirmationFingerprint = 'fingerprint-fixo'
                        outputMode = 'BackupESobrescreverOriginais'
                    }
                }
            }
        }
        'execute' {
            $script:bridgeCalls.Add('execute')
            $script:lastExecute = $Request
            return [pscustomobject]@{
                ok = $true
                plan = [pscustomobject]@{ outputMode = 'BackupESobrescreverOriginais' }
                result = [pscustomobject]@{
                    status = 'completed'
                    counts = [pscustomobject]@{ planned = 1; createdSuccessfully = 1; skippedConflicts = 0; failed = 0 }
                    noFilesChanged = $false
                }
            }
        }
        default { return [pscustomobject]@{ ok = $false; code = 'UNKNOWN_COMMAND'; message = '?' } }
    }
}
$script:captured = [System.Collections.Generic.List[string]]::new()
function Show-Mensagem { param([string]$Text, [ConsoleColor]$Color = [ConsoleColor]::White) $script:captured.Add($Text) }
function Write-Host { param([object]$Object, [ConsoleColor]$ForegroundColor = [ConsoleColor]::White) $script:captured.Add([string]$Object) }
$script:queue = [System.Collections.Generic.Queue[string]]::new()
function Read-Host { param([string]$Prompt) if ($script:queue.Count -gt 0) { return $script:queue.Dequeue() } return '0' }

foreach ($value in @('2','2','1','1','0','2','0')) { $script:queue.Enqueue($value) }
Invoke-MinifyProject

foreach ($value in @('1','0','0')) { $script:queue.Enqueue($value) }
Invoke-MinifyProject

$executeMode = if ($script:lastExecute.adjustments -and $script:lastExecute.adjustments.ContainsKey('outputMode')) { $script:lastExecute.adjustments.outputMode } else { '' }
[ordered]@{
    scanCount = @($script:bridgeCalls | Where-Object { $_ -eq 'scan-analysis' }).Count
    executeCount = @($script:bridgeCalls | Where-Object { $_ -eq 'execute' }).Count
    scanModes = ($script:scanModes -join '|')
    executeMode = $executeMode
    executeFingerprint = $script:lastExecute.confirmationFingerprint
} | ConvertTo-Json -Compress
`;

windowsTest('fluxo mantém análise, fingerprint e ajuste temporário até a execução', () => {
  const result = JSON.parse(runPowerShell(FLOW_HARNESS));
  assert.equal(result.scanCount, 2);
  assert.equal(result.executeCount, 1);
  const modes = result.scanModes.split('|');
  assert.equal(modes[0], 'BackupESobrescreverOriginais');
  assert.equal(modes[1], '');
  assert.equal(result.executeMode, 'BackupESobrescreverOriginais');
  assert.equal(result.executeFingerprint, 'fingerprint-fixo');
});

const FORMAT_HARNESS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path (Get-Location).Path 'src\\app\\ui.ps1')
$lines = @()
$lines += Format-Kilobytes 0
$lines += Format-Kilobytes 760422
$lines += Format-Kilobytes (-1200)
$lines += Format-ReductionPercent 31.15
$lines += Format-ReductionPercent (-0.5)
$lines += Format-ReductionPercent 0
$lines -join '|'
`;

windowsTest('formatadores F2 apresentam KB e percentual em pt-BR', () => {
  const output = runPowerShell(FORMAT_HARNESS);
  assert.ok(output.includes('0 KB'), output);
  assert.ok(output.includes('742,6 KB'), output);
  assert.ok(output.includes('-1,2 KB'), output);
  assert.ok(output.includes('31,15%'), output);
  assert.ok(output.includes('-0,50%'), output);
  assert.ok(output.includes('0,00%'), output);
});

const LABEL_HARNESS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path (Get-Location).Path 'src\\app\\ui.ps1')
$lines = @()
$lines += Get-CurrentIntegrityLabel 'MATCH'
$lines += Get-CurrentIntegrityLabel 'NOT_INSPECTED'
$lines += Get-CurrentIntegrityLabel 'FUTURE_STATE'
$lines += Get-HistoricalBackupLabel 'AVAILABLE'
$lines += Get-HistoricalBackupLabel 'NOT_AVAILABLE'
$lines += Get-CompressionLabel 'gzip'
$lines += Get-CompressionLabel 'none'
$lines += Get-CompressionLabel 'zip'
$lines += Get-RestoreClassificationLabel 'unchanged-minified'
$lines += Get-RestoreItemStatusLabel 'restored'
$lines += Get-RestoreResultStatusLabel 'completed-with-skips'
$lines += Get-RestoreIgnoreReasonLabel 'PREEXISTING_MIN_NOT_RESTORED'
$lines += Get-BackupStatusLabel 'unavailable'
$lines -join '|'
`;

windowsTest('F3 mapeia estados técnicos para rótulos PT-BR com fallback seguro', () => {
  const output = runPowerShell(LABEL_HARNESS);
  assert.ok(output.includes('Corresponde ao histórico'), output);
  assert.ok(output.includes('Ainda não inspecionado'), output);
  assert.ok(output.includes('FUTURE_STATE'), output);
  assert.ok(output.includes('Disponível'), output);
  assert.ok(output.includes('Não disponível'), output);
  assert.ok(output.includes('GZIP (compactado)'), output);
  assert.ok(output.includes('Nenhum'), output);
  assert.ok(output.includes('zip'), output);
  assert.ok(output.includes('Minificado inalterado'), output);
  assert.ok(output.includes('restaurado'), output);
  assert.ok(output.includes('concluída com itens ignorados'), output);
  assert.ok(output.includes('saída .min preexistente não será restaurada'), output);
  assert.ok(output.includes('indisponível'), output);
});
