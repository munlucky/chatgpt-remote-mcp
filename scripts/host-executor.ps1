param(
    [ValidateSet("Start", "Stop", "Status")]
    [string]$Action = "Status",
    [string]$BuildId = ""
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$envFile = Join-Path $projectDir ".env"
$agentScript = Join-Path $scriptDir "host-executor.mjs"

function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path $Path)) {
        return $map
    }
    foreach ($line in Get-Content $Path) {
        if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$') {
            $key = $matches[1]
            $value = $matches[2].Trim()
            if (
                $value.Length -ge 2 -and
                (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                 ($value.StartsWith("'") -and $value.EndsWith("'")))
            ) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            $map[$key] = $value
        }
    }
    return $map
}

function Test-EnabledValue {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $false
    }
    return @("1", "true", "yes", "on") -contains $Value.Trim().ToLowerInvariant()
}

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

$envMap = Read-DotEnv $envFile
$enabled = Test-EnabledValue ([string]$envMap["MCP_HOST_EXECUTOR_ENABLED"])
$sharedPath = [string]$envMap["SHARED_PATH"]
if ([string]::IsNullOrWhiteSpace($sharedPath)) {
    throw "SHARED_PATH is required to manage the native host executor."
}
$sharedPath = [System.IO.Path]::GetFullPath($sharedPath)
$queuePath = Join-Path $sharedPath ".chatgpt-remote-mcp-host-exec"
$statusPath = Join-Path $queuePath "agent.json"
$lockPath = Join-Path $queuePath "agent.lock"
$controlPath = Join-Path $queuePath "agent.control.json"

$heartbeatMaxAgeMs = 5000
$heartbeatSetting = [string]$envMap["MCP_HOST_EXECUTOR_HEARTBEAT_MAX_AGE_MS"]
if (-not [string]::IsNullOrWhiteSpace($heartbeatSetting)) {
    $parsedHeartbeat = 0
    if ([int]::TryParse($heartbeatSetting, [ref]$parsedHeartbeat)) {
        $heartbeatMaxAgeMs = $parsedHeartbeat
    }
}

function Get-AgentStatus {
    if (-not (Test-Path $statusPath)) {
        return $null
    }
    try {
        return Get-Content -Raw $statusPath | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)
    try {
        return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    } catch {
        return $null
    }
}

function Test-AgentProcess {
    param($Status)
    if ($null -eq $Status) {
        return $false
    }
    $pidValue = 0
    if (-not [int]::TryParse([string]$Status.pid, [ref]$pidValue) -or $pidValue -le 0) {
        return $false
    }
    $process = Get-ProcessCommandLine $pidValue
    if ($null -eq $process) {
        return $false
    }
    $commandLine = [string]$process.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) {
        return $false
    }
    $scriptMatch = $commandLine.IndexOf(
        "host-executor.mjs",
        [System.StringComparison]::OrdinalIgnoreCase
    ) -ge 0
    $queueMatch = $commandLine.IndexOf(
        $queuePath,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -ge 0
    return $scriptMatch -and $queueMatch
}

function Test-AgentFresh {
    param($Status)
    if ($null -eq $Status -or [int]$Status.protocolVersion -ne 1) {
        return $false
    }
    try {
        # PowerShell 7 may decode ISO JSON dates as DateTime. Preserve its UTC
        # kind instead of formatting it as a local, timezone-free string.
        $heartbeat = [DateTimeOffset]$Status.lastHeartbeatAt
        $ageMs = ([DateTimeOffset]::UtcNow - $heartbeat.ToUniversalTime()).TotalMilliseconds
        return $ageMs -ge 0 -and $ageMs -le $heartbeatMaxAgeMs
    } catch {
        return $false
    }
}

function Write-AgentControl {
    param([string]$RequestedAction)
    New-Item -ItemType Directory -Path $queuePath -Force | Out-Null
    $control = @{
        action = $RequestedAction
        requestedAt = [DateTimeOffset]::UtcNow.ToString("o")
    } | ConvertTo-Json -Compress
    $temporary = "$controlPath.$([guid]::NewGuid().ToString('N')).tmp"
    Write-Utf8NoBom $temporary ($control + [Environment]::NewLine)
    Move-Item -Force $temporary $controlPath
}

function Stop-Agent {
    $status = Get-AgentStatus
    if ($null -eq $status) {
        Write-Host "Native host executor is not running." -ForegroundColor DarkGray
        return
    }
    if (-not (Test-AgentProcess $status)) {
        throw "Host executor status exists, but PID $($status.pid) cannot be verified as this project's executor. Refusing to terminate an unrelated process."
    }

    Write-AgentControl "stop"
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(5)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
        $process = Get-Process -Id ([int]$status.pid) -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            Write-Host "Native host executor stopped." -ForegroundColor Green
            return
        }
    }

    if (-not (Test-AgentProcess $status)) {
        throw "Host executor did not stop cleanly and its PID can no longer be verified. Refusing forced termination."
    }
    Stop-Process -Id ([int]$status.pid) -Force -ErrorAction Stop
    Write-Host "Native host executor required forced termination." -ForegroundColor Yellow
}

