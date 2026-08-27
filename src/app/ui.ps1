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

function Format-Kilobytes {
    param([long]$Bytes)
    if ($Bytes -eq 0) { return '0 KB' }
    $kb = [math]::Round($Bytes / 1KB, 1)
    $text = $kb.ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture)
    return "$($text.Replace('.', ',')) KB"
}

function Format-ReductionPercent {
    param([double]$Value)
    $text = $Value.ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
    return "$($text.Replace('.', ','))%"
}

function Get-ExecutionStatusLabel {
    param([string]$Value)
    switch ($Value) {
        'completed' { return 'Concluída' }
        'completed-with-skips' { return 'Concluída com itens ignorados' }
        'rolled-back' { return 'Revertida' }
        'recovery-required' { return 'Recuperação necessária' }
        'cancelled' { return 'Cancelada' }
        'blocked' { return 'Bloqueada' }
        'falha' { return 'Falha' }
        'falha (rollback comprovado)' { return 'Falha (rollback comprovado)' }
        default { return $Value }
    }
}

function Confirmar-Continuar {
    [void](Read-Host 'Pressione Enter para continuar...')
}

function Show-Separador {
    Show-Mensagem '────────────────────────────────────' Cyan
}

function Show-AppHeader {
    $title = if ($script:AppVersion) { "SELFMINIFIER v$($script:AppVersion)" } else { 'SELFMINIFIER' }
    Show-Mensagem "`n$title" Cyan
    Show-Separador
}

function Show-AppScreen {
    Limpar-Tela
    Show-AppHeader
}

function Limpar-Tela {
    try { Clear-Host } catch { }
}


function Show-Artefatos {
    param([ValidateSet('reports', 'logs')][string]$Kind)
    Show-AppScreen
    $response = Invoke-SelfMinifierBridge @{ command = 'list-artifacts'; kind = $Kind }
    if (-not $response.ok) { Show-Mensagem "Erro: $($response.diagnostic.message)" Red; Confirmar-Continuar; return }
    if ($response.names.Count -eq 0) { Show-Mensagem $(if ($Kind -eq 'reports') { 'Nenhum relatório operacional disponível.' } else { 'Nenhum log técnico disponível.' }) Yellow; Confirmar-Continuar; return }
    Show-Mensagem "`n$(if ($Kind -eq 'reports') { 'Relatórios operacionais:' } else { 'Logs técnicos:' })" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    for ($index = 0; $index -lt $response.names.Count; $index++) { Write-Host "$($index + 1). $($response.names[$index])" }
    $selected = (Read-Host 'Número para visualizar; Enter cancela').Trim()
    if (-not $selected) { Show-Mensagem 'Visualização cancelada.' Yellow; return }
    $number = 0
    if (-not [int]::TryParse($selected, [ref]$number) -or $number -lt 1 -or $number -gt $response.names.Count) { Show-Mensagem 'Seleção inválida; nenhum arquivo foi alterado.' Yellow; return }
    $content = Invoke-SelfMinifierBridge @{ command = 'read-artifact'; kind = $Kind; name = $response.names[$number - 1] }
    if ($content.ok) { Show-Mensagem "`n$($content.content)" White } else { Show-Mensagem "Erro: $($content.diagnostic.message)" Red }
    Confirmar-Continuar
}

function Invoke-RestoreFlow {
    param([ValidateSet('backup', 'last-min')][string]$Kind, [string]$BackupDirectory = '')
    $request = @{ command = 'plan-restore'; kind = $Kind }
    if ($BackupDirectory) { $request.backupDirectory = $BackupDirectory }
    $response = Invoke-SelfMinifierBridge $request
    if (-not $response.ok) { Show-Mensagem "Restauração bloqueada: $($response.diagnostic.message)" Red; Confirmar-Continuar; return }
    Show-Mensagem "`nPlano de restauração: $($response.plan.sourceExecutionId)" Cyan
    foreach ($item in $response.plan.items) { Show-Mensagem "- $(Get-RestoreClassificationLabel $item.classification): $($item.destinationPath)" $(if ($item.requiresChangedConfirmation) { 'Yellow' } else { 'White' }) }
    foreach ($item in $response.plan.ignored) { Show-Mensagem "- não será alterado: $($item.normalizedPath) ($(Get-RestoreIgnoreReasonLabel $item.reason))" Gray }
    if (-not (Confirmar-Acao 'Confirmar a restauração do escopo exibido')) { Show-Mensagem 'Restauração cancelada; nenhum arquivo foi alterado.' Yellow; return }
    $confirmChanged = $false
    if (($response.plan.items | Where-Object { $_.requiresChangedConfirmation }).Count -gt 0) {
        $confirmChanged = Confirmar-Acao 'Autorizar também a sobrescrita/exclusão dos arquivos alterados ou atualmente ausentes listados'
    }
    $execute = @{ command = 'execute-restore'; kind = $Kind; confirmed = $true; confirmChanged = $confirmChanged }
    if ($BackupDirectory) { $execute.backupDirectory = $BackupDirectory }
    $result = Invoke-SelfMinifierBridge $execute
    if (-not $result.ok) { Show-Mensagem "Falha de restauração: $($result.diagnostic.message)" Red; Confirmar-Continuar; return }
    foreach ($item in $result.result.items) { Show-Mensagem "- $(Get-RestoreItemStatusLabel $item.status): $($item.path)" $(if ($item.status -in @('restored', 'deleted-min', 'already-absent')) { 'Green' } else { 'Yellow' }) }
    Show-Mensagem "Restauração: $(Get-RestoreResultStatusLabel $result.result.status)" $(if ($result.result.status -eq 'completed') { 'Green' } else { 'Yellow' })
    Confirmar-Continuar
}

