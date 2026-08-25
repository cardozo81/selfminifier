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
            $known = @($response.backups)
            if ($known.Count -eq 0) { Show-Mensagem 'Nenhum backup conhecido.' Yellow; return }
            for ($index = 0; $index -lt $known.Count; $index++) {
                $item = $known[$index]
                $shownPath = if ($item.expectedPath) { $item.expectedPath } else { $item.directory }
                Write-Host "$($index + 1). $($item.executionId) [$($item.status)] - $shownPath"
            }
            $selected = (Read-Host 'Número; Enter cancela').Trim()
            $number = 0
            if (-not $selected -or -not [int]::TryParse($selected, [ref]$number) -or $number -lt 1 -or $number -gt $known.Count) { Show-Mensagem 'Seleção cancelada ou inválida; nenhum arquivo foi alterado.' Yellow; return }
            $chosen = $known[$number - 1]
            if ($chosen.status -ne 'valid') {
                Show-Mensagem "Restauração indisponível: $($chosen.diagnostic.message)" Red
                Show-Mensagem "Local histórico esperado: $($chosen.expectedPath)" Yellow
                return
            }
            Invoke-RestoreFlow backup $chosen.directory
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
    param([hashtable]$Adjustments)
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) { Show-Mensagem (Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração persistente.') Red; return }
    while ($true) {
        Write-Host "`nModo de saída somente para esta execução:"
        Write-Host "Atual persistente: $(Get-ModoSaidaDescricao $summary.configuration.outputMode)"
        Write-Host '1. Manter a configuração persistente atual'
        Write-Host '2. Criar backup e sobrescrever os arquivos originais'
        Write-Host '3. Preservar os arquivos originais e criar arquivos .min'
        Write-Host '0. Cancelar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { [void]$Adjustments.Remove('outputMode'); Show-Mensagem 'Modo temporário definido para a configuração persistente.' Green; return }
            '2' { $Adjustments.outputMode = 'BackupESobrescreverOriginais'; Show-Mensagem 'Modo temporário: criar backup e sobrescrever os arquivos originais.' Green; return }
            '3' { $Adjustments.outputMode = 'PreservarOriginaisECriarMinificados'; Show-Mensagem 'Modo temporário: preservar os arquivos originais e criar arquivos .min.' Green; return }
            '0' { Show-Mensagem 'Ajustes temporários cancelados; nenhuma alteração foi aplicada.' Yellow; return }
            default { Show-Mensagem 'Escolha inválida; nenhum ajuste foi aplicado. Escolha uma opção numerada.' Yellow }
        }
    }
}

function Invoke-EditOutputMode {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        if ($summary.code -eq 'CONFIGURATION_MISSING') {
            Show-Mensagem "Configuração ausente: $($summary.configurationPath)" Yellow
            Write-Host '1. Criar configuração'
            Write-Host '0. Cancelar'
            $escolha = (Read-Host 'Escolha').Trim()
            if ($escolha -ne '1') { Show-Mensagem 'Criação cancelada; a configuração não foi criada.' Yellow; return }
            $created = Invoke-SelfMinifierBridge @{ command = 'create-configuration'; confirmed = $true }
            if (-not $created.ok) { Show-Mensagem (Get-BridgeErrorMessage $created 'A configuração não foi criada.') Red; return }
            Show-Mensagem "Configuração criada: $($created.configurationPath)" Green
            $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
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
        Show-Mensagem "`nModo atual: $(Get-ModoSaidaDescricao $current)" Cyan
        Show-Mensagem "Novo modo: $(Get-ModoSaidaDescricao $newMode)" Cyan
        Write-Host '1. Salvar alteração'
        Write-Host '0. Cancelar'
        $confirmacao = (Read-Host 'Escolha').Trim()
        if ($confirmacao -ne '1') { Show-Mensagem 'Alteração cancelada; a configuração não foi modificada.' Yellow; return }
        $saved = Invoke-SelfMinifierBridge @{ command = 'update-output-mode'; outputMode = $newMode; confirmed = $true }
        if (-not $saved.ok) { Show-Mensagem (Get-BridgeErrorMessage $saved 'A configuração não foi salva.') Red; return }
        Show-Mensagem "Configuração persistente salva: $(Get-ModoSaidaDescricao $newMode)" Green
        return
    }
}

