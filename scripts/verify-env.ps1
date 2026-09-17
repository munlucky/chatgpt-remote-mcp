# verify-env.ps1
# Pre-flight environment check for new or existing machine setup

$ErrorActionPreference = 'Continue'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$envFile = Join-Path $projectDir '.env'

Write-Host "`n=== ChatGPT Remote MCP Environment Verification ===" -ForegroundColor Cyan

$issuesFound = 0
$warningsFound = 0

# 1. Check Docker Desktop / daemon
Write-Host "[1/5] Checking Docker daemon status..." -NoNewline
$dockerStatus = docker info 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host " [OK] Docker is running." -ForegroundColor Green
} else {
    Write-Host " [FAILED]" -ForegroundColor Red
    Write-Host "      Docker Desktop is not running or not in PATH." -ForegroundColor Yellow
    Write-Host "      Please start Docker Desktop and ensure the engine is active." -ForegroundColor Gray
    $issuesFound++
}

# 2. Check .env file
Write-Host "[2/5] Checking .env file..." -NoNewline
if (Test-Path $envFile) {
    Write-Host " [OK] .env exists." -ForegroundColor Green
} else {
    Write-Host " [FAILED]" -ForegroundColor Red
    Write-Host "      .env file not found. Run .\scripts\setup-keys.ps1 first." -ForegroundColor Yellow
    $issuesFound++
    exit 1
}

# Parse .env
$envContent = Get-Content $envFile
$envMap = @{}
foreach ($line in $envContent) {
    if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$') {
        $key = $matches[1]
        $val = $matches[2].Trim("'`"")
        $envMap[$key] = $val
    }
}

# 3. Check Cloudflare Tunnel Token & Public URL
Write-Host "[3/5] Checking Cloudflare Tunnel and Public URL..." -NoNewline
$tunnelToken = $envMap['CLOUDFLARE_TUNNEL_TOKEN']
$publicUrl = $envMap['MCP_PUBLIC_URL']
$tunnelOk = $true

if ([string]::IsNullOrWhiteSpace($tunnelToken) -or $tunnelToken -eq 'replace-with-your-tunnel-token') {
    Write-Host "`n      [ERROR] CLOUDFLARE_TUNNEL_TOKEN is empty or still placeholder." -ForegroundColor Red
    Write-Host "              Please issue a tunnel token from Cloudflare Zero Trust and set it in .env." -ForegroundColor Gray
    $tunnelOk = $false
    $issuesFound++
}

if ([string]::IsNullOrWhiteSpace($publicUrl) -or $publicUrl -eq 'https://mcp.example.com') {
    Write-Host "`n      [ERROR] MCP_PUBLIC_URL is empty or still placeholder." -ForegroundColor Red
    Write-Host "              Set your public domain (e.g. https://mcp2.yourdomain.com) in .env." -ForegroundColor Gray
    $tunnelOk = $false
    $issuesFound++
} elseif (-not ($publicUrl -match '^https?://')) {
    Write-Host "`n      [ERROR] MCP_PUBLIC_URL must start with https:// or http://." -ForegroundColor Red
    $tunnelOk = $false
    $issuesFound++
}

if ($tunnelOk) {
    Write-Host " [OK] Tunnel token and URL ($publicUrl) configured." -ForegroundColor Green
}

# 4. Check Host Path Mappings
Write-Host "[4/5] Checking host directory paths..." -NoNewline
$sharedPath = $envMap['SHARED_PATH']
$hostHome = $envMap['HOST_USER_HOME']
$pathsOk = $true

if ([string]::IsNullOrWhiteSpace($sharedPath) -or $sharedPath -eq 'C:/path/to/workspace') {
    Write-Host "`n      [ERROR] SHARED_PATH is empty or placeholder. Set this PC's workspace directory in .env." -ForegroundColor Red
    $pathsOk = $false
    $issuesFound++
} elseif (-not (Test-Path $sharedPath)) {
    Write-Host "`n      [ERROR] SHARED_PATH '$sharedPath' does not exist on this machine." -ForegroundColor Red
    $pathsOk = $false
    $issuesFound++
}

if ([string]::IsNullOrWhiteSpace($hostHome) -or $hostHome -eq 'C:/Users/your-username') {
    Write-Host "`n      [ERROR] HOST_USER_HOME is empty or placeholder. Set this PC's user home in .env." -ForegroundColor Red
    $pathsOk = $false
    $issuesFound++
} elseif (-not (Test-Path $hostHome)) {
    Write-Host "`n      [ERROR] HOST_USER_HOME '$hostHome' does not exist on this machine." -ForegroundColor Red
    $pathsOk = $false
    $issuesFound++
}

if ($pathsOk) {
    Write-Host " [OK] Host paths exist." -ForegroundColor Green
}

# 5. Check Secrets & Security Keys
Write-Host "[5/5] Checking security keys..." -NoNewline
$oauthKey = $envMap['MCP_OAUTH_APPROVAL_KEY']
$probeSecret = $envMap['MCP_PROBE_SECRET']
$keysOk = $true

if ([string]::IsNullOrWhiteSpace($oauthKey) -or $oauthKey -eq 'replace-with-a-random-secret') {
    Write-Host "`n      [ERROR] MCP_OAUTH_APPROVAL_KEY is empty or placeholder. Run .\scripts\setup-keys.ps1." -ForegroundColor Red
    $keysOk = $false
    $issuesFound++
}

if ([string]::IsNullOrWhiteSpace($probeSecret) -or $probeSecret -eq 'replace-with-a-random-probe-secret') {
    Write-Host "`n      [WARNING] MCP_PROBE_SECRET is empty. Run .\scripts\setup-keys.ps1." -ForegroundColor Yellow
    $warningsFound++
}

if ($keysOk) {
    Write-Host " [OK] Security keys generated." -ForegroundColor Green
}

# Summary
Write-Host "`n=== Verification Summary ===" -ForegroundColor Cyan
if ($issuesFound -eq 0) {
    if ($warningsFound -eq 0) {
        Write-Host "All checks PASSED! You are ready to run .\scripts\start.ps1." -ForegroundColor Green
    } else {
        Write-Host "Checks passed with $warningsFound warning(s). You can run .\scripts\start.ps1." -ForegroundColor Yellow
    }
} else {
    Write-Host "Found $issuesFound error(s). Please resolve them before starting the service." -ForegroundColor Red
}
Write-Host ""