function Get-HistoryErrorMessage {
    param($Response, [string]$Fallback = 'A operação histórica foi bloqueada.')
    $code = if ($Response.diagnostic -and $Response.diagnostic.code) { $Response.diagnostic.code } elseif ($Response.code) { $Response.code } else { '' }
    switch ($code) {
        'TAG_NOT_FOUND' { return 'Nenhum histórico autoritativo do SelfMinifier foi encontrado para essa Tag. Isso não significa que um arquivo esteja corrompido.' }
        'HISTORY_ARTIFACT_ID_CONFLICT' { return 'Foram encontrados registros históricos conflitantes para a mesma SelfMinifier-Tag. A operação foi bloqueada para preservar a integridade; nenhum registro foi escolhido automaticamente.' }
        'INVALID_ARTIFACT_ID' { return 'A SelfMinifier-Tag informada é inválida. Informe os 24 caracteres hexadecimais ou o marcador exato.' }
        'INVALID_HISTORY_PATH' { return 'Informe um caminho completo de arquivo para consultar o histórico.' }
        'ROOT_UNAVAILABLE' { return 'O local histórico do backup não está acessível. A recuperação foi bloqueada; o local atual de backups não será usado como substituto.' }
        'PAYLOAD_MISSING' { return 'O registro histórico existe, mas o conteúdo de backup esperado não foi encontrado.' }
        'MANIFEST_MISSING_OR_INVALID' { return 'Os metadados necessários para a recuperação histórica estão ausentes ou inválidos.' }
        'HASH_MISMATCH' { return 'O conteúdo do backup não corresponde à prova de integridade histórica. A recuperação foi bloqueada.' }
        'UNSUPPORTED_FORMAT' { return 'O formato desse backup histórico não é suportado.' }
        'HISTORICAL_BACKUP_UNAVAILABLE' { return 'Esta execução não possui backup histórico da origem; a recuperação do original não está disponível.' }
        'EXPORT_TARGET_EXISTS' { return 'O arquivo de destino já existe e não será sobrescrito. Escolha outro destino.' }
        'HISTORICAL_EXPORT_TARGET_FORBIDDEN' { return 'O destino escolhido coincide com um arquivo histórico de origem ou saída. Escolha outro arquivo para exportação.' }
        'UNSAFE_EXPORT_DESTINATION' { return 'O destino não pôde ser comprovado como seguro. Verifique o caminho e escolha outro local.' }
        default {
            $message = if ($Response.diagnostic -and $Response.diagnostic.message) { $Response.diagnostic.message } elseif ($Response.message) { $Response.message } else { $Fallback }
            if ($code) { return "$message (código técnico: $code). Consulte Logs técnicos para obter os detalhes registrados." }
            return $message
        }
    }
}

function Get-CurrentIntegrityPresentation {
    param([string]$State)
    switch ($State) {
        'MATCH' { return 'O arquivo atual corresponde exatamente ao artefato histórico.' }
        'CONTENT_CHANGED' { return 'A Tag é conhecida, mas o conteúdo atual não corresponde ao hash histórico. Isso comprova uma alteração; não determina sua causa.' }
        'TAG_MISMATCH' { return 'O arquivo selecionado contém outra SelfMinifier-Tag.' }
        'TAG_MISSING' { return 'O arquivo atual não contém a SelfMinifier-Tag histórica esperada.' }
        'TAG_INVALID' { return 'O arquivo atual contém um marcador reservado inválido ou inconsistente.' }
        'FILE_UNAVAILABLE' { return 'O artefato histórico existe, mas o arquivo atual não está disponível para inspeção.' }
        default { return 'A integridade de um arquivo atual ainda não foi verificada.' }
    }
}

function Get-HistoricalBackupPresentation {
    param([string]$State)
    switch ($State) {
        'AVAILABLE' { return 'Backup histórico disponível e validável.' }
        'NOT_AVAILABLE' { return 'Esta execução não possui backup histórico da origem.' }
        'ROOT_UNAVAILABLE' { return 'O local histórico do backup não está acessível.' }
        'PAYLOAD_MISSING' { return 'O registro existe, mas o conteúdo de backup esperado não foi encontrado.' }
        'MANIFEST_MISSING_OR_INVALID' { return 'Os metadados de recuperação estão ausentes ou inválidos.' }
        'HASH_MISMATCH' { return 'O conteúdo do backup não corresponde à prova de integridade histórica.' }
        'UNSUPPORTED_FORMAT' { return 'O formato desse backup histórico não é suportado.' }
        default { return 'A disponibilidade física do backup histórico ainda não foi verificada.' }
    }
}

function Get-CurrentIntegrityLabel {
    param([string]$State)
    switch ($State) {
        'MATCH' { return 'Corresponde ao histórico' }
        'CONTENT_CHANGED' { return 'Conteúdo alterado' }
        'TAG_MISMATCH' { return 'Tag diferente da histórica' }
        'TAG_MISSING' { return 'Tag histórica ausente' }
        'TAG_INVALID' { return 'Tag inválida' }
        'FILE_UNAVAILABLE' { return 'Arquivo atual indisponível' }
        'NOT_INSPECTED' { return 'Ainda não inspecionado' }
        default { return $State }
    }
}

function Get-HistoricalBackupLabel {
    param([string]$State)
    switch ($State) {
        'AVAILABLE' { return 'Disponível' }
        'NOT_AVAILABLE' { return 'Não disponível' }
        'ROOT_UNAVAILABLE' { return 'Local do backup indisponível' }
        'PAYLOAD_MISSING' { return 'Conteúdo do backup ausente' }
        'MANIFEST_MISSING_OR_INVALID' { return 'Metadados do backup inválidos' }
        'HASH_MISMATCH' { return 'Integridade do backup divergente' }
        'UNSUPPORTED_FORMAT' { return 'Formato não suportado' }
        'NOT_INSPECTED' { return 'Ainda não inspecionado' }
        default { return $State }
    }
}

function Get-CompressionLabel {
    param([string]$Value)
    switch ($Value) {
        'gzip' { return 'GZIP (compactado)' }
        'none' { return 'Nenhum' }
        default { return $Value }
    }
}

function Get-RestoreClassificationLabel {
    param([string]$Value)
    switch ($Value) {
        'missing-current' { return 'Arquivo atual ausente' }
        'unchanged-minified' { return 'Minificado inalterado' }
        'changed-after-minification' { return 'Alterado após a minificação' }
        'already-absent' { return 'Saída já ausente' }
        'eligible-delete' { return 'Elegível para remoção' }
        'changed-after-creation' { return 'Alterado após a criação' }
        default { return $Value }
    }
}