function Invoke-EditBackupRoot {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        Show-Mensagem (Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração persistente.') Red
        return
    }
    $config = $summary.configuration
    Show-Mensagem "`nARMAZENAMENTO DE BACKUPS" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    if ($summary.backupStorageMode -eq 'external') {
        Show-Mensagem 'Modo atual: pasta externa (V3)' Cyan
    } elseif ($config.schemaVersion -eq 3) {
        Show-Mensagem 'Modo atual: pasta interna (V3)' Cyan
    } else {
        Show-Mensagem 'Modo atual: pasta interna compatível (V2, sem migração automática)' Cyan
    }
    Show-Mensagem 'Local efetivo atual:' Gray
    Show-Mensagem $summary.effectiveBackupRoot White
    Write-Host '1. Usar a pasta interna da aplicação'
    Write-Host '2. Usar uma pasta externa existente'
    Write-Host '0. Cancelar'
    $choice = (Read-Host 'Escolha').Trim()
    if ($choice -eq '0') { Show-Mensagem 'Alteração cancelada; a configuração não foi modificada.' Yellow; return }
    $requestedRoot = $null
    $description = 'pasta interna da aplicação'
    if ($choice -eq '2') {
        $requestedRoot = (Read-Host 'Informe o caminho absoluto da pasta externa').Trim()
        if ([string]::IsNullOrWhiteSpace($requestedRoot)) {
            Show-Mensagem 'Pasta externa vazia; a configuração não foi modificada.' Yellow
            return
        }
        $description = "pasta externa: $requestedRoot"
    } elseif ($choice -ne '1') {
        Show-Mensagem 'Opção inválida; a configuração não foi modificada.' Yellow
        return
    }
    Show-Mensagem "`nNovo armazenamento: $description" Cyan
    Write-Host '1. Salvar alteração'
    Write-Host '0. Cancelar'
    $confirmation = (Read-Host 'Escolha').Trim()
    if ($confirmation -ne '1') { Show-Mensagem 'Alteração cancelada; a configuração não foi modificada.' Yellow; return }
    $request = @{ command = 'update-backup-root'; backupRoot = $requestedRoot; confirmed = $true }
    $saved = Invoke-SelfMinifierBridge $request
    if (-not $saved.ok) {
        $message = Get-BridgeErrorMessage $saved 'A pasta de backups não foi alterada.'
        if ($saved.changed) { $message = "$message A configuração pode ter sido alterada." }
        Show-Mensagem "Erro: $message" Red
        return
    }
    $mode = if ($saved.backupStorageMode -eq 'external') { 'externa' } else { 'interna' }
    Show-Mensagem "Armazenamento de backups salvo como $mode em Configuração V3." Green
}

function Invoke-PersistentConfiguration {
    while ($true) {
        Show-Mensagem "`nCOMPORTAMENTO" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Write-Host '1. Modo de saída'
        Write-Host '2. Local de armazenamento dos backups'
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Invoke-EditOutputMode }
            '2' { Invoke-EditBackupRoot }
            '0' { return }
            default { Show-Mensagem 'Opção inválida; nenhuma configuração foi alterada.' Yellow }
        }
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

function Get-PerfilDescricao {
    param([string]$Perfil)
    switch ($Perfil) {
        'Conservador' { return 'Conservador' }
        'Padrao' { return 'Padrão' }
        'Maximo' { return 'Máximo' }
        default { return "Perfil não reconhecido: $Perfil" }
    }
}

function Invoke-EditProfile {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
        return
    }
    $current = $summary.configuration.profile
    Show-Mensagem "`nPERFIL DE MINIFICAÇÃO" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem "Perfil atual: $(Get-PerfilDescricao $current)" Cyan
    Write-Host '1. Conservador'
    Write-Host '2. Padrão'
    Write-Host '3. Máximo'
    Write-Host '0. Cancelar'
    $escolha = (Read-Host 'Escolha').Trim()
    if ($escolha -eq '0') { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow; return }
    $novoPerfil = switch ($escolha) {
        '1' { 'Conservador' }
        '2' { 'Padrao' }
        '3' { 'Maximo' }
        default { $null }
    }
    if ($null -eq $novoPerfil) { Show-Mensagem 'Escolha inválida; nenhuma configuração foi alterada.' Yellow; return }
    if ($novoPerfil -eq $current) { Show-Mensagem 'O perfil selecionado já está configurado; nenhuma alteração foi necessária.' Green; return }
    Show-Mensagem "`nPerfil atual: $(Get-PerfilDescricao $current)" Cyan
    Show-Mensagem "Novo perfil: $(Get-PerfilDescricao $novoPerfil)" Cyan
    Write-Host '1. Salvar alteração'
    Write-Host '0. Cancelar'
    $confirmacao = (Read-Host 'Escolha').Trim()
    switch ($confirmacao) {
        '1' {
            $saved = Invoke-SelfMinifierBridge @{ command = 'update-configuration-v2'; profile = $novoPerfil; confirmed = $true }
            if (-not $saved.ok) {
                $mensagem = Get-BridgeErrorMessage $saved 'Não foi possível salvar o perfil de minificação.'
                if ($saved.changed) { $mensagem = "$mensagem A configuração pode ter sido alterada." }
                Show-Mensagem "Erro: $mensagem" Red
                return
            }
            Show-Mensagem "Perfil de minificação salvo: $(Get-PerfilDescricao $saved.configuration.profile)" Green
        }
        '0' { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow }
        default { Show-Mensagem 'Opção inválida; nenhuma configuração foi alterada.' Yellow }
    }
}

function Get-V2Summary {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
        return $null
    }
    return $summary
}

function Get-ExclusionInfo {
    param([ValidateSet('folder', 'file')][string]$Kind)
    if ($Kind -eq 'folder') {
        return @{
            Field = 'ignoredFolders'
            Titulo = 'PASTAS IGNORADAS'
            TituloAdd = 'ADICIONAR PASTA IGNORADA'
            TituloRemove = 'REMOVER PASTA IGNORADA'
            Prompt = 'Informe a pasta relativa que deve ser ignorada.'
            Exemplo = 'node_modules'
            VazioRemove = 'Não há pastas ignoradas para remover.'
            ConfirmAddLabel = 'Pasta a adicionar'
            ConfirmRemoveLabel = 'Pasta a remover'
            SucessoAdd = 'Pasta ignorada adicionada'
            SucessoRemove = 'Pasta ignorada removida'
        }
    }
    return @{
        Field = 'ignoredFiles'
        Titulo = 'ARQUIVOS IGNORADOS'
        TituloAdd = 'ADICIONAR ARQUIVO IGNORADO'
        TituloRemove = 'REMOVER ARQUIVO IGNORADO'
        Prompt = 'Informe o arquivo relativo que deve ser ignorado.'
        Exemplo = 'src\config.js'
        VazioRemove = 'Não há arquivos ignorados para remover.'
        ConfirmAddLabel = 'Arquivo a adicionar'
        ConfirmRemoveLabel = 'Arquivo a remover'
        SucessoAdd = 'Arquivo ignorado adicionado'
        SucessoRemove = 'Arquivo ignorado removido'
    }
}

function Show-IgnoredFoldersList {
    $summary = Get-V2Summary
    if (-not $summary) { return }
    $folders = @($summary.configuration.ignoredFolders)
    Show-Mensagem "`nPASTAS IGNORADAS" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    if ($folders.Count -eq 0) {
        Show-Mensagem 'Nenhuma' Gray
    } else {
        foreach ($folder in $folders) { Show-Mensagem "- $folder" White }
    }
}

function Show-IgnoredFilesList {
    $summary = Get-V2Summary
    if (-not $summary) { return }
    $files = @($summary.configuration.ignoredFiles)
    Show-Mensagem "`nARQUIVOS IGNORADOS" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    if ($files.Count -eq 0) {
        Show-Mensagem 'Nenhum' Gray
    } else {
        foreach ($file in $files) { Show-Mensagem "- $file" White }
    }
}

function Show-CurrentExclusions {
    $summary = Get-V2Summary
    if (-not $summary) { return }
    Show-Mensagem "`nEXCLUSÕES ATUAIS" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem 'Pastas ignoradas:' Cyan
    $folders = @($summary.configuration.ignoredFolders)
    if ($folders.Count -eq 0) {
        Show-Mensagem 'Nenhuma' Gray
    } else {
        foreach ($folder in $folders) { Show-Mensagem "- $folder" White }
    }
    Show-Mensagem 'Arquivos ignorados:' Cyan
    $files = @($summary.configuration.ignoredFiles)
    if ($files.Count -eq 0) {
        Show-Mensagem 'Nenhum' Gray
    } else {
        foreach ($file in $files) { Show-Mensagem "- $file" White }
    }
}

function Add-ExclusionEntry {
    param([ValidateSet('folder', 'file')][string]$Kind)
    $summary = Get-V2Summary
    if (-not $summary) { return }
    $info = Get-ExclusionInfo $Kind
    $current = @($summary.configuration.($info.Field))
    Show-Mensagem "`n$($info.TituloAdd)" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem 'Origem do projeto:' Cyan
    Show-Mensagem $summary.configuration.projectRoot White
    Show-Mensagem $info.Prompt Gray
    Show-Mensagem "Exemplo: $($info.Exemplo)" Gray
    Show-Mensagem '0 = Cancelar' Gray
    $entrada = (Read-Host 'Valor relativo').Trim()
    if ($entrada -eq '0' -or $entrada -eq '') {
        Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow
        return
    }
    $novaLista = @($current) + $entrada
    Show-Mensagem "`n$($info.ConfirmAddLabel):" Cyan
    Show-Mensagem $entrada White
    Write-Host '1. Adicionar'
    Write-Host '0. Cancelar'
    $escolha = (Read-Host 'Escolha').Trim()
    switch ($escolha) {
        '1' {
            $request = @{ command = 'update-configuration-v2'; confirmed = $true }
            $request[$info.Field] = $novaLista
            $saved = Invoke-SelfMinifierBridge $request
            if (-not $saved.ok) {
                if ($saved.diagnostic.code -eq 'DUPLICATE_IGNORED_FOLDER' -or $saved.diagnostic.code -eq 'DUPLICATE_IGNORED_FILE') {
                    Show-Mensagem "O valor já está configurado. $(Get-BridgeErrorMessage $saved 'Valor duplicado.')" Yellow
                } else {
                    $mensagem = Get-BridgeErrorMessage $saved 'Não foi possível salvar a exclusão.'
                    if ($saved.changed) { $mensagem = "$mensagem A configuração pode ter sido alterada." }
                    Show-Mensagem "Erro: $mensagem" Red
                }
                return
            }
            $persistido = @($saved.configuration.($info.Field))
            Show-Mensagem "$($info.SucessoAdd): $($persistido[-1])" Green
        }
        '0' { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow }
        default { Show-Mensagem 'Opção inválida; nenhuma configuração foi alterada.' Yellow }
    }
}

function Remove-ExclusionEntry {
    param([ValidateSet('folder', 'file')][string]$Kind)
    $summary = Get-V2Summary
    if (-not $summary) { return }
    $info = Get-ExclusionInfo $Kind
    $current = @($summary.configuration.($info.Field))
    if ($current.Count -eq 0) {
        Show-Mensagem $info.VazioRemove Yellow
        return
    }
    Show-Mensagem "`n$($info.TituloRemove)" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    for ($index = 0; $index -lt $current.Count; $index++) {
        Write-Host "$($index + 1). $($current[$index])"
    }
    Write-Host '0. Cancelar'
    $escolha = (Read-Host 'Escolha').Trim()
    if ($escolha -eq '0') { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow; return }
    $number = 0
    if (-not [int]::TryParse($escolha, [ref]$number) -or $number -lt 1 -or $number -gt $current.Count) {
        Show-Mensagem 'Seleção inválida; nenhuma configuração foi alterada.' Yellow
        return
    }
    $remover = $current[$number - 1]
    Show-Mensagem "`n$($info.ConfirmRemoveLabel):" Cyan
    Show-Mensagem $remover White
    Write-Host '1. Remover'
    Write-Host '0. Cancelar'
    $confirmacao = (Read-Host 'Escolha').Trim()
    switch ($confirmacao) {
        '1' {
            $novaLista = @()
            for ($index = 0; $index -lt $current.Count; $index++) {
                if ($index -ne ($number - 1)) { $novaLista += $current[$index] }
            }
            $request = @{ command = 'update-configuration-v2'; confirmed = $true }
            $request[$info.Field] = $novaLista
            $saved = Invoke-SelfMinifierBridge $request
            if (-not $saved.ok) {
                $mensagem = Get-BridgeErrorMessage $saved 'Não foi possível salvar a exclusão.'
                if ($saved.changed) { $mensagem = "$mensagem A configuração pode ter sido alterada." }
                Show-Mensagem "Erro: $mensagem" Red
                return
            }
            Show-Mensagem "$($info.SucessoRemove): $remover" Green
        }
        '0' { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow }
        default { Show-Mensagem 'Opção inválida; nenhuma configuração foi alterada.' Yellow }
    }
}

function Invoke-EditIgnoredFolders {
    while ($true) {
        Show-Mensagem "`nPASTAS IGNORADAS" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Write-Host '1. Adicionar pasta'
        Write-Host '2. Remover pasta'
        Write-Host '3. Ver lista'
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Add-ExclusionEntry 'folder' }
            '2' { Remove-ExclusionEntry 'folder' }
            '3' { Show-IgnoredFoldersList }
            '0' { return }
            default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
        }
    }
}

function Invoke-EditIgnoredFiles {
    while ($true) {
        Show-Mensagem "`nARQUIVOS IGNORADOS" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Write-Host '1. Adicionar arquivo'
        Write-Host '2. Remover arquivo'
        Write-Host '3. Ver lista'
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Add-ExclusionEntry 'file' }
            '2' { Remove-ExclusionEntry 'file' }
            '3' { Show-IgnoredFilesList }
            '0' { return }
            default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
        }
    }
}

function Invoke-EditExclusions {
    while ($true) {
        $summary = Get-V2Summary
        if (-not $summary) { return }
        $folders = @($summary.configuration.ignoredFolders)
        $files = @($summary.configuration.ignoredFiles)
        Show-Mensagem "`nEXCLUSÕES" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Show-Mensagem "Pastas ignoradas:   $($folders.Count)" White
        Show-Mensagem "Arquivos ignorados: $($files.Count)" White
        Write-Host '1. Pastas ignoradas'
        Write-Host '2. Arquivos ignorados'
        Write-Host '3. Ver exclusões atuais'
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Invoke-EditIgnoredFolders }
            '2' { Invoke-EditIgnoredFiles }
            '3' { Show-CurrentExclusions }
            '0' { return }
            default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
        }
    }
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
    $schemaDescription = if ($config.schemaVersion -eq 2) {
        'V2 — backups internos, sem migração automática'
    } elseif ($null -eq $config.backupRoot) {
        'V3 — backups internos'
    } else {
        'V3 — backups externos'
    }
    Show-Mensagem "Schema: $schemaDescription (VersaoSchema=$($config.schemaVersion))" Gray
    Show-Mensagem 'Origem do projeto (PastaRaiz):' Cyan
    Show-Mensagem $config.projectRoot White
    Show-Mensagem "Tipos de arquivo (TiposArquivo): $(Get-TiposArquivoDescricao $config.fileTypes)" Cyan
    Show-Mensagem "Motor (Motor): $($config.engine)" Cyan
    Show-Mensagem "Perfil (Perfil): $($config.profile)" Cyan
    Show-Mensagem 'Comportamento de saída (ModoSaida):' Cyan
    Show-Mensagem (Get-ModoSaidaDescricao $config.outputMode) White
    Show-Mensagem 'Armazenamento de backups:' Cyan
    Show-Mensagem $(if ($summary.backupStorageMode -eq 'external') { 'Externo' } else { 'Interno' }) White
    Show-Mensagem 'Local efetivo dos backups:' Cyan
    Show-Mensagem $summary.effectiveBackupRoot White
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
        Write-Host '4. Perfil de minificação'
        Write-Host '5. Comportamento'
        Write-Host '6. Ver configuração atual'
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Invoke-EditProjectRoot }
            '2' { Invoke-EditFileTypes }
            '3' { Invoke-EditExclusions }
            '4' { Invoke-EditProfile }
            '5' { Invoke-PersistentConfiguration }
            '6' { Show-CurrentConfiguration }
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
    $candidates = @()
    if ($Analysis.execution -and @($Analysis.execution.items).Count -gt 0) {
        $candidates = @($Analysis.execution.items | ForEach-Object {
            [pscustomobject]@{ fileType = $_.fileType; relativePath = $_.relativePath }
        })
    } else {
        $candidates = @($Analysis.candidates.css) + @($Analysis.candidates.javascript)
    }
    $total = @($candidates).Count
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
        if ($total -gt $pageSize) {
            Show-Mensagem "Página $page de $totalPages" Gray
        }
        Show-Mensagem "Total: $total" Gray
        Show-Mensagem ''
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
        Show-Mensagem ''
        if ($total -gt $pageSize) {
            if ($page -lt $totalPages) { Write-Host '1. Próxima página' }
            if ($page -gt 1) { Write-Host '2. Página anterior' }
        }
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { if ($total -gt $pageSize -and $page -lt $totalPages) { $page++ } else { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow } }
            '2' { if ($total -gt $pageSize -and $page -gt 1) { $page-- } else { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow } }
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
    if (@($analysis.execution.conflicts).Count -gt 0) {
        Show-Mensagem 'Conflitos de destino .min (serão ignorados e preservados):' Yellow
        foreach ($conflict in @($analysis.execution.conflicts)) { Show-Mensagem "- $($conflict.destinationPath)" Yellow }
    }
    $blockers = @($analysis.execution.diagnostics.blockers)
    if ($blockers.Count -gt 0 -or $analysis.execution.status -eq 'blocked') {
        Show-Mensagem 'A minificação está bloqueada:' Red
        foreach ($blocker in $blockers) {
            if ($blocker.message) { Show-Mensagem "- $($blocker.message)" Red }
            elseif ($blocker.reason) { Show-Mensagem "- $($blocker.reason)" Red }
            else { Show-Mensagem "- $($blocker.code)" Red }
        }
        Show-Mensagem 'Nenhum arquivo foi alterado.' Yellow
        return
    }
    if (@($analysis.execution.items).Count -eq 0) {
        Show-Mensagem 'Nenhum arquivo será minificado nesta análise.' Yellow
        Show-Mensagem 'Nenhum arquivo foi alterado.' Yellow
        return
    }
    while ($true) {
        Write-Host "`n1. Ver arquivos que serão minificados"
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
                    if ($execution.diagnostic.code -eq 'PLAN_CHANGED_AFTER_ANALYSIS') {
                        Show-Mensagem 'O projeto mudou após a análise. Analise novamente antes de minificar.' Yellow
                    } else {
                        Show-Mensagem "Minificação bloqueada: $(Get-BridgeErrorMessage $execution 'A execução falhou sem diagnóstico disponível.')" Red
                    }
                    return
                }
                Show-Mensagem "Execução concluída: $($execution.result.status)" Green
                Show-Mensagem "Modo de saída: $(Get-ModoSaidaDescricao $execution.plan.outputMode)" Cyan
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

function Invoke-MinifyProject {
    $ajustes = @{}
    while ($true) {
        $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
        if (-not $summary.ok -or -not $summary.configuration) {
            Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
            Show-Mensagem 'Corrija a configuração em Configurações antes de minificar.' Gray
            return
        }
        $config = $summary.configuration
        $modoEfetivo = if ($ajustes.ContainsKey('outputMode')) { $ajustes.outputMode } else { $config.outputMode }
        Show-Mensagem "`nMINIFICAR PROJETO" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Show-Mensagem "Projeto: $($config.projectRoot)" Cyan
        Show-Mensagem "Tipos: $(Get-TiposArquivoDescricao $config.fileTypes)" Cyan
        Show-Mensagem "Perfil: $(Get-PerfilDescricao $config.profile)" Cyan
        Show-Mensagem "Modo de saída: $(Get-ModoSaidaDescricao $modoEfetivo)" Cyan
        Write-Host '1. Analisar projeto'
        Write-Host '2. Ajustar somente esta execução'
        Write-Host '0. Cancelar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Invoke-ScanAnalysis $ajustes }
            '2' { Invoke-TemporaryAdjustment $ajustes }
            '0' { Show-Mensagem 'Operação cancelada; nenhum arquivo foi alterado.' Yellow; return }
            default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
        }
    }
}

function Start-SelfMinifierUi {
    $identity = Invoke-SelfMinifierBridge @{ command = 'version' }
    if (-not $identity.ok) { Show-Mensagem "Não foi possível obter a versão do SelfMinifier. $($identity.diagnostic.message)" Red; return }
    Write-Host "`nSELFMINIFIER v$($identity.version)" -ForegroundColor Cyan
    while ($true) {
        Write-Host "`nSELFMINIFIER" -ForegroundColor Cyan
        Write-Host '────────────────────────────────────' -ForegroundColor Cyan
        Write-Host '1. Minificar projeto'
        Write-Host '2. Configurações'
        Write-Host '3. Backups e restauração'
        Write-Host '4. Relatórios'
        Write-Host '5. Logs técnicos'
        Write-Host '0. Sair'
        $choice = (Read-Host 'Escolha').Trim()
        try {
            switch ($choice) {
                '1' { Invoke-MinifyProject }
                '2' { Show-ConfigurationMenu }
                '3' { Show-RestoreMenu }
                '4' { Show-Artefatos reports }
                '5' { Show-Artefatos logs }
                '0' { return }
                default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
            }
        } catch [System.Management.Automation.PipelineStoppedException] { Show-Mensagem 'Operação cancelada.' Yellow }
          catch { Show-Mensagem "Operação bloqueada: $($_.Exception.Message)" Red }
    }
}
