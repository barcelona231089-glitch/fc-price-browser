$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\barce\FCTraderBrain'
$node = 'C:\Program Files\nodejs\node.exe'
$collector = Join-Path $repo 'futbinBraveCollectorV1.js'

# Keep the scheduled collector self-updating. Fail-open: a transient GitHub
# problem must not stop an otherwise healthy collection cycle.
try {
  Set-Location $repo
  & git pull --ff-only origin main *> $null
} catch {}

$tokenFile = Join-Path $env:LOCALAPPDATA 'FCTraderBrain\futbin-snapshot-ingest.token'
$token = $null
if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('FUTBIN_SNAPSHOT_INGEST_TOKEN', 'User') }
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('FUTBIN_SNAPSHOT_INGEST_TOKEN', 'Machine') }
if (-not $token) { exit 2 }

$env:FUTBIN_SNAPSHOT_INGEST_TOKEN = $token
$env:FUTBIN_SNAPSHOT_HOST_FILE = Join-Path $env:LOCALAPPDATA 'FCTraderBrain\futbin-snapshot-host.txt'
$env:FUTBIN_BRAVE_COLLECTOR_PORT = '9230'
$env:FUTBIN_BRAVE_COLLECTOR_MAX_CARDS = '20'
$env:FUTBIN_BRAVE_COLLECTOR_INTERVAL_MS = '1800000'
$env:FUTBIN_BRAVE_SPACING_MS = '2500'
$env:FUTBIN_BRAVE_CLOSE_AFTER_CYCLE = '1'

Set-Location $repo
& $node $collector --once
exit $LASTEXITCODE
