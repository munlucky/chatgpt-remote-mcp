# Generate independent secrets only when .env still contains example or empty values.
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectDir '.env'
if (-not (Test-Path $envFile)) { Copy-Item -LiteralPath (Join-Path $projectDir '.env.example') -Destination $envFile }
$content = Get-Content -LiteralPath $envFile -Raw

function New-RandomHexSecret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ($bytes | ForEach-Object { '{0:x2}' -f $_ }) -join ''
}

function Set-GeneratedSecret([string]$Name, [string[]]$Placeholders) {
    $escaped = ($Placeholders | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $keyPattern = '(?m)^' + [regex]::Escape($Name) + '=(.*)\r?$'
    $replacePattern = '(?m)^' + [regex]::Escape($Name) + '=(?:' + $escaped + ')?\r?$'
    if ($script:content -match $replacePattern) {
        $secret = New-RandomHexSecret
        $script:content = [regex]::Replace($script:content, $replacePattern, $Name + '=' + $secret)
        Write-Host ($Name + ' configured. Its value is not printed.')
    } elseif ($script:content -notmatch $keyPattern) {
        $secret = New-RandomHexSecret
        if ($script:content.Length -gt 0 -and -not $script:content.EndsWith("`n")) { $script:content += "`r`n" }
        $script:content += $Name + '=' + $secret + "`r`n"
        Write-Host ($Name + ' added. Its value is not printed.')
    } else {
        Write-Host ('Existing ' + $Name + ' retained.')
    }
}

Set-GeneratedSecret 'MCP_OAUTH_APPROVAL_KEY' @('replace-with-a-random-secret', 'your_generated_32byte_hex_secret_key_here')
Set-GeneratedSecret 'MCP_PROBE_SECRET' @('replace-with-a-random-probe-secret')
[IO.File]::WriteAllText($envFile, $content, [Text.UTF8Encoding]::new($false))
Write-Host 'Configure the remaining paths, endpoint and tunnel token in .env, then run scripts/start.ps1.'
