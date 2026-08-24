function Invoke-SelfMinifierBridge {
    param([hashtable]$Request)
    $json = $Request | ConvertTo-Json -Depth 30 -Compress
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $script:NodeExecutable
    $startInfo.Arguments = '"' + $script:BridgePath.Replace('"', '\"') + '" --bridge'
    $startInfo.WorkingDirectory = Split-Path -Parent $script:BridgePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.Close()
    $result = $process.StandardOutput.ReadToEnd()
    $errorOutput = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0 -and [string]::IsNullOrWhiteSpace($result)) {
        $detail = if ([string]::IsNullOrWhiteSpace($errorOutput)) { 'A aplicação Node não retornou uma resposta estruturada.' } else { "A aplicação Node falhou: $($errorOutput.Trim())" }
        return [pscustomobject]@{ ok = $false; diagnostic = [pscustomobject]@{ code = 'BRIDGE_FAILED'; message = $detail } }
    }
    try { return ($result | ConvertFrom-Json) }
    catch { return [pscustomobject]@{ ok = $false; diagnostic = [pscustomobject]@{ code = 'INVALID_BRIDGE_RESPONSE'; message = 'A resposta da aplicação Node é inválida.' } } }
}

function Show-Mensagem {
    param([string]$Text, [ConsoleColor]$Color = [ConsoleColor]::White)
    Write-Host $Text -ForegroundColor $Color
}

function Confirmar-Acao {
    param([string]$Question)
    return ((Read-Host "$Question (s/N)").Trim().ToLowerInvariant() -eq 's')
}

function Show-Analysis {
    param($Analysis)
    Show-Mensagem "`nEscopo efetivo" Cyan
    Show-Mensagem "Modo: $($Analysis.outputMode) | Perfil: $($Analysis.profile) | Risco do perfil: $($Analysis.profileRisk)"
    Show-Mensagem "Risco estimado da execução: $($Analysis.executionRisk.displayLevel)" Yellow
    Show-Mensagem "Escopo da operação: $($Analysis.scope.fileCount) arquivo(s) elegível(is)." Gray
    if ($Analysis.backupRoot) { Show-Mensagem "Raiz dos backups: $($Analysis.backupRoot)" Cyan }
    if ($Analysis.executionRisk.conflictElevation) { Show-Mensagem 'Fator de risco: sobrescrita global autorizável de destino .min preexistente.' Yellow }
    foreach ($source in $Analysis.sources) { Show-Mensagem "Origem $($source.id): $($source.path) | Recursivo: $($source.recursive)" Cyan }
    Show-Mensagem "Encontrados: $($Analysis.counts.found) | Elegíveis: $($Analysis.counts.eligible) | Ignorados: $($Analysis.counts.ignored)"
    if ($Analysis.conflicts.Count -gt 0) {
        Show-Mensagem 'Conflitos de destinos .min:' Yellow
        foreach ($conflict in $Analysis.conflicts) { Show-Mensagem "- $($conflict.destinationPath)" Yellow }
    }
    if ($Analysis.diagnostics.blockers.Count -gt 0) {
        Show-Mensagem 'Bloqueios:' Red
        foreach ($blocker in $Analysis.diagnostics.blockers) { Show-Mensagem "- $($blocker.code): $($blocker.message)" Red }
    }
    if ($Analysis.diagnostics.warnings.Count -gt 0) {
        Show-Mensagem 'Avisos:' Yellow
        foreach ($warning in $Analysis.diagnostics.warnings) { Show-Mensagem "- $($warning.message)" Yellow }
    }
}

function Invoke-Analyze {
    param([hashtable]$Adjustments)
    $request = @{ command = 'analyze'; adjustments = $Adjustments }
    $response = Invoke-SelfMinifierBridge $request
    if (-not $response.ok) {
        $message = if ($response.diagnostic -and $response.diagnostic.message) { $response.diagnostic.message } elseif ($response.message) { $response.message } elseif ($response.code -eq 'CONFIGURATION_MISSING') { "Configuração persistente ausente: $($response.configurationPath). Crie-a explicitamente pelo menu Configurações." } elseif ($response.code) { "A análise foi bloqueada ($($response.code))." } else { 'A análise foi bloqueada por uma resposta sem diagnóstico.' }
        Show-Mensagem "Erro: $message" Red
        return $null
    }
    Show-Analysis $response.analysis
    return $response.analysis
}

