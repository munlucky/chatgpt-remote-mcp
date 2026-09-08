# Generate an approval key only when .env still contains an example value.
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectDir '.env'
if (-not (Test-Path $envFile)) { Copy-Item -LiteralPath (Join-Path $projectDir '.env.example') -Destination $envFile }
$content = Get-Content -LiteralPath $envFile -Raw
$pattern = '(?m)^MCP_OAUTH_APPROVAL_KEY=(?:replace-with-a-random-secret|your_generated_32byte_hex_secret_key_here)?\r?$'
if ($content -match $pattern) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $secret = ($bytes | ForEach-Object { '{0:x2}' -f $_ }) -join ''
    $content = [regex]::Replace($content, $pattern, 'MCP_OAUTH_APPROVAL_KEY=' + $secret)
    [IO.File]::WriteAllText($envFile, $content, [Text.UTF8Encoding]::new($false))
    Write-Host 'Approval key saved to .env. Its value is not printed.'
} else { Write-Host 'Existing approval key retained.' }
Write-Host 'Configure the remaining paths, endpoint and tunnel token in .env, then run scripts/start.ps1.'
