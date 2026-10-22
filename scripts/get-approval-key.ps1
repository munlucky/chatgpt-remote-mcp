# get-approval-key.ps1
# Retrieves the MCP OAuth Approval Key for client authentication
param([switch]$Operator)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$envFile = Join-Path $projectDir '.env'

if (-not (Test-Path $envFile)) {
    Write-Error ".env file not found. Run .\scripts\setup-keys.ps1 first."
    exit 1
}

$approvalKey = ""
$keyName = if ($Operator) { 'MCP_OPERATOR_APPROVAL_KEY' } else { 'MCP_OAUTH_APPROVAL_KEY' }
Get-Content $envFile | ForEach-Object {
    if ($_ -match ('^\s*' + $keyName + '\s*=\s*(.*)\s*$')) {
        $approvalKey = $matches[1].Trim("'`"")
    }
}

if ([string]::IsNullOrWhiteSpace($approvalKey) -or $approvalKey -eq 'replace-with-a-random-secret') {
    Write-Host "$keyName is not configured yet. Run .\scripts\setup-keys.ps1." -ForegroundColor Yellow
    exit 1
}

Write-Host "`n=== ChatGPT Remote MCP $keyName ===" -ForegroundColor Cyan
Write-Host "Approval Key: " -NoNewline
Write-Host $approvalKey -ForegroundColor Green

# Copy to clipboard if available
try {
    Set-Clipboard -Value $approvalKey
    Write-Host "(Copied to clipboard!)" -ForegroundColor DarkGray
} catch {
    # Ignore if clipboard fails in non-interactive environment
}

Write-Host "`nUse this key in your browser when ChatGPT or another MCP client prompts for approval." -ForegroundColor Gray
Write-Host ""
