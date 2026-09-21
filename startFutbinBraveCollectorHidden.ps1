$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\barce\FCTraderBrain'
$node = 'C:\Program Files\nodejs\node.exe'

$token = [Environment]::GetEnvironmentVariable('FUTBIN_SNAPSHOT_INGEST_TOKEN', 'User')
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('FUTBIN_SNAPSHOT_INGEST_TOKEN', 'Machine') }
if (-not $token) { exit 2 }

$env:FUTBIN_SNAPSHOT_INGEST_TOKEN = $token
$env:FUTBIN_BRAVE_COLLECTOR_ENABLED = '1'
$env:FUTBIN_BRAVE_COLLECTOR_PORT = '9230'
$env:FUTBIN_BRAVE_COLLECTOR_MAX_CARDS = '6'
$env:FUTBIN_BRAVE_COLLECTOR_INTERVAL_MS = '1800000'
$env:FUTBIN_BRAVE_SPACING_MS = '3000'

Set-Location $repo
& $node (Join-Path $repo 'futbinBraveCollectorV1.js')
