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

Write-Host "Starting ChatGPT Remote MCP containers..." -ForegroundColor Cyan
docker compose up -d

Write-Host "Waiting for service health check..." -ForegroundColor Yellow
$timeout = 30
$elapsed = 0
$healthy = $false

while ($elapsed -lt $timeout) {
    Start-Sleep -Seconds 2
    $elapsed += 2
    $status = docker inspect --format '{{json .State.Health.Status}}' workmachine 2>$null
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