function Show-Artefatos {
    param([ValidateSet('reports', 'logs')][string]$Kind)
    $response = Invoke-SelfMinifierBridge @{ command = 'list-artifacts'; kind = $Kind }
    if (-not $response.ok) { Show-Mensagem "Erro: $($response.diagnostic.message)" Red; return }
    if ($response.names.Count -eq 0) { Show-Mensagem $(if ($Kind -eq 'reports') { 'Nenhum relatório operacional disponível.' } else { 'Nenhum log técnico disponível.' }) Yellow; return }
    Show-Mensagem $(if ($Kind -eq 'reports') { 'Relatórios operacionais:' } else { 'Logs técnicos:' }) Cyan
    for ($index = 0; $index -lt $response.names.Count; $index++) { Write-Host "$($index + 1). $($response.names[$index])" }
    $selected = (Read-Host 'Número para visualizar; Enter cancela').Trim()
    if (-not $selected) { Show-Mensagem 'Visualização cancelada.' Yellow; return }
    $number = 0
    if (-not [int]::TryParse($selected, [ref]$number) -or $number -lt 1 -or $number -gt $response.names.Count) { Show-Mensagem 'Seleção inválida; nenhum arquivo foi alterado.' Yellow; return }
    $content = Invoke-SelfMinifierBridge @{ command = 'read-artifact'; kind = $Kind; name = $response.names[$number - 1] }
    if ($content.ok) { Show-Mensagem "`n$($content.content)" White } else { Show-Mensagem "Erro: $($content.diagnostic.message)" Red }
}

function Invoke-RestoreFlow {
    param([ValidateSet('backup', 'last-min')][string]$Kind, [string]$BackupDirectory = '')
    $request = @{ command = 'plan-restore'; kind = $Kind }
    if ($BackupDirectory) { $request.backupDirectory = $BackupDirectory }
    $response = Invoke-SelfMinifierBridge $request
    if (-not $response.ok) { Show-Mensagem "Restauração bloqueada: $($response.diagnostic.message)" Red; return }
    Show-Mensagem "`nPlano de restauração: $($response.plan.sourceExecutionId)" Cyan
    foreach ($item in $response.plan.items) { Show-Mensagem "- $($item.classification): $($item.destinationPath)" $(if ($item.requiresChangedConfirmation) { 'Yellow' } else { 'White' }) }
    foreach ($item in $response.plan.ignored) { Show-Mensagem "- não será alterado: $($item.normalizedPath) ($($item.reason))" Gray }
    if (-not (Confirmar-Acao 'Confirmar a restauração do escopo exibido')) { Show-Mensagem 'Restauração cancelada; nenhum arquivo foi alterado.' Yellow; return }
    $confirmChanged = $false
    if (($response.plan.items | Where-Object { $_.requiresChangedConfirmation }).Count -gt 0) {
        $confirmChanged = Confirmar-Acao 'Autorizar também a sobrescrita/exclusão dos arquivos alterados ou atualmente ausentes listados'
    }
    $execute = @{ command = 'execute-restore'; kind = $Kind; confirmed = $true; confirmChanged = $confirmChanged }
    if ($BackupDirectory) { $execute.backupDirectory = $BackupDirectory }
    $result = Invoke-SelfMinifierBridge $execute
    if (-not $result.ok) { Show-Mensagem "Falha de restauração: $($result.diagnostic.message)" Red; return }
    foreach ($item in $result.result.items) { Show-Mensagem "- $($item.status): $($item.path)" $(if ($item.status -in @('restored', 'deleted-min', 'already-absent')) { 'Green' } else { 'Yellow' }) }
    Show-Mensagem "Restauração: $($result.result.status)" $(if ($result.result.status -eq 'completed') { 'Green' } else { 'Yellow' })
}

