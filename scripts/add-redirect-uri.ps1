# add-redirect-uri.ps1
# Helper script to register ChatGPT connector redirect URIs to oauth-state.json inside workmachine

param (
    [Parameter(Mandatory=$true)]
    [string]$RedirectUri
)

$ErrorActionPreference = "Stop"

Write-Host "Registering Redirect URI: $RedirectUri" -ForegroundColor Cyan

# Check if workmachine container is running
$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location $projectDir
$containerRunning = docker compose ps -q workmachine
if (-not $containerRunning) {
    Write-Error "Container 'workmachine' is not running. Please start it with .\scripts\start.ps1 first."
}

# Update oauth-state.json using node inside workmachine
$nodeScript = @"
const fs = require('fs');
const statePath = process.env.MCP_OAUTH_STATE_FILE;
if (!statePath) throw new Error('MCP_OAUTH_STATE_FILE is required');
let state = { version: 1, clients: {}, tokens: {} };
try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
} catch (e) {}

const targetUri = process.argv[1].trim();
let updated = false;

for (const clientId in state.clients) {
    const client = state.clients[clientId];
    client.redirect_uris = client.redirect_uris || [];
    if (!client.redirect_uris.includes(targetUri)) {
        client.redirect_uris.push(targetUri);
        updated = true;
    }
    client.grant_types = client.grant_types || [];
    if (!client.grant_types.includes('refresh_token')) {
        client.grant_types.push('refresh_token');
        updated = true;
    }
}

if (updated) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    console.log('SUCCESS: Added redirect URI and refresh_token grant to all registered clients.');
} else {
    console.log('NOTICE: Redirect URI is already registered.');
}
"@

docker compose exec -T workmachine node -e "$nodeScript" "$RedirectUri"
Write-Host "Restarting workmachine to reload state in memory..." -ForegroundColor Yellow
docker compose restart workmachine > $null
Write-Host "Done! You can now authorize the connector in ChatGPT." -ForegroundColor Green
