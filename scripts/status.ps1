# status.ps1
# Inspects container status, public health endpoint, and recent logs

$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$envFile = Join-Path $projectDir ".env"

Write-Host "`n=== Container Status ===" -ForegroundColor Cyan
docker compose --project-directory $projectDir -f (Join-Path $projectDir 'docker-compose.yml') ps

if (Test-Path $envFile) {
    $mcpUrlLine = Get-Content $envFile | Where-Object { $_ -match "^MCP_PUBLIC_URL=(.+)" }
    if ($mcpUrlLine -match "^MCP_PUBLIC_URL=(.+)") {
        $publicUrl = $matches[1].Trim()
        $healthUrl = "$publicUrl/health"
        Write-Host "`n=== Public Health Check ($healthUrl) ===" -ForegroundColor Cyan
        try {
            $resp = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 5
            Write-Host "Status: OK" -ForegroundColor Green
            Write-Host ($resp | ConvertTo-Json -Depth 3) -ForegroundColor White
        } catch {
            Write-Host "Failed to reach public health check endpoint: $_" -ForegroundColor Red
        }
    }
}

Write-Host "`n=== Recent MCP Server Logs ===" -ForegroundColor Cyan
docker compose --project-directory $projectDir -f (Join-Path $projectDir 'docker-compose.yml') logs --tail 15 workmachine
