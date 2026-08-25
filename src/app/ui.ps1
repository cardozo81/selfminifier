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

function Get-TiposArquivoValor {
    param($FileTypes)
    if ($FileTypes -contains 'css' -and $FileTypes -contains 'javascript') { return 'CSS+JavaScript' }
    if ($FileTypes -contains 'css') { return 'CSS' }
    if ($FileTypes -contains 'javascript') { return 'JavaScript' }
    return ''
}

function Get-TiposArquivoDescricao {
    param($FileTypes)
    switch (Get-TiposArquivoValor $FileTypes) {
        'CSS' { return 'CSS' }
        'JavaScript' { return 'JavaScript' }
        'CSS+JavaScript' { return 'CSS + JavaScript' }
        default { return ($FileTypes -join ', ') }
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

function Invoke-EditProjectRoot {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
        return
    }
    $current = $summary.configuration.projectRoot
    Show-Mensagem "`nORIGEM DO PROJETO" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem 'Origem atual:' Cyan
    Show-Mensagem $current White
    $entrada = (Read-Host "`nInforme a nova pasta do projeto. 0 = Cancelar").Trim()
    if ($entrada -eq '0' -or $entrada -eq '') {
        Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow
        return
    }
    if ($entrada -eq $current) {
        Show-Mensagem 'A nova origem é igual à atual; nenhuma alteração foi necessária.' Green
        return
    }
    Show-Mensagem "`nOrigem atual:" Cyan
    Show-Mensagem $current White
    Show-Mensagem 'Nova origem:' Cyan
    Show-Mensagem $entrada White
    Write-Host '1. Salvar alteração'
    Write-Host '0. Cancelar'
    $escolha = (Read-Host 'Escolha').Trim()
    switch ($escolha) {
        '1' {
            $saved = Invoke-SelfMinifierBridge @{ command = 'update-configuration-v2'; projectRoot = $entrada; confirmed = $true }
            if (-not $saved.ok) {
                $mensagem = Get-BridgeErrorMessage $saved 'Não foi possível salvar a nova origem do projeto.'
                if ($saved.changed) { $mensagem = "$mensagem A configuração pode ter sido alterada." }
                Show-Mensagem "Erro: $mensagem" Red
                return
            }
            Show-Mensagem "Origem do projeto salva: $($saved.configuration.projectRoot)" Green
        }
        '0' { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow }
        default { Show-Mensagem 'Opção inválida; nenhuma configuração foi alterada.' Yellow }
    }
}

function Invoke-EditFileTypes {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
        return
    }
    $current = Get-TiposArquivoValor $summary.configuration.fileTypes
    Show-Mensagem "`nTIPOS DE ARQUIVO" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem "Tipos atuais: $(Get-TiposArquivoDescricao $summary.configuration.fileTypes)" Cyan
    Write-Host '1. CSS'
    Write-Host '2. JavaScript'
    Write-Host '3. CSS + JavaScript'
    Write-Host '0. Cancelar'
    $escolha = (Read-Host 'Escolha').Trim()
    if ($escolha -eq '0') { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow; return }
    $novoValor = switch ($escolha) {
        '1' { 'CSS' }
        '2' { 'JavaScript' }
        '3' { 'CSS+JavaScript' }
        default { $null }
    }
    if ($null -eq $novoValor) { Show-Mensagem 'Escolha inválida; nenhuma configuração foi alterada.' Yellow; return }
    if ($novoValor -eq $current) { Show-Mensagem 'Os tipos selecionados já estão configurados; nenhuma alteração foi necessária.' Green; return }
    $novoDescricao = if ($novoValor -eq 'CSS+JavaScript') { 'CSS + JavaScript' } else { $novoValor }
    Show-Mensagem "`nTipos atuais: $(Get-TiposArquivoDescricao $summary.configuration.fileTypes)" Cyan
    Show-Mensagem "Novos tipos: $novoDescricao" Cyan
    Write-Host '1. Salvar alteração'
    Write-Host '0. Cancelar'
    $confirmacao = (Read-Host 'Escolha').Trim()
    switch ($confirmacao) {
        '1' {
            $saved = Invoke-SelfMinifierBridge @{ command = 'update-configuration-v2'; fileTypes = $novoValor; confirmed = $true }
            if (-not $saved.ok) {
                $mensagem = Get-BridgeErrorMessage $saved 'Não foi possível salvar os tipos de arquivo.'
                if ($saved.changed) { $mensagem = "$mensagem A configuração pode ter sido alterada." }
                Show-Mensagem "Erro: $mensagem" Red
                return
            }
            Show-Mensagem "Tipos de arquivo salvos: $(Get-TiposArquivoDescricao $saved.configuration.fileTypes)" Green
        }
        '0' { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow }
        default { Show-Mensagem 'Opção inválida; nenhuma configuração foi alterada.' Yellow }
    }
}