function Show-RestoreMenu {
    Write-Host "`n1. Listar backups conhecidos e restaurar"
    Write-Host '2. Informar pasta de backup manualmente'
    Write-Host '3. Restaurar última execução .min'
    Write-Host '0. Voltar'
    $choice = (Read-Host 'Escolha').Trim()
    switch ($choice) {
        '1' {
            $response = Invoke-SelfMinifierBridge @{ command = 'list-backups' }
            if (-not $response.ok) { Show-Mensagem "Erro: $($response.diagnostic.message)" Red; return }
            $valid = @($response.backups | Where-Object { $_.status -eq 'valid' })
            if ($valid.Count -eq 0) { Show-Mensagem 'Nenhum backup válido conhecido.' Yellow; return }
            for ($index = 0; $index -lt $valid.Count; $index++) { Write-Host "$($index + 1). $($valid[$index].executionId) - $($valid[$index].directory)" }
            $selected = (Read-Host 'Número; Enter cancela').Trim()
            $number = 0
            if (-not $selected -or -not [int]::TryParse($selected, [ref]$number) -or $number -lt 1 -or $number -gt $valid.Count) { Show-Mensagem 'Seleção cancelada ou inválida; nenhum arquivo foi alterado.' Yellow; return }
            Invoke-RestoreFlow backup $valid[$number - 1].directory
        }
        '2' { $directory = (Read-Host 'Pasta exata do backup').Trim(); if ($directory) { Invoke-RestoreFlow backup $directory } else { Show-Mensagem 'Restauração cancelada.' Yellow } }
        '3' { Invoke-RestoreFlow last-min }
        '0' { return }
        default { Show-Mensagem 'Opção inválida; nenhum arquivo foi alterado.' Yellow }
    }
}

function Get-ModoSaidaDescricao {
    param([string]$Mode)
    switch ($Mode) {
        'BackupESobrescreverOriginais' { return 'Criar backup e sobrescrever os arquivos originais' }
        'PreservarOriginaisECriarMinificados' { return 'Preservar os arquivos originais e criar arquivos .min' }
        default { return "Modo não reconhecido: $Mode" }
    }
}

function Get-BridgeErrorMessage {
    param($Response, [string]$Fallback = 'A operação foi bloqueada por um diagnóstico indisponível.')
    if ($Response.diagnostic -and $Response.diagnostic.message) { return $Response.diagnostic.message }
    if ($Response.message) { return $Response.message }
    if ($Response.code) { return "A operação foi bloqueada ($($Response.code))." }
    return $Fallback
}

function Invoke-TemporaryAdjustment {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) { Show-Mensagem (Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração persistente.') Red; return }
    while ($true) {
        Write-Host "`nModo de saída somente para esta execução:"
        Write-Host "Atual persistente: $(Get-ModoSaidaDescricao $summary.configuration.outputMode)"
        Write-Host '1. Manter a configuração persistente atual'
        Write-Host '2. Criar backup e sobrescrever os arquivos originais'
        Write-Host '3. Preservar os arquivos originais e criar arquivos .min'
        Write-Host '0. Cancelar e voltar ao menu'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { [void]$script:TemporaryAdjustments.Remove('outputMode'); Show-Mensagem 'Modo temporário definido para a configuração persistente.' Green; return }
            '2' { $script:TemporaryAdjustments.outputMode = 'BackupESobrescreverOriginais'; Show-Mensagem 'Modo temporário: criar backup e sobrescrever os arquivos originais.' Green; return }
            '3' { $script:TemporaryAdjustments.outputMode = 'PreservarOriginaisECriarMinificados'; Show-Mensagem 'Modo temporário: preservar os arquivos originais e criar arquivos .min.' Green; return }
            '0' { Show-Mensagem 'Ajustes temporários cancelados; nenhuma alteração foi aplicada.' Yellow; return }
            default { Show-Mensagem 'Escolha inválida; nenhum ajuste foi aplicado. Escolha uma opção numerada.' Yellow }
        }
    }
}