function Remove-StaleMetadata {
    $status = Get-AgentStatus
    if ($null -ne $status -and (Test-AgentProcess $status)) {
        return
    }

    if (Test-Path $statusPath) {
        Remove-Item -Force $statusPath
    }
    if (Test-Path $controlPath) {
        Remove-Item -Force $controlPath
    }

    if (Test-Path $lockPath) {
        $lockPid = 0
        try {
            $lockPid = [int](Get-Content -Raw $lockPath).Trim()
        } catch {
            $lockPid = 0
        }

        if ($lockPid -gt 0) {
            $lockProcess = Get-ProcessCommandLine $lockPid
            if ($null -ne $lockProcess) {
                $commandLine = [string]$lockProcess.CommandLine
                $isExecutor = (
                    $commandLine.IndexOf(
                        "host-executor.mjs",
                        [System.StringComparison]::OrdinalIgnoreCase
                    ) -ge 0
                )
                if ($isExecutor) {
                    throw "A host executor process exists without a valid status file. Stop PID $lockPid manually before restarting."
                }
            }
        }
        Remove-Item -Force $lockPath
    }
}

function Start-Agent {
    if (-not $enabled) {
        Write-Host "Native host executor is disabled (MCP_HOST_EXECUTOR_ENABLED=false)." -ForegroundColor DarkGray
        return
    }
    if (-not (Test-Path $agentScript)) {
        throw "Host executor script not found: $agentScript"
    }

    New-Item -ItemType Directory -Path $queuePath -Force | Out-Null
    $current = Get-AgentStatus
    if ($null -ne $current -and (Test-AgentProcess $current)) {
        $fresh = Test-AgentFresh $current
        $sameBuild = (
            [string]::IsNullOrWhiteSpace($BuildId) -or
            [string]::IsNullOrWhiteSpace([string]$current.buildId) -or
            [string]$current.buildId -eq "unknown" -or
            [string]$current.buildId -eq $BuildId
        )
        if ($fresh -and $sameBuild) {
            Write-Host "Native host executor is already healthy (PID $($current.pid))." -ForegroundColor Green
            return
        }
        Stop-Agent
    }

    Remove-StaleMetadata

    $nodeCommand = Get-Command node -ErrorAction Stop
    $nodePath = $nodeCommand.Source
    if ([string]::IsNullOrWhiteSpace($nodePath)) {
        $nodePath = $nodeCommand.Path
    }
    if ([string]::IsNullOrWhiteSpace($nodePath)) {
        throw "Unable to resolve node executable."
    }

    $oldBuildId = $env:MCP_HOST_EXECUTOR_BUILD_ID
    try {
        if ([string]::IsNullOrWhiteSpace($BuildId)) {
            $env:MCP_HOST_EXECUTOR_BUILD_ID = "unknown"
        } else {
            $env:MCP_HOST_EXECUTOR_BUILD_ID = $BuildId
        }
        $quote = [char]34
        $startArguments = @(
            "$quote$agentScript$quote",
            "--queue",
            "$quote$queuePath$quote"
        )
        $startParams = @{
            FilePath = $nodePath
            ArgumentList = $startArguments
            WorkingDirectory = $projectDir
            WindowStyle = "Hidden"
            PassThru = $true
        }
        $process = Start-Process @startParams
    } finally {
        $env:MCP_HOST_EXECUTOR_BUILD_ID = $oldBuildId
    }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
        if ($process.HasExited) {
            throw "Native host executor exited during startup with code $($process.ExitCode). Check '$queuePath\agent.log'."
        }
        $status = Get-AgentStatus
        if (
            $null -ne $status -and
            [int]$status.pid -eq $process.Id -and
            (Test-AgentProcess $status) -and
            (Test-AgentFresh $status)
        ) {
            if (
                -not [string]::IsNullOrWhiteSpace($BuildId) -and
                [string]$status.buildId -ne $BuildId
            ) {
                throw "Native host executor reported unexpected build ID '$($status.buildId)'."
            }
            Write-Host "Native host executor is healthy (PID $($status.pid), platform $($status.platform))." -ForegroundColor Green
            return
        }
    }

    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw "Native host executor did not publish a healthy heartbeat. Check '$queuePath\agent.log'."
}

function Show-AgentStatus {
    $status = Get-AgentStatus
    if ($null -eq $status) {
        Write-Host "Native host executor: stopped" -ForegroundColor DarkGray
        return
    }
    $processOk = Test-AgentProcess $status
    $fresh = Test-AgentFresh $status
    $state = if ($processOk -and $fresh) { "healthy" } elseif ($processOk) { "stale" } else { "invalid" }
    $color = if ($state -eq "healthy") { "Green" } elseif ($state -eq "stale") { "Yellow" } else { "Red" }
    Write-Host "Native host executor: $state (PID $($status.pid), platform $($status.platform), build $($status.buildId))" -ForegroundColor $color
}

switch ($Action) {
    "Start" { Start-Agent }
    "Stop" { Stop-Agent }
    "Status" { Show-AgentStatus }
}