function Get-RestoreItemStatusLabel {
    param([string]$Value)
    switch ($Value) {
        'restored' { return 'restaurado' }
        'deleted-min' { return 'saída .min removida' }
        'already-absent' { return 'já estava ausente' }
        'skipped-by-user' { return 'ignorado pelo usuário' }
        default { return $Value }
    }
}

function Get-RestoreResultStatusLabel {
    param([string]$Value)
    switch ($Value) {
        'completed' { return 'concluída' }
        'completed-with-skips' { return 'concluída com itens ignorados' }
        'rolled-back' { return 'revertida' }
        'recovery-required' { return 'recuperação necessária' }
        'cancelled' { return 'cancelada' }
        default { return $Value }
    }
}

function Get-RestoreIgnoreReasonLabel {
    param([string]$Value)
    switch ($Value) {
        'PREEXISTING_MIN_NOT_RESTORED' { return 'saída .min preexistente não será restaurada' }
        default { return $Value }
    }
}

function Get-BackupStatusLabel {
    param([string]$Value)
    switch ($Value) {
        'valid' { return 'válido' }
        'unverified' { return 'aguarda validação após seleção' }
        'invalid' { return 'inválido' }
        'unavailable' { return 'indisponível' }
        default { return $Value }
    }
}

function Show-CurrentIntegrityObservation {
    param($Observation)
    $state = if ($Observation -and $Observation.state) { $Observation.state } else { 'NOT_INSPECTED' }
    Show-Mensagem "Integridade atual: $(Get-CurrentIntegrityLabel $state)" $(if ($state -eq 'MATCH') { 'Green' } elseif ($state -eq 'NOT_INSPECTED' -or $state -eq 'FILE_UNAVAILABLE') { 'Yellow' } else { 'Red' })
    Show-Mensagem (Get-CurrentIntegrityPresentation $state) Gray
    if ($Observation -and $Observation.path) { Write-Host "Arquivo inspecionado: $($Observation.path)" }
}

function Show-HistoricalBackupObservation {
    param($Observation)
    $state = if ($Observation -and $Observation.state) { $Observation.state } else { 'NOT_INSPECTED' }
    Show-Mensagem "Backup histórico: $(Get-HistoricalBackupLabel $state)" $(if ($state -eq 'AVAILABLE') { 'Green' } elseif ($state -eq 'NOT_INSPECTED' -or $state -eq 'NOT_AVAILABLE') { 'Yellow' } else { 'Red' })
    Show-Mensagem (Get-HistoricalBackupPresentation $state) Gray
}

function Show-HistoricalArtifactSummary {
    param($Inspection)
    $historical = $Inspection.historical
    Write-Host ''
    Show-Mensagem 'DADO HISTÓRICO PERSISTIDO' Cyan
    Write-Host "SelfMinifier-Tag: /*! SelfMinifier-Tag: $($historical.artifactId) */"
    Write-Host "Data/hora: $($historical.timestamp)"
    Write-Host "Execução: $($historical.executionId)"
    Write-Host "Versão do SelfMinifier: $($historical.meminifyVersion)"
    Write-Host "Origem histórica: $($historical.sourcePath)"
    Write-Host "Saída histórica: $($historical.outputPath)"
    Write-Host "Modo de saída: $(Get-ModoSaidaDescricao $historical.outputMode)"
    if ($historical.engine) { Write-Host "Engine: $($historical.engine) $($historical.engineVersion)" }
    if ($historical.profile) { Write-Host "Perfil: $(Get-PerfilDescricao $historical.profile)" }
    Write-Host 'Detalhes técnicos:'
    Write-Host "  SHA-256 da origem: $($historical.inputHash)"
    Write-Host "  SHA-256 da saída final: $($historical.outputHash)"
    if ($historical.backup -and $historical.backup.compression) { Write-Host "  Tipo de backup: $(Get-CompressionLabel $historical.backup.compression)" }
    if ($historical.backup -and $historical.backup.backupRoot) { Write-Host "  Local histórico do backup: $($historical.backup.backupRoot)" }
    Write-Host ''
    Show-Mensagem 'ESTADO VERIFICADO AGORA' Cyan
    Show-CurrentIntegrityObservation $Inspection.observations.currentIntegrity
    Show-HistoricalBackupObservation $Inspection.observations.backupAvailability
    Write-Host "Recuperação histórica disponível: $(if ($Inspection.observations.recoveryCapability) { 'SIM' } else { 'NÃO' })"
    if ($historical.outputMode -eq 'PreservarOriginaisECriarMinificados' -and -not $historical.backup.available) {
        Show-Mensagem 'O artefato .min permanece pesquisável e inspecionável, mas essa execução não criou backup histórico da origem. O arquivo-fonte atual não substitui esse backup e a recuperação histórica não será oferecida.' Yellow
    }
}

function Invoke-HistoricalRecoveryExport {
    param($Inspection)
    Show-AppScreen
    $historical = $Inspection.historical
    if (-not $Inspection.observations.recoveryCapability) {
        Show-Mensagem 'A recuperação histórica não está disponível nas condições verificadas acima.' Red
        Confirmar-Continuar
        return
    }
    Show-Mensagem "`nRECUPERAR ORIGINAL HISTÓRICO PARA OUTRO ARQUIVO" Cyan
    Write-Host 'Esta operação exporta bytes históricos comprovados para um destino separado.'
    Write-Host 'Ela NÃO executa a restauração normal e NÃO altera a origem ou a saída atual.'
    $destination = (Read-Host 'Informe o caminho completo e explícito do novo arquivo; Enter cancela').Trim()
    if (-not $destination) { Show-Mensagem 'Exportação histórica cancelada; nenhum arquivo foi criado.' Yellow; return }
    Write-Host "Destino solicitado: $destination"
    Write-Host '1. Exportar o original histórico para esse novo arquivo'
    Write-Host '0. Cancelar'
    $confirmation = (Read-Host 'Escolha').Trim()
    if ($confirmation -ne '1') { Show-Mensagem 'Exportação histórica cancelada; nenhum arquivo foi criado.' Yellow; return }
    $response = Invoke-SelfMinifierBridge @{ command = 'recover-historical-original'; artifactId = $historical.artifactId; destinationPath = $destination }
    if (-not $response.ok) { Show-Mensagem (Get-HistoryErrorMessage $response 'A exportação histórica foi bloqueada.') Red; Confirmar-Continuar; return }
    Show-Mensagem 'Original histórico exportado com sucesso.' Green
    Write-Host "Destino exato: $($response.result.destinationPath)"
    Write-Host "SelfMinifier-Tag do artefato: $($response.result.artifactId)"
    Write-Host "Execução histórica: $($response.result.executionId)"
    Write-Host "SHA-256 exportado: $($response.result.exportedHash)"
    Show-Mensagem 'Os arquivos atuais de origem e saída não foram modificados por esta recuperação histórica.' Green
    Confirmar-Continuar
}

