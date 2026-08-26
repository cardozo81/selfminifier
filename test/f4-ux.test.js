import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const windowsTest = process.platform === 'win32' ? test : test.skip;

function runScenario(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'selfminifier-f4-ux-'));
  const harness = join(dir, 'harness.ps1');
  try {
    writeFileSync(harness, '\uFEFF' + HARNESS, 'utf8');
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', harness, '-Scenario', scenario], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    }).trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function outputText(result) {
  return result.output.join('\n');
}

const HARNESS = `
param([Parameter(Mandatory = $true)][string]$Scenario)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path (Get-Location).Path 'src\\app\\ui.ps1')
$script:captured = [System.Collections.Generic.List[string]]::new()
$script:bridgeCalls = [System.Collections.Generic.List[string]]::new()
$script:queue = [System.Collections.Generic.Queue[string]]::new()
function Show-Mensagem { param([string]$Text, [ConsoleColor]$Color = [ConsoleColor]::White) $script:captured.Add($Text) }
function Write-Host { param([object]$Object, [ConsoleColor]$ForegroundColor = [ConsoleColor]::White) $script:captured.Add([string]$Object) }
function Read-Host { param([string]$Prompt) if ($script:queue.Count -gt 0) { return $script:queue.Dequeue() } return '' }
function Add-Inputs { param([string[]]$Values) foreach ($value in $Values) { $script:queue.Enqueue($value) } }
function Invoke-SelfMinifierBridge {
    param([hashtable]$Request)
    $script:bridgeCalls.Add($Request.command)
    switch ($Request.command) {
        'create-configuration' {
            if ($Request.projectRoot -eq 'INVALIDO') {
                return [pscustomobject]@{ ok = $false; diagnostic = [pscustomobject]@{ code = 'ABSOLUTE_PATH_REQUIRED'; message = 'caminho invalido' } }
            }
            if ($Request.confirmed -eq $true) {
                return [pscustomobject]@{ ok = $true; created = $true; configurationPath = 'C:\\Temp\\configuracao.ini' }
            }
            return [pscustomobject]@{
                ok = $true; preview = $true
                configuration = [pscustomobject]@{
                    schemaVersion = 2; engine = 'esbuild'; profile = 'Padrao'
                    outputMode = 'BackupESobrescreverOriginais'
                    projectRoot = $Request.projectRoot; fileTypes = @('css', 'javascript')
                    ignoredFolders = @('node_modules', '.git', 'vendor'); ignoredFiles = @()
                }
            }
        }
        default { return [pscustomobject]@{ ok = $false; diagnostic = [pscustomobject]@{ code = 'UNKNOWN'; message = '?' } } }
    }
}
switch ($Scenario) {
    'create-confirmed' { Add-Inputs @('C:\\Projeto', 's'); Invoke-CreateInitialConfiguration }
    'create-cancelled' { Add-Inputs @('C:\\Projeto', 'n'); Invoke-CreateInitialConfiguration }
    'create-retry' { Add-Inputs @('INVALIDO', 'C:\\Projeto', 's'); Invoke-CreateInitialConfiguration }
    default { throw "Cenário desconhecido: $Scenario" }
}
[ordered]@{ output = @($script:captured); calls = @($script:bridgeCalls) } | ConvertTo-Json -Depth 8 -Compress
`;

windowsTest('wizard cria a configuração inicial somente após confirmação explícita', () => {
  const result = runScenario('create-confirmed');
  const text = outputText(result);
  assert.match(text, /CRIAR CONFIGURAÇÃO INICIAL/);
  assert.match(text, /Resumo da configuração inicial/);
  assert.match(text, /Pastas ignoradas:/);
  assert.match(text, /Configuração criada e validada/);
  assert.equal(result.calls.filter((call) => call === 'create-configuration').length, 2);
});

windowsTest('wizard cancela sem criar quando a confirmação padrão não é alterada', () => {
  const result = runScenario('create-cancelled');
  const text = outputText(result);
  assert.match(text, /CRIAR CONFIGURAÇÃO INICIAL/);
  assert.match(text, /Resumo da configuração inicial/);
  assert.match(text, /Criação cancelada; a configuração não foi criada/);
  assert.equal(result.calls.filter((call) => call === 'create-configuration').length, 1);
});

windowsTest('wizard permite tentar novamente após PastaRaiz inválida', () => {
  const result = runScenario('create-retry');
  const text = outputText(result);
  assert.match(text, /Caminho inválido/);
  assert.match(text, /Configuração criada e validada/);
  assert.equal(result.calls.filter((call) => call === 'create-configuration').length, 3);
});