function Show-ConfigNotAvailable {
    param([string]$Label)
    Show-Mensagem "$Label ainda não está disponível nesta etapa da implementação." Yellow
    Show-Mensagem 'Nenhuma configuração foi alterada.' Gray
}

function Show-CurrentConfiguration {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        if ($summary.code -eq 'CONFIGURATION_MISSING') {
            Show-Mensagem 'Configuração persistente ausente; não há configuração atual para exibir.' Yellow
        } else {
            Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
        }
        return
    }
    $config = $summary.configuration
    Show-Mensagem "`nCONFIGURAÇÃO ATUAL" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem "Schema: V2 (VersaoSchema=$($config.schemaVersion))" Gray
    Show-Mensagem 'Origem do projeto (PastaRaiz):' Cyan
    Show-Mensagem $config.projectRoot White
    Show-Mensagem "Tipos de arquivo (TiposArquivo): $(Get-TiposArquivoDescricao $config.fileTypes)" Cyan
    Show-Mensagem "Motor (Motor): $($config.engine)" Cyan
    Show-Mensagem "Perfil (Perfil): $($config.profile)" Cyan
    Show-Mensagem 'Comportamento de saída (ModoSaida):' Cyan
    Show-Mensagem (Get-ModoSaidaDescricao $config.outputMode) White
    Show-Mensagem 'Pastas ignoradas:' Cyan
    if (@($config.ignoredFolders).Count -eq 0) {
        Show-Mensagem 'Nenhuma' Gray
    } else {
        foreach ($folder in @($config.ignoredFolders)) { Show-Mensagem "- $folder" White }
    }
    Show-Mensagem 'Arquivos ignorados:' Cyan
    if (@($config.ignoredFiles).Count -eq 0) {
        Show-Mensagem 'Nenhum' Gray
    } else {
        foreach ($file in @($config.ignoredFiles)) { Show-Mensagem "- $file" White }
    }
}

function Show-ConfigurationMenu {
    while ($true) {
        Show-Mensagem "`nCONFIGURAÇÕES" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Write-Host '1. Origem do projeto'
        Write-Host '2. Tipos de arquivo'
        Write-Host '3. Exclusões'
        Write-Host '4. Comportamento'
        Write-Host '5. Interface e mensagens'
        Write-Host '6. Pastas e dados do programa'
        Write-Host '7. Ver configuração atual'
        Write-Host '8. Restaurar configurações padrão'
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Invoke-EditProjectRoot }
            '2' { Invoke-EditFileTypes }
            '3' { Show-ConfigNotAvailable 'Exclusões' }
            '4' { Invoke-PersistentConfiguration }
            '5' { Show-ConfigNotAvailable 'Interface e mensagens' }
            '6' { Show-ConfigNotAvailable 'Pastas e dados do programa' }
            '7' { Show-CurrentConfiguration }
            '8' { Show-ConfigNotAvailable 'Restaurar configurações padrão' }
            '0' { return }
            default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
        }
    }
}

function Show-ProjectAnalysis {
    param($Analysis)
    Show-Mensagem "`nMINIFICAR PROJETO" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    if ($Analysis.projectRoot) {
        Show-Mensagem 'Origem:' Cyan
        Show-Mensagem $Analysis.projectRoot Gray
    }
    if ($Analysis.fileTypes -contains 'css' -and $Analysis.fileTypes -contains 'javascript') { $tipoDescricao = 'CSS + JavaScript' }
    elseif ($Analysis.fileTypes -contains 'css') { $tipoDescricao = 'CSS' }
    elseif ($Analysis.fileTypes -contains 'javascript') { $tipoDescricao = 'JavaScript' }
    else { $tipoDescricao = ($Analysis.fileTypes -join ', ') }
    Show-Mensagem "Tipos: $tipoDescricao" Cyan
    Show-Mensagem "Exclusões: $($Analysis.exclusions.folders) pasta(s), $($Analysis.exclusions.files) arquivo(s)" Cyan
    Show-Mensagem "`nAnálise concluída:" Cyan
    Show-Mensagem "CSS encontrados:          $($Analysis.counts.cssFound)"
    Show-Mensagem "JavaScript encontrados:    $($Analysis.counts.javascriptFound)"
    Show-Mensagem "Ignorados:                 $($Analysis.counts.ignored)"
    Show-Mensagem "Já minificados:            $($Analysis.counts.alreadyMinified)"
    Show-Mensagem "Arquivos elegíveis:        $($Analysis.counts.eligible)"
    foreach ($entry in @($Analysis.ignoredByReason)) {
        Show-Mensagem "- $($entry.label): $($entry.count)" Gray
    }
}

function Show-CandidatePreview {
    param($Analysis)
    $candidates = if ($Analysis.execution -and $Analysis.execution.items) {
        @($Analysis.execution.items | ForEach-Object {
            [pscustomobject]@{ fileType = $_.fileType; relativePath = $_.relativePath }
        })
    } else {
        @($Analysis.candidates.css) + @($Analysis.candidates.javascript)
    }
    $total = $candidates.Count
    if ($total -eq 0) {
        Show-Mensagem 'Nenhum arquivo elegível para minificação.' Yellow
        return
    }
    $pageSize = 10
    $totalPages = [math]::Ceiling($total / $pageSize)
    $page = 1
    while ($true) {
        $start = ($page - 1) * $pageSize
        $pageItems = @($candidates | Select-Object -Skip $start -First $pageSize)
        Show-Mensagem "`nARQUIVOS QUE SERÃO MINIFICADOS" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Show-Mensagem "Página $page de $totalPages (Total: $total)" Gray
        $cssItems = @($pageItems | Where-Object { $_.fileType -eq 'css' })
        $jsItems = @($pageItems | Where-Object { $_.fileType -eq 'javascript' })
        if ($cssItems.Count -gt 0) {
            Show-Mensagem 'CSS' Cyan
            foreach ($item in $cssItems) { Show-Mensagem "- $($item.relativePath)" White }
        }
        if ($jsItems.Count -gt 0) {
            Show-Mensagem 'JavaScript' Cyan
            foreach ($item in $jsItems) { Show-Mensagem "- $($item.relativePath)" White }
        }
        if ($totalPages -gt 1) {
            Write-Host '1. Próxima página'
            Write-Host '2. Página anterior'
        }
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { if ($page -lt $totalPages) { $page++ } else { Show-Mensagem 'Você já está na última página.' Yellow } }
            '2' { if ($page -gt 1) { $page-- } else { Show-Mensagem 'Você já está na primeira página.' Yellow } }
            '0' { return }
            default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
        }
    }
}

function Invoke-ScanAnalysis {
    param([hashtable]$Adjustments = @{})
    $response = Invoke-SelfMinifierBridge @{ command = 'scan-analysis'; adjustments = $Adjustments }
    if (-not $response.ok) {
        Show-Mensagem "Erro: $(Get-BridgeErrorMessage $response 'A análise foi bloqueada por um diagnóstico indisponível.')" Red
        return
    }
    $analysis = $response.analysis
    Show-ProjectAnalysis $analysis
    if (@($analysis.errors).Count -gt 0) {
        Show-Mensagem 'Problemas de descoberta:' Red
        foreach ($error in @($analysis.errors)) { Show-Mensagem "- $($error.reason): $($error.message)" Red }
    }
    if (@($analysis.execution.conflicts).Count -gt 0) {
        Show-Mensagem 'Conflitos de destino .min (serão ignorados e preservados):' Yellow
        foreach ($conflict in @($analysis.execution.conflicts)) { Show-Mensagem "- $($conflict.destinationPath)" Yellow }
    }
    while ($true) {
        Write-Host "`n1. Ver arquivos"
        Write-Host '2. Iniciar minificação'
        Write-Host '0. Cancelar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Show-CandidatePreview $analysis }
            '2' {
                $execution = Invoke-SelfMinifierBridge @{
                    command = 'execute'
                    adjustments = $Adjustments
                    confirmed = $true
                    confirmationFingerprint = $analysis.execution.confirmationFingerprint
                }
                if (-not $execution.ok) {
                    Show-Mensagem "Minificação bloqueada: $(Get-BridgeErrorMessage $execution 'A execução falhou sem diagnóstico disponível.')" Red
                    return
                }
                Show-Mensagem "Execução: $($execution.result.executionId)" Cyan
                Show-Mensagem "Planejados: $($execution.result.counts.planned)" White
                Show-Mensagem "Processados com sucesso: $($execution.result.counts.createdSuccessfully)" Green
                Show-Mensagem "Conflitos .min preservados: $($execution.result.counts.skippedConflicts)" $(if ($execution.result.counts.skippedConflicts -gt 0) { 'Yellow' } else { 'Gray' })
                if ($execution.result.noFilesChanged) {
                    Show-Mensagem 'Nenhum arquivo foi alterado.' Yellow
                } else {
                    Show-Mensagem 'Minificação concluída.' Green
                }
                return
            }
            '0' { Show-Mensagem 'Análise cancelada; nenhum arquivo foi alterado.' Yellow; return }
            default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
        }
    }
}

function Invoke-ProjectAnalysis {
    Invoke-ScanAnalysis $script:TemporaryAdjustments
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
                '1' { Invoke-ProjectAnalysis }
                '2' { Invoke-ScanAnalysis $script:TemporaryAdjustments }
                '3' { Invoke-TemporaryAdjustment }
                '4' { Show-ConfigurationMenu }
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