function Invoke-HistoricalArtifactFlow {
    param([string]$ArtifactId, [string]$CurrentPath = '')
    $request = @{ command = 'inspect-historical-artifact'; artifactId = $ArtifactId }
    if ($CurrentPath) { $request.currentPath = $CurrentPath }
    $response = Invoke-SelfMinifierBridge $request
    if (-not $response.ok) { Show-Mensagem (Get-HistoryErrorMessage $response 'Não foi possível inspecionar o artefato histórico.') Red; Confirmar-Continuar; return }
    $inspection = $response.result
    while ($true) {
        Show-AppScreen
        Show-HistoricalArtifactSummary $inspection
        Write-Host ''
        Write-Host '1. Verificar a integridade de um arquivo atual selecionado'
        if ($inspection.observations.recoveryCapability) { Write-Host '2. Recuperar original histórico para outro arquivo' }
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' {
                $selectedPath = (Read-Host 'Caminho completo do arquivo atual; Enter cancela').Trim()
                if (-not $selectedPath) { Show-Mensagem 'Inspeção atual cancelada.' Yellow; continue }
                $next = Invoke-SelfMinifierBridge @{ command = 'inspect-historical-artifact'; artifactId = $ArtifactId; currentPath = $selectedPath }
                if (-not $next.ok) { Show-Mensagem (Get-HistoryErrorMessage $next 'A inspeção do arquivo atual foi bloqueada.') Red; continue }
                $inspection = $next.result
            }
            '2' {
                if (-not $inspection.observations.recoveryCapability) { Show-Mensagem 'Opção indisponível: o backup histórico não foi comprovado como recuperável.' Red; continue }
                Invoke-HistoricalRecoveryExport $inspection
            }
            '0' { return }
            default { Show-Mensagem 'Opção inválida; nenhuma operação foi executada.' Yellow }
        }
    }
}

function Invoke-SearchHistoricalTag {
    Show-AppScreen
    Show-Mensagem "`nPESQUISAR SELFMINIFIER-TAG" Cyan
    $tag = (Read-Host 'Informe a Tag de 24 caracteres ou o marcador exato; Enter cancela').Trim()
    if (-not $tag) { Show-Mensagem 'Pesquisa cancelada.' Yellow; return }
    $response = Invoke-SelfMinifierBridge @{ command = 'search-history-by-tag'; tag = $tag }
    if (-not $response.ok) { Show-Mensagem (Get-HistoryErrorMessage $response 'A pesquisa histórica foi bloqueada.') Red; Confirmar-Continuar; return }
    Show-Mensagem 'Histórico autoritativo encontrado para a SelfMinifier-Tag.' Green
    Confirmar-Continuar
    Invoke-HistoricalArtifactFlow $response.result.artifactId
}

function Invoke-SearchHistoryByPath {
    Show-AppScreen
    Show-Mensagem "`nCONSULTAR HISTÓRICO POR ARQUIVO OU CAMINHO" Cyan
    Write-Host 'Cada ocorrência é um artefato histórico independente; a lista não representa uma cadeia de revisões.'
    $historyPath = (Read-Host 'Informe o caminho completo; Enter cancela').Trim()
    if (-not $historyPath) { Show-Mensagem 'Consulta cancelada.' Yellow; return }
    $response = Invoke-SelfMinifierBridge @{ command = 'search-history-by-path'; path = $historyPath }
    if (-not $response.ok) { Show-Mensagem (Get-HistoryErrorMessage $response 'A consulta por caminho foi bloqueada.') Red; Confirmar-Continuar; return }
    $records = @($response.result.records)
    if ($records.Count -eq 0) { Show-Mensagem 'Nenhuma ocorrência histórica foi encontrada para esse caminho.' Yellow; Confirmar-Continuar; return }
    Show-Mensagem "Ocorrências históricas em ordem mais recente primeiro: $($records.Count)" Cyan
    for ($index = 0; $index -lt $records.Count; $index++) {
        $record = $records[$index]
        Write-Host "$($index + 1). $($record.timestamp) | Tag $($record.artifactId) | execução $($record.executionId)"
        Write-Host "   Origem: $($record.sourcePath)"
        Write-Host "   Saída: $($record.outputPath)"
    }
    $selected = (Read-Host 'Número para inspecionar; Enter cancela').Trim()
    if (-not $selected) { Show-Mensagem 'Seleção cancelada.' Yellow; return }
    $number = 0
    if (-not [int]::TryParse($selected, [ref]$number) -or $number -lt 1 -or $number -gt $records.Count) { Show-Mensagem 'Seleção inválida; nenhuma operação foi executada.' Yellow; return }
    Invoke-HistoricalArtifactFlow $records[$number - 1].artifactId
}

