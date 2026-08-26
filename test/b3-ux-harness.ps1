param(
    [Parameter(Mandatory = $true)][string]$Scenario,
    [string]$State = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
. (Join-Path (Get-Location).Path 'src\app\ui.ps1')

$script:captured = [System.Collections.Generic.List[string]]::new()
$script:bridgeCalls = [System.Collections.Generic.List[string]]::new()
$script:queue = [System.Collections.Generic.Queue[string]]::new()

function Show-Mensagem {
    param([string]$Text, [ConsoleColor]$Color = [ConsoleColor]::White)
    $script:captured.Add($Text)
}
function Write-Host {
    param([object]$Object, [ConsoleColor]$ForegroundColor = [ConsoleColor]::White)
    $script:captured.Add([string]$Object)
}
function Read-Host {
    param([string]$Prompt)
    $script:captured.Add("PROMPT: $Prompt")
    if ($script:queue.Count -gt 0) { return $script:queue.Dequeue() }
    return '0'
}
function Add-Inputs {
    param([string[]]$Values)
    foreach ($value in $Values) { $script:queue.Enqueue($value) }
}
function New-HistoricalArtifact {
    param(
        [string]$ArtifactId = '7F31A2C82A884E91B04F22D7',
        [string]$OutputMode = 'BackupESobrescreverOriginais',
        [bool]$BackupAvailable = $true
    )
    return [pscustomobject]@{
        artifactId = $ArtifactId
        executionId = "exec-$ArtifactId"
        timestamp = '2026-08-25T12:00:00.000Z'
        meminifyVersion = '0.2.0'
        sourcePath = 'C:\Projeto\origem.js'
        outputPath = 'C:\Projeto\saida.js'
        engine = 'esbuild'
        engineVersion = '0.28.2'
        profile = 'Padrao'
        outputMode = $OutputMode
        inputHash = ('a' * 64)
        outputHash = ('b' * 64)
        backup = [pscustomobject]@{
            available = $BackupAvailable
            backupRoot = $(if ($BackupAvailable) { 'D:\Backups-Historicos' } else { $null })
            backupRelativePath = $(if ($BackupAvailable) { 'exec\origem.js.gz' } else { $null })
            originalHash = $(if ($BackupAvailable) { 'a' * 64 } else { $null })
            compression = $(if ($BackupAvailable) { 'gzip' } else { 'none' })
        }
    }
}
function New-Inspection {
    param(
        [string]$ArtifactId = '7F31A2C82A884E91B04F22D7',
        [string]$IntegrityState = 'FILE_UNAVAILABLE',
        [string]$BackupState = 'AVAILABLE',
        [bool]$Recoverable = $true,
        [bool]$MinWithoutBackup = $false
    )
    $mode = if ($MinWithoutBackup) { 'PreservarOriginaisECriarMinificados' } else { 'BackupESobrescreverOriginais' }
    return [pscustomobject]@{
        historical = New-HistoricalArtifact -ArtifactId $ArtifactId -OutputMode $mode -BackupAvailable (-not $MinWithoutBackup)
        observations = [pscustomobject]@{
            currentIntegrity = [pscustomobject]@{ state = $IntegrityState; path = 'C:\Movido\atual.js' }
            backupAvailability = [pscustomobject]@{ state = $BackupState }
            recoveryCapability = $Recoverable
        }
    }
}
function Invoke-SelfMinifierBridge {
    param([hashtable]$Request)
    $script:bridgeCalls.Add(($Request.command + '|' + $Request.artifactId + '|' + $Request.destinationPath))
    switch ($Request.command) {
        'search-history-by-tag' {
            if ($Scenario -eq 'tag-not-found') {
                return [pscustomobject]@{ ok = $false; diagnostic = [pscustomobject]@{ code = 'TAG_NOT_FOUND'; message = 'not found' } }
            }
            if ($Scenario -eq 'tag-conflict') {
                return [pscustomobject]@{ ok = $false; diagnostic = [pscustomobject]@{ code = 'HISTORY_ARTIFACT_ID_CONFLICT'; message = 'conflict' } }
            }
            return [pscustomobject]@{ ok = $true; result = New-HistoricalArtifact }
        }
        'search-history-by-path' {
            return [pscustomobject]@{
                ok = $true
                result = [pscustomobject]@{
                    order = 'newest-first'
                    records = @(
                        (New-HistoricalArtifact -ArtifactId '222222222222222222222222'),
                        (New-HistoricalArtifact -ArtifactId '111111111111111111111111')
                    )
                }
            }
        }
        'inspect-historical-artifact' {
            if ($Scenario -eq 'min-no-backup') {
                return [pscustomobject]@{ ok = $true; result = New-Inspection -ArtifactId $Request.artifactId -BackupState 'NOT_AVAILABLE' -Recoverable $false -MinWithoutBackup $true }
            }
            $integrity = if ($State) { $State } else { 'MATCH' }
            return [pscustomobject]@{ ok = $true; result = New-Inspection -ArtifactId $Request.artifactId -IntegrityState $integrity }
        }
        'recover-historical-original' {
            if ($Scenario -eq 'export-existing') {
                return [pscustomobject]@{ ok = $false; diagnostic = [pscustomobject]@{ code = 'EXPORT_TARGET_EXISTS'; message = 'exists' } }
            }
            return [pscustomobject]@{
                ok = $true
                result = [pscustomobject]@{
                    status = 'EXPORTED'
                    destinationPath = $Request.destinationPath
                    artifactId = $Request.artifactId
                    executionId = "exec-$($Request.artifactId)"
                    exportedHash = ('a' * 64)
                }
            }
        }
        'plan-restore' {
            return [pscustomobject]@{
                ok = $true
                plan = [pscustomobject]@{
                    sourceExecutionId = 'exec-normal'
                    items = @()
                    ignored = @()
                }
            }
        }
        'execute-restore' {
            return [pscustomobject]@{
                ok = $true
                result = [pscustomobject]@{ status = 'completed'; items = @() }
            }
        }
        default { return [pscustomobject]@{ ok = $false; diagnostic = [pscustomobject]@{ code = 'UNKNOWN'; message = 'unexpected' } } }
    }
}

switch ($Scenario) {
    'submenu' {
        Add-Inputs @('0')
        Show-RestoreMenu
    }
    'tag-success' {
        Add-Inputs @('/*! SelfMinifier-Tag: 7F31A2C82A884E91B04F22D7 */', '0')
        Invoke-SearchHistoricalTag
    }
    'tag-not-found' {
        Add-Inputs @('7F31A2C82A884E91B04F22D7')
        Invoke-SearchHistoricalTag
    }
    'tag-conflict' {
        Add-Inputs @('7F31A2C82A884E91B04F22D7')
        Invoke-SearchHistoricalTag
    }
    'path-multiple' {
        Add-Inputs @('C:\Projeto\origem.js', '2', '0')
        Invoke-SearchHistoryByPath
    }
    'integrity' {
        Add-Inputs @('0')
        Invoke-HistoricalArtifactFlow '7F31A2C82A884E91B04F22D7'
    }
    'min-no-backup' {
        Add-Inputs @('0')
        Invoke-HistoricalArtifactFlow '7F31A2C82A884E91B04F22D7'
    }
    'export-success' {
        Add-Inputs @('2', 'C:\Exportado\original.js', '1', '0')
        Invoke-HistoricalArtifactFlow '7F31A2C82A884E91B04F22D7'
    }
    'export-existing' {
        Add-Inputs @('2', 'C:\Exportado\existente.js', '1', '0')
        Invoke-HistoricalArtifactFlow '7F31A2C82A884E91B04F22D7'
    }
    'export-cancel' {
        Add-Inputs @('2', '', '0')
        Invoke-HistoricalArtifactFlow '7F31A2C82A884E91B04F22D7'
    }
    'normal-restore' {
        Add-Inputs @('3', 's', '0')
        Show-RestoreMenu
    }
    'backup-state' {
        $inspection = New-Inspection -BackupState $State -Recoverable ($State -eq 'AVAILABLE')
        Show-HistoricalArtifactSummary $inspection
        if ($inspection.observations.recoveryCapability) { Write-Host 'RECOVERY_OPTION_VISIBLE' }
    }
    default { throw "Cenário desconhecido: $Scenario" }
}

[ordered]@{
    output = @($script:captured)
    calls = @($script:bridgeCalls)
} | ConvertTo-Json -Depth 10 -Compress