param([int]$Hours = 24)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$reportDir = Join-Path $projectDir 'docs/runtime'
New-Item -ItemType Directory -Force $reportDir | Out-Null
$result = docker compose --project-directory $projectDir -f (Join-Path $projectDir 'docker-compose.yml') exec -T workmachine node /opt/chatgpt-remote-mcp/scripts/usage-report.mjs /var/log/mcp-usage $Hours
if ($LASTEXITCODE -ne 0) { throw 'Usage report failed' }
$report = $result | ConvertFrom-Json
$target = Join-Path $reportDir ('usage-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$result | Set-Content -LiteralPath $target -Encoding utf8
$result | Set-Content -LiteralPath (Join-Path $reportDir 'usage-latest.json') -Encoding utf8
Get-ChildItem -LiteralPath $reportDir -Filter 'usage-????????-??????.json' | Sort-Object Name -Descending | Select-Object -Skip 90 | ForEach-Object {
  if ($_.DirectoryName -eq $reportDir) { Remove-Item -LiteralPath $_.FullName }
}
$report | ConvertTo-Json -Depth 8