function Invoke-KnownBackupRestoreSelection {
    Show-AppScreen
    $response = Invoke-SelfMinifierBridge @{ command = 'list-backups' }
    if (-not $response.ok) { Show-Mensagem "Erro: $($response.diagnostic.message)" Red; Confirmar-Continuar; return }
    $known = @($response.backups)
    if ($known.Count -eq 0) { Show-Mensagem 'Nenhum backup conhecido.' Yellow; Confirmar-Continuar; return }
    Show-Mensagem "`nBACKUPS CONHECIDOS" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    for ($index = 0; $index -lt $known.Count; $index++) {
        $item = $known[$index]
        $shownPath = if ($item.expectedPath) { $item.expectedPath } else { $item.directory }
        $backupId = 'B' + ($index + 1)
        Write-Host "[$backupId] $($item.executionId) [$(Get-BackupStatusLabel $item.status)] - $shownPath"
    }
    $selected = (Read-Host 'Digite o ID do backup a restaurar (ex.: B1) ou pressione Enter para cancelar').Trim()
    if (-not $selected) { Show-Mensagem 'Seleção cancelada; nenhum arquivo foi alterado.' Yellow; Confirmar-Continuar; return }
    if ($selected -notmatch '^B([1-9][0-9]*)$') { Show-Mensagem 'ID inválido; use o formato B1, B2... Nenhum arquivo foi alterado.' Yellow; Confirmar-Continuar; return }
    $number = [int]$Matches[1]
    if ($number -gt $known.Count) { Show-Mensagem "ID fora da lista; escolha um ID exibido (B1 a B$($known.Count)). Nenhum arquivo foi alterado." Yellow; Confirmar-Continuar; return }
    $chosen = $known[$number - 1]
    if ($chosen.status -eq 'invalid') {
        Show-Mensagem "Restauração indisponível: $($chosen.diagnostic.message)" Red
        Show-Mensagem "Local histórico esperado: $(if ($chosen.expectedPath) { $chosen.expectedPath } else { $chosen.directory })" Yellow
        Confirmar-Continuar
        return
    }
    Invoke-RestoreFlow backup $chosen.directory
}

function Show-RestoreMenu {
    while ($true) {
        Show-AppScreen
        Show-Mensagem "`nBACKUPS, RESTAURAÇÃO E HISTÓRICO" Cyan
        Show-Mensagem 'RESTAURAÇÃO NORMAL: pode repor arquivos gerenciados nos caminhos atuais.' Yellow
        Write-Host '1. Listar backups conhecidos e restaurar normalmente'
        Write-Host '2. Informar pasta de backup para restauração normal'
        Write-Host '3. Restaurar normalmente a última execução .min'
        Write-Host ''
        Show-Mensagem 'RECUPERAÇÃO HISTÓRICA: pesquisa o histórico imutável e exporta para outro arquivo; não sobrescreve o trabalho atual.' Cyan
        Write-Host '4. Pesquisar SelfMinifier-Tag'
        Write-Host '5. Consultar histórico por arquivo ou caminho'
        Write-Host '0. Voltar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Invoke-KnownBackupRestoreSelection }
            '2' {
                $directory = (Read-Host 'Pasta exata do backup').Trim()
                if ($directory) { Invoke-RestoreFlow backup $directory } else { Show-Mensagem 'Restauração cancelada.' Yellow }
            }
            '3' { Invoke-RestoreFlow last-min }
            '4' { Invoke-SearchHistoricalTag }
            '5' { Invoke-SearchHistoryByPath }
            '0' { return }
            default { Show-Mensagem 'Opção inválida; nenhum arquivo foi alterado.' Yellow }
        }
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
    if (-not $summary.ok -or -not $summary.configuration) { Show-Mensagem (Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração persistente.') Red; Confirmar-Continuar; return }
    while ($true) {
        Show-AppScreen
        Write-Host "`nModo de saída somente para esta execução:"
        Write-Host "Atual persistente: $(Get-ModoSaidaDescricao $summary.configuration.outputMode)"
        Write-Host '1. Manter a configuração persistente atual'
        Write-Host '2. Criar backup e sobrescrever os arquivos originais'
        Write-Host '3. Preservar os arquivos originais e criar arquivos .min'
        Write-Host '0. Cancelar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { [void]$Adjustments.Remove('outputMode'); Show-Mensagem 'Modo temporário definido para a configuração persistente.' Green; Confirmar-Continuar; return }
            '2' { $Adjustments.outputMode = 'BackupESobrescreverOriginais'; Show-Mensagem 'Modo temporário: criar backup e sobrescrever os arquivos originais.' Green; Confirmar-Continuar; return }
            '3' { $Adjustments.outputMode = 'PreservarOriginaisECriarMinificados'; Show-Mensagem 'Modo temporário: preservar os arquivos originais e criar arquivos .min.' Green; Confirmar-Continuar; return }
            '0' { Show-Mensagem 'Ajustes temporários cancelados; nenhuma alteração foi aplicada.' Yellow; return }
            default { Show-Mensagem 'Escolha inválida; nenhum ajuste foi aplicado. Escolha uma opção numerada.' Yellow }
        }
    }
}

function Invoke-EditOutputMode {
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        if ($summary.code -eq 'CONFIGURATION_MISSING') {
            Invoke-CreateInitialConfiguration
            $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
        }
        if (-not $summary.ok -or -not $summary.configuration) { Show-Mensagem (Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração persistente.') Red; Confirmar-Continuar; return }
    }
    $current = $summary.configuration.outputMode
    while ($true) {
        Show-AppScreen
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
        if ($newMode -eq $current) { Show-Mensagem 'O modo escolhido já está configurado; nenhuma alteração foi necessária.' Green; Confirmar-Continuar; return }
        Show-Mensagem "`nModo atual: $(Get-ModoSaidaDescricao $current)" Cyan
        Show-Mensagem "Novo modo: $(Get-ModoSaidaDescricao $newMode)" Cyan
        Write-Host '1. Salvar alteração'
        Write-Host '0. Cancelar'
        $confirmacao = (Read-Host 'Escolha').Trim()
        if ($confirmacao -ne '1') { Show-Mensagem 'Alteração cancelada; a configuração não foi modificada.' Yellow; return }
        $saved = Invoke-SelfMinifierBridge @{ command = 'update-output-mode'; outputMode = $newMode; confirmed = $true }
        if (-not $saved.ok) { Show-Mensagem (Get-BridgeErrorMessage $saved 'A configuração não foi salva.') Red; Confirmar-Continuar; return }
        Show-Mensagem "Configuração persistente salva: $(Get-ModoSaidaDescricao $newMode)" Green
        Confirmar-Continuar
        return
    }
}

function Invoke-EditBackupRoot {
    Show-AppScreen
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        Show-Mensagem (Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração persistente.') Red
        Confirmar-Continuar
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
        Confirmar-Continuar
        return
    }
    $mode = if ($saved.backupStorageMode -eq 'external') { 'externa' } else { 'interna' }
    Show-Mensagem "Armazenamento de backups salvo como $mode em Configuração V3." Green
    Confirmar-Continuar
}

function Invoke-PersistentConfiguration {
    while ($true) {
        Show-AppScreen
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
    Show-AppScreen
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
        Confirmar-Continuar
        return
    }
    $current = $summary.configuration.projectRoot
    Show-Mensagem "`nPASTA RAIZ DO PROJETO" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem 'Pasta raiz atual:' Cyan
    Show-Mensagem $current White
    $entrada = (Read-Host "`nInforme a nova pasta raiz do projeto. 0 = Cancelar").Trim()
    if ($entrada -eq '0' -or $entrada -eq '') {
        Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow
        Confirmar-Continuar
        return
    }
    if ($entrada -eq $current) {
        Show-Mensagem 'A nova pasta raiz é igual à atual; nenhuma alteração foi necessária.' Green
        Confirmar-Continuar
        return
    }
    Show-Mensagem "`nPasta raiz atual:" Cyan
    Show-Mensagem $current White
    Show-Mensagem 'Nova pasta raiz:' Cyan
    Show-Mensagem $entrada White
    Write-Host '1. Salvar alteração'
    Write-Host '0. Cancelar'
    $escolha = (Read-Host 'Escolha').Trim()
    switch ($escolha) {
        '1' {
            $saved = Invoke-SelfMinifierBridge @{ command = 'update-configuration-v2'; projectRoot = $entrada; confirmed = $true }
            if (-not $saved.ok) {
                $mensagem = Get-BridgeErrorMessage $saved 'Não foi possível salvar a nova pasta raiz do projeto.'
                if ($saved.changed) { $mensagem = "$mensagem A configuração pode ter sido alterada." }
                Show-Mensagem "Erro: $mensagem" Red
                Confirmar-Continuar
                return
            }
            Show-Mensagem "Pasta raiz do projeto salva: $($saved.configuration.projectRoot)" Green
            Confirmar-Continuar
        }
        '0' { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow }
        default { Show-Mensagem 'Opção inválida; nenhuma configuração foi alterada.' Yellow }
    }
}

function Invoke-EditFileTypes {
    Show-AppScreen
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
        Confirmar-Continuar
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
    if ($novoValor -eq $current) { Show-Mensagem 'Os tipos selecionados já estão configurados; nenhuma alteração foi necessária.' Green; Confirmar-Continuar; return }
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
                Confirmar-Continuar
                return
            }
            Show-Mensagem "Tipos de arquivo salvos: $(Get-TiposArquivoDescricao $saved.configuration.fileTypes)" Green
            Confirmar-Continuar
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
    Show-AppScreen
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
        Confirmar-Continuar
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
    if ($novoPerfil -eq $current) { Show-Mensagem 'O perfil selecionado já está configurado; nenhuma alteração foi necessária.' Green; Confirmar-Continuar; return }
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
                Confirmar-Continuar
                return
            }
            Show-Mensagem "Perfil de minificação salvo: $(Get-PerfilDescricao $saved.configuration.profile)" Green
            Confirmar-Continuar
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
    Show-AppScreen
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
    Confirmar-Continuar
}

