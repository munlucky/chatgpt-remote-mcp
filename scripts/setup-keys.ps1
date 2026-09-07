# setup-keys.ps1
# Generates cryptographic keys and OAuth registration helpers for ChatGPT Remote MCP

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$envFile = Join-Path $projectDir ".env"
$envExample = Join-Path $projectDir ".env.example"

Write-Host "=== ChatGPT Remote MCP Setup Helper ===" -ForegroundColor Cyan

# 1. Ensure .env exists
if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Write-Host "Creating .env from .env.example..." -ForegroundColor Yellow
        Copy-Item $envExample $envFile
    } else {
        Write-Error ".env.example not found!"
    }
}

# 2. Generate 32-byte random hex key for MCP_OAUTH_APPROVAL_KEY
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$hexKey = ($bytes | ForEach-Object { "{0:x2}" -f $_ }) -join ""

Write-Host "`n[Generated OAuth Approval Key (32-byte Hex)]" -ForegroundColor Green
Write-Host $hexKey -ForegroundColor White

# Update .env with the generated key if not already set or is placeholder
$envContent = Get-Content $envFile -Raw
if ($envContent -match "MCP_OAUTH_APPROVAL_KEY=your_generated_32byte_hex_secret_key_here") {
    $envContent = $envContent -replace "MCP_OAUTH_APPROVAL_KEY=your_generated_32byte_hex_secret_key_here", "MCP_OAUTH_APPROVAL_KEY=$hexKey"
    Set-Content -Path $envFile -Value $envContent -NoNewline
    Write-Host "Updated MCP_OAUTH_APPROVAL_KEY in .env automatically." -ForegroundColor Green
} else {
    Write-Host "Notice: MCP_OAUTH_APPROVAL_KEY is already set in .env. Keep your existing key or update manually." -ForegroundColor Yellow
}

# 3. Generate Pre-registered OAuth Client Credentials (for Cloudflare DCR 403 bypass)
$clientId = [guid]::NewGuid().ToString()
$clientSecretBytes = New-Object byte[] 32
$rng.GetBytes($clientSecretBytes)
$clientSecret = ($clientSecretBytes | ForEach-Object { "{0:x2}" -f $_ }) -join ""

Write-Host "`n[Pre-registered Client Credentials for ChatGPT]" -ForegroundColor Green
Write-Host "Client ID:     $clientId" -ForegroundColor White
Write-Host "Client Secret: $clientSecret" -ForegroundColor White
Write-Host "`nUse these credentials in ChatGPT Advanced OAuth Settings if Dynamic Client Registration (DCR) is blocked by Cloudflare WAF." -ForegroundColor Gray

Write-Host "`nNext steps:" -ForegroundColor Cyan
Write-Host "1. Edit .env and configure SHARED_PATH, MCP_PUBLIC_URL, and CLOUDFLARE_TUNNEL_TOKEN."
Write-Host "2. Run .\scripts\start.ps1 to start the containers."
