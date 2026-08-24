[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$packageJson = Join-Path $projectRoot 'package.json'

if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
    Write-Error 'Raiz do projeto inválida: package.json não foi encontrado.'
    exit 1
}

function Resolve-NodeExecutable {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }

    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

$node = Resolve-NodeExecutable
if ($null -eq $node) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($null -eq $winget) {
        Write-Error 'Node.js não foi encontrado e winget não está disponível. Instale manualmente Node.js 24.19.0 LTS e tente novamente.'
        exit 1
    }
    $answer = Read-Host 'Node.js não foi encontrado. Autorizar instalação de Node.js 24.19.0 via winget? (s/N)'
    if ($answer.Trim().ToLowerInvariant() -ne 's') {
        Write-Warning 'Instalação não autorizada. Instale manualmente Node.js 24.19.0 LTS e tente novamente.'
        exit 1
    }
    & $winget.Source install --id OpenJS.NodeJS.LTS --version 24.19.0 --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'O instalador do Node.js retornou falha; o ambiente não foi aceito.'
        exit 1
    }
    $node = Resolve-NodeExecutable
    if ($null -eq $node) {
        Write-Error 'Node.js foi instalado, mas não pôde ser redescoberto no PATH ou nos caminhos locais conhecidos.'
        exit 1
    }
}

$cli = Join-Path $projectRoot 'src\bootstrap\cli.mjs'
& $node $cli --bootstrap-only
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$script:NodeExecutable = $node
$script:BridgePath = Join-Path $projectRoot 'src\app\bridge.mjs'
. (Join-Path $projectRoot 'src\app\ui.ps1')
Start-SelfMinifierUi