function Show-IgnoredFilesList {
    Show-AppScreen
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
    Confirmar-Continuar
}

function Show-CurrentExclusions {
    Show-AppScreen
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
    Confirmar-Continuar
}

function Add-ExclusionEntry {
    param([ValidateSet('folder', 'file')][string]$Kind)
    Show-AppScreen
    $summary = Get-V2Summary
    if (-not $summary) { return }
    $info = Get-ExclusionInfo $Kind
    $current = @($summary.configuration.($info.Field))
    Show-Mensagem "`n$($info.TituloAdd)" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem 'Pasta raiz do projeto:' Cyan
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
                Confirmar-Continuar
                } else {
                    $mensagem = Get-BridgeErrorMessage $saved 'Não foi possível salvar a exclusão.'
                    if ($saved.changed) { $mensagem = "$mensagem A configuração pode ter sido alterada." }
                    Show-Mensagem "Erro: $mensagem" Red
                }
                Confirmar-Continuar
                return
            }
            $persistido = @($saved.configuration.($info.Field))
            Show-Mensagem "$($info.SucessoAdd): $($persistido[-1])" Green
            Confirmar-Continuar
        }
        '0' { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow }
        default { Show-Mensagem 'Opção inválida; nenhuma configuração foi alterada.' Yellow }
    }
}

function Remove-ExclusionEntry {
    param([ValidateSet('folder', 'file')][string]$Kind)
    Show-AppScreen
    $summary = Get-V2Summary
    if (-not $summary) { return }
    $info = Get-ExclusionInfo $Kind
    $current = @($summary.configuration.($info.Field))
    if ($current.Count -eq 0) {
        Show-Mensagem $info.VazioRemove Yellow
        Confirmar-Continuar
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
                Confirmar-Continuar
                return
            }
            Show-Mensagem "$($info.SucessoRemove): $remover" Green
            Confirmar-Continuar
        }
        '0' { Show-Mensagem 'Nenhuma configuração foi alterada.' Yellow }
        default { Show-Mensagem 'Opção inválida; nenhuma configuração foi alterada.' Yellow }
    }
}