function Invoke-PersistentConfiguration {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        if ($summary.code -eq 'CONFIGURATION_MISSING') {
            Show-Mensagem "Configuração ausente: $($summary.configurationPath)" Yellow
            if (Confirmar-Acao 'Criar a configuração a partir do modelo, sem sobrescrever arquivo existente') {
                $created = Invoke-SelfMinifierBridge @{ command = 'create-configuration'; confirmed = $true }
                if (-not $created.ok) { Show-Mensagem (Get-BridgeErrorMessage $created 'A configuração não foi criada.') Red; return }
                Show-Mensagem "Configuração criada: $($created.configurationPath)" Green
                $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
            } else { return }
        }
        if (-not $summary.ok -or -not $summary.configuration) { Show-Mensagem (Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração persistente.') Red; return }
    }
    $current = $summary.configuration.outputMode
    while ($true) {
        Write-Host "`nModo de saída atual: $(Get-ModoSaidaDescricao $current)"
        Write-Host '1. Criar backup e sobrescrever os arquivos originais (padrão)'
        Write-Host '2. Preservar os arquivos originais e criar arquivos .min'
        Write-Host '0. Cancelar'
        $choice = (Read-Host 'Escolha').Trim()
        if ($choice -eq '0') { Show-Mensagem 'Alteração cancelada; a configuração não foi modificada.' Yellow; return }
        $newMode = switch ($choice) {
            '1' { 'BackupESobrescreverOriginais' }
            '2' { 'PreservarOriginaisECriarMinificados' }
            default { $null }
        }
        if ($null -eq $newMode) { Show-Mensagem 'Escolha inválida; a configuração não foi modificada.' Yellow; continue }
        if ($newMode -eq $current) { Show-Mensagem 'O modo escolhido já está configurado; nenhuma alteração foi necessária.' Green; return }
        Show-Mensagem "`nNova configuração: $(Get-ModoSaidaDescricao $newMode)" Cyan
        if (-not (Confirmar-Acao 'Salvar esta configuração para as próximas execuções')) { Show-Mensagem 'Alteração cancelada; a configuração não foi modificada.' Yellow; return }
        $saved = Invoke-SelfMinifierBridge @{ command = 'update-output-mode'; outputMode = $newMode; confirmed = $true }
        if (-not $saved.ok) { Show-Mensagem (Get-BridgeErrorMessage $saved 'A configuração não foi salva.') Red; return }
        Show-Mensagem "Configuração persistente salva: $(Get-ModoSaidaDescricao $newMode)" Green
        return
    }
}

function Start-SelfMinifierUi {
    $identity = Invoke-SelfMinifierBridge @{ command = 'version' }
    if (-not $identity.ok) { Show-Mensagem "Não foi possível obter a versão do SelfMinifier. $($identity.diagnostic.message)" Red; return }
    Write-Host "`nSELFMINIFIER v$($identity.version)" -ForegroundColor Cyan
    $script:TemporaryAdjustments = @{}
    while ($true) {
        Write-Host "`n=== SelfMinifier ===" -ForegroundColor Cyan
        Write-Host '1. Analisar arquivos'
        Write-Host '2. Minificar'
        Write-Host '3. Ajustar somente esta execução'
        Write-Host '4. Configurações'
        Write-Host '5. Backups e restauração'
        Write-Host '6. Relatórios'
        Write-Host '7. Logs técnicos'
        Write-Host '0. Sair'
        $choice = (Read-Host 'Escolha').Trim()
        try {
            switch ($choice) {
                '1' { [void](Invoke-Analyze $script:TemporaryAdjustments) }
                '2' {
                    $analysis = Invoke-Analyze $script:TemporaryAdjustments
                    if ($null -eq $analysis -or $analysis.status -ne 'ready') { Show-Mensagem 'A minificação foi bloqueada pela pré-análise.' Red; break }
                    if (-not (Confirmar-Acao 'Confirmar a minificação do escopo exibido')) { Show-Mensagem 'Execução cancelada.' Yellow; break }
                    $overwrite = $true
                    $authorizeConflicts = $false
                    if ($analysis.conflicts.Count -gt 0) { $overwrite = Confirmar-Acao 'Autorizar globalmente a sobrescrita de todos os destinos .min listados'; $authorizeConflicts = $overwrite }
                    if (-not $overwrite) { Show-Mensagem 'Execução cancelada; nenhum arquivo foi alterado.' Yellow; break }
                    $response = Invoke-SelfMinifierBridge @{ command = 'execute'; adjustments = $script:TemporaryAdjustments; confirmed = $true; authorizeOverwriteConflicts = $authorizeConflicts; confirmationFingerprint = $analysis.confirmationFingerprint }
                    if ($response.ok -and $response.result.status -eq 'completed') { Show-Mensagem 'Minificação concluída.' Green } elseif ($response.ok -and $response.result.status -eq 'cancelled') { Show-Mensagem 'Execução cancelada.' Yellow } else { Show-Mensagem "Falha: $($response.diagnostic.message)" Red }
                }
                '3' { Invoke-TemporaryAdjustment }
                '4' { Invoke-PersistentConfiguration }
                '5' { Show-RestoreMenu }
                '6' { Show-Artefatos reports }
                '7' { Show-Artefatos logs }
                '0' { return }
                default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
            }
        } catch [System.Management.Automation.PipelineStoppedException] { Show-Mensagem 'Operação cancelada.' Yellow }
          catch { Show-Mensagem "Operação bloqueada: $($_.Exception.Message)" Red }
    }
}
