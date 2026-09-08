# start.ps1
# Starts the ChatGPT Remote MCP and Cloudflare Tunnel containers

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$envFile = Join-Path $projectDir ".env"

if (-not (Test-Path $envFile)) {
    Write-Error ".env file not found. Run .\scripts\setup-keys.ps1 first and configure your .env settings."
}

Set-Location $projectDir

$helperSync = (& node (Join-Path $scriptDir 'sync-commit-helper.mjs')).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Commit helper synchronization failed' }
Write-Host ("Commit helper synchronization: " + $helperSync) -ForegroundColor DarkGray

Write-Host "Starting ChatGPT Remote MCP containers..." -ForegroundColor Cyan
$env:MCP_BUILD_ID = (& node (Join-Path $scriptDir 'build-id.mjs') $projectDir).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Source digest failed' }
docker compose build workmachine
if ($LASTEXITCODE -ne 0) { throw 'Image build failed; running service retained' }
$containerId = docker compose ps -q workmachine
if ($containerId) {
    docker compose exec -T workmachine node /opt/chatgpt-remote-mcp/scripts/live-probe.mjs --preflight
    if ($LASTEXITCODE -ne 0) { throw 'Active jobs or failed preflight; service retained' }
}
docker compose up -d --force-recreate
if ($LASTEXITCODE -ne 0) { throw 'Container startup failed' }

Write-Host "Waiting for service health check..." -ForegroundColor Yellow
$timeout = 120
$elapsed = 0
$healthy = $false

while ($elapsed -lt $timeout) {
    Start-Sleep -Seconds 2
    $elapsed += 2
    $containerId = docker compose ps -q workmachine
    $status = docker inspect --format '{{json .State.Health.Status}}' $containerId 2>$null
    if ($status -eq '"healthy"') {
        $healthy = $true
        break
    }
}

if ($healthy) {
    Write-Host "Containers are UP and HEALTHY!" -ForegroundColor Green
    & "$scriptDir\status.ps1"
} else {
    Write-Host "Warning: Healthcheck took longer than expected. Check logs with 'docker logs workmachine'." -ForegroundColor Yellow
}