function Invoke-EditIgnoredFolders {
    while ($true) {
        Show-AppScreen
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
        Show-AppScreen
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
        Show-AppScreen
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
    Show-AppScreen
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok -or -not $summary.configuration) {
        if ($summary.code -eq 'CONFIGURATION_MISSING') {
            Show-Mensagem 'Configuração persistente ausente; não há configuração atual para exibir.' Yellow
        } else {
            Show-Mensagem "Erro: $(Get-BridgeErrorMessage $summary 'Não foi possível carregar a configuração atual.')" Red
        }
        Confirmar-Continuar
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
    Show-Mensagem 'Pasta raiz do projeto:' Cyan
    Show-Mensagem $config.projectRoot White
    Show-Mensagem "Tipos de arquivo (TiposArquivo): $(Get-TiposArquivoDescricao $config.fileTypes)" Cyan
    Show-Mensagem "Motor (Motor): $($config.engine)" Cyan
    Show-Mensagem "Perfil (Perfil): $(Get-PerfilDescricao $config.profile)" Cyan
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
    Confirmar-Continuar
}

function Show-ConfigurationMenu {
    while ($true) {
        Show-AppScreen
        Show-Mensagem "`nCONFIGURAÇÕES" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Write-Host '1. Pasta raiz do projeto'
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
    Show-Mensagem "`nANÁLISE CONCLUÍDA" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    if ($Analysis.projectRoot) {
        Show-Mensagem 'Projeto:' Cyan
        Show-Mensagem $Analysis.projectRoot Gray
    }
    if ($Analysis.fileTypes -contains 'css' -and $Analysis.fileTypes -contains 'javascript') { $tipoDescricao = 'CSS + JavaScript' }
    elseif ($Analysis.fileTypes -contains 'css') { $tipoDescricao = 'CSS' }
    elseif ($Analysis.fileTypes -contains 'javascript') { $tipoDescricao = 'JavaScript' }
    else { $tipoDescricao = ($Analysis.fileTypes -join ', ') }
    Show-Mensagem "Tipos: $tipoDescricao" Cyan
    Show-Mensagem "Exclusões: $($Analysis.exclusions.folders) pasta(s), $($Analysis.exclusions.files) arquivo(s)" Cyan
    Show-Mensagem "`nEscopo" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem "CSS encontrados:          $($Analysis.counts.cssFound)"
    Show-Mensagem "JavaScript encontrados:    $($Analysis.counts.javascriptFound)"
    Show-Mensagem "`nResultado" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem "Arquivos candidatos:       $($Analysis.counts.eligible)"
    Show-Mensagem "Já minificados:            $($Analysis.counts.alreadyMinified)"
    Show-Mensagem "Ignorados:                 $($Analysis.counts.ignored)"
    Show-Mensagem "Tamanho dos candidatos:    $(Format-Kilobytes $Analysis.counts.candidateBytes)"
    Show-Mensagem "`nMotivos de exclusão" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    foreach ($entry in @($Analysis.ignoredByReason)) {
        Show-Mensagem "- $($entry.label): $($entry.count)" Gray
    }
}

function Show-ExecutionResult {
    param($execution)
    Show-Mensagem "`nMINIFICAÇÃO CONCLUÍDA" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem "Status: $(Get-ExecutionStatusLabel $execution.result.status)" Green
    Show-Mensagem 'Modo de saída:' Cyan
    Show-Mensagem (Get-ModoSaidaDescricao $execution.plan.outputMode) White
    Show-Mensagem "`nArquivos" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem "Planejados:                  $($execution.result.counts.planned)" White
    Show-Mensagem "Processados com sucesso:     $($execution.result.counts.createdSuccessfully)" Green
    Show-Mensagem "Minificados:                 $($execution.result.summary.processedCount)" White
    Show-Mensagem "Conflitos .min preservados:  $($execution.result.counts.skippedConflicts)" $(if ($execution.result.counts.skippedConflicts -gt 0) { 'Yellow' } else { 'Gray' })
    Show-Mensagem "`nVolume" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem "Tamanho antes:               $(Format-Kilobytes $execution.result.summary.originalBytes)" White
    Show-Mensagem "Tamanho após:                $(Format-Kilobytes $execution.result.summary.finalBytes)" White
    Show-Mensagem "Redução:                     $(Format-Kilobytes $execution.result.summary.reductionBytes)" White
    Show-Mensagem "Redução percentual:          $(Format-ReductionPercent $execution.result.summary.reductionPercent)" White
    if ($execution.result.noFilesChanged) {
        Show-Mensagem 'Nenhum arquivo foi alterado.' Yellow
    } else {
        Show-Mensagem 'Operação concluída com sucesso.' Green
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
        Show-AppScreen
        Show-Mensagem 'Nenhum arquivo elegível para minificação.' Yellow
        Confirmar-Continuar
        return
    }
    $pageSize = 10
    $totalPages = [math]::Ceiling($total / $pageSize)
    $page = 1
    while ($true) {
        Show-AppScreen
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
    Show-AppScreen
    Show-Mensagem 'Analisando o projeto...' Cyan
    Show-Mensagem 'Aguarde.' Gray
    $response = Invoke-SelfMinifierBridge @{ command = 'scan-analysis'; adjustments = $Adjustments }
    if (-not $response.ok) {
        Show-AppScreen
        Show-Mensagem "Erro: $(Get-BridgeErrorMessage $response 'A análise foi bloqueada por um diagnóstico indisponível.')" Red
        Confirmar-Continuar
        return
    }
    $analysis = $response.analysis
    $blockers = @($analysis.execution.diagnostics.blockers)
    if ($blockers.Count -gt 0 -or $analysis.execution.status -eq 'blocked') {
        Show-AppScreen
        Show-Mensagem 'A minificação está bloqueada:' Red
        foreach ($blocker in $blockers) {
            if ($blocker.message) { Show-Mensagem "- $($blocker.message)" Red }
            elseif ($blocker.reason) { Show-Mensagem "- $($blocker.reason)" Red }
            else { Show-Mensagem "- $($blocker.code)" Red }
        }
        Show-Mensagem 'Nenhum arquivo foi alterado.' Yellow
        Confirmar-Continuar
        return
    }
    if (@($analysis.execution.items).Count -eq 0) {
        Show-AppScreen
        Show-Mensagem 'Nenhum arquivo será minificado nesta análise.' Yellow
        Show-Mensagem 'Nenhum arquivo foi alterado.' Yellow
        Confirmar-Continuar
        return
    }
    while ($true) {
        Show-AppScreen
        Show-ProjectAnalysis $analysis
        if (@($analysis.execution.conflicts).Count -gt 0) {
            Show-Mensagem 'Conflitos de destino .min (serão ignorados e preservados):' Yellow
            foreach ($conflict in @($analysis.execution.conflicts)) { Show-Mensagem "- $($conflict.destinationPath)" Yellow }
        }
        Write-Host "`n1. Ver arquivos que serão minificados"
        Write-Host '2. Iniciar minificação'
        Write-Host '0. Cancelar'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Show-CandidatePreview $analysis }
            '2' {
                Show-Mensagem 'Minificação em andamento...' Cyan
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
                    Confirmar-Continuar
                    return
                }
                Show-ExecutionResult $execution
                Confirmar-Continuar
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
        Show-AppScreen
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

function Invoke-CreateInitialConfiguration {
    while ($true) {
        Show-AppScreen
        Show-Mensagem "`nCRIAR CONFIGURAÇÃO INICIAL" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Show-Mensagem 'Informe a pasta raiz do projeto: a pasta onde estão os arquivos do projeto que serão analisados e minificados.' Gray
        Show-Mensagem 'O caminho deve ser absoluto no Windows e apontar para um diretório existente.' Gray
        Show-Mensagem '0 = Cancelar' Gray
        $entrada = (Read-Host 'Pasta raiz do projeto (caminho completo)').Trim()
        if ($entrada -eq '0' -or $entrada -eq '') {
            Show-Mensagem 'Criação cancelada; a configuração não foi criada.' Yellow
            return
        }
        $preview = Invoke-SelfMinifierBridge @{ command = 'create-configuration'; projectRoot = $entrada; confirmed = $false }
        if (-not $preview.ok) {
            Show-Mensagem "Caminho inválido: $(Get-BridgeErrorMessage $preview 'A pasta informada não pôde ser validada.')" Red
            Confirmar-Continuar
            continue
        }
        $config = $preview.configuration
        Show-Mensagem "`nResumo da configuração inicial" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Show-Mensagem "Pasta raiz:       $($config.projectRoot)" White
        Show-Mensagem "Tipos de arquivo: $(Get-TiposArquivoDescricao $config.fileTypes)" White
        Show-Mensagem "Perfil:           $(Get-PerfilDescricao $config.profile)" White
        Show-Mensagem "Modo de saída:    $(Get-ModoSaidaDescricao $config.outputMode)" White
        Show-Mensagem 'Pastas ignoradas:' Cyan
        foreach ($folder in @($config.ignoredFolders)) { Show-Mensagem "- $folder" White }
        Show-Mensagem 'Arquivos ignorados:' Cyan
        if (@($config.ignoredFiles).Count -eq 0) { Show-Mensagem 'Nenhum' Gray } else { foreach ($file in @($config.ignoredFiles)) { Show-Mensagem "- $file" White } }
        if (-not (Confirmar-Acao 'Confirmar a criação da configuração')) {
            Show-Mensagem 'Criação cancelada; a configuração não foi criada.' Yellow
            return
        }
        $created = Invoke-SelfMinifierBridge @{ command = 'create-configuration'; projectRoot = $entrada; confirmed = $true }
        if (-not $created.ok) {
            Show-Mensagem "Erro: $(Get-BridgeErrorMessage $created 'A configuração não foi criada.')" Red
            Confirmar-Continuar
            continue
        }
        Show-Mensagem "Configuração criada e validada: $($created.configurationPath)" Green
        Confirmar-Continuar
        return
    }
}

function Show-CorrectConfiguration {
    Show-AppScreen
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    Show-Mensagem "`nCORRIGIR CONFIGURAÇÃO" Cyan
    Show-Mensagem '────────────────────────────────────' Cyan
    Show-Mensagem 'Arquivo:' Cyan
    Show-Mensagem $summary.configurationPath White
    Show-Mensagem 'Motivo da validação:' Cyan
    Show-Mensagem (Get-BridgeErrorMessage $summary 'A validação da configuração falhou.') White
    Show-Mensagem 'A configuração não será corrigida ou substituída automaticamente.' Yellow
    Show-Mensagem 'Corrija o arquivo manualmente e pressione Enter para tentar novamente.' Gray
    [void](Read-Host 'Pressione Enter para tentar novamente...')
    $retry = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if ($retry.ok) {
        Show-Mensagem 'Configuração válida detectada.' Green
        Confirmar-Continuar
        return $true
    }
    Show-Mensagem "A configuração ainda é inválida: $(Get-BridgeErrorMessage $retry 'A validação da configuração falhou.')" Red
    Confirmar-Continuar
    return $false
}

function Show-MissingConfigurationMenu {
    while ($true) {
        $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
        if ($summary.ok) { return $true }
        Show-AppScreen
        Show-Mensagem "`nCONFIGURAÇÃO NECESSÁRIA" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Show-Mensagem 'O SelfMinifier ainda não possui uma configuração válida.' White
        Write-Host '1. Criar configuração inicial'
        Write-Host '2. Backups, restauração e histórico'
        Write-Host '0. Sair'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' { Invoke-CreateInitialConfiguration }
            '2' { Show-RestoreMenu }
            '0' { return $false }
            default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
        }
    }
}

function Show-InvalidConfigurationMenu {
    while ($true) {
        $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
        if ($summary.ok) { return $true }
        Show-AppScreen
        Show-Mensagem "`nCONFIGURAÇÃO INVÁLIDA" Cyan
        Show-Mensagem '────────────────────────────────────' Cyan
        Show-Mensagem 'O arquivo configuracao.ini existe, mas não pôde ser validado.' White
        Show-Mensagem 'Motivo:' Cyan
        Show-Mensagem (Get-BridgeErrorMessage $summary 'A validação da configuração falhou.') White
        Show-Mensagem 'Nenhuma configuração será corrigida ou substituída automaticamente.' Yellow
        Write-Host '1. Corrigir configuração'
        Write-Host '2. Backups, restauração e histórico'
        Write-Host '0. Sair'
        $choice = (Read-Host 'Escolha').Trim()
        switch ($choice) {
            '1' {
                if (Show-CorrectConfiguration) { return $true }
            }
            '2' { Show-RestoreMenu }
            '0' { return $false }
            default { Show-Mensagem 'Opção inválida; nenhuma ação foi executada.' Yellow }
        }
    }
}

function Start-SelfMinifierUi {
    $identity = Invoke-SelfMinifierBridge @{ command = 'version' }
    if (-not $identity.ok) { Show-Mensagem "Não foi possível obter a versão do SelfMinifier. $($identity.diagnostic.message)" Red; return }
    $script:AppVersion = $identity.version
    $summary = Invoke-SelfMinifierBridge @{ command = 'summary' }
    if (-not $summary.ok) {
        $continuar = $false
        if ($summary.code -eq 'CONFIGURATION_MISSING') {
            $continuar = Show-MissingConfigurationMenu
        } else {
            $continuar = Show-InvalidConfigurationMenu
        }
        if (-not $continuar) { return }
    }
    while ($true) {
        Show-AppScreen
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
          catch { Show-Mensagem "Operação bloqueada: $($_.Exception.Message)" Red; Confirmar-Continuar }
    }
}
