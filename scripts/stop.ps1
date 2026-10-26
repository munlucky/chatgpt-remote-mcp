# stop.ps1
# Stops the ChatGPT Remote MCP and Cloudflare Tunnel containers

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir

Set-Location $projectDir

& (Join-Path $scriptDir 'host-executor.ps1') -Action Stop

Write-Host "Stopping ChatGPT Remote MCP containers..." -ForegroundColor Yellow
docker compose down

Write-Host "All containers stopped successfully." -ForegroundColor Green
