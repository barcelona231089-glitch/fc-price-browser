$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\barce\FCTraderBrain'
$node = 'C:\Program Files\nodejs\node.exe'
$collector = Join-Path $repo 'futbinBraveCollectorV1.js'
$logDir = Join-Path $repo 'logs'
$supervisorLog = Join-Path $logDir 'futbin-brave-supervisor.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$mutex = New-Object System.Threading.Mutex($false, 'Global\FCTraderFutbinCollectorSupervisor')
if (-not $mutex.WaitOne(0)) { exit 0 }

function Write-SupervisorLog([string]$Message) {
  Add-Content -Path $supervisorLog -Value ('[' + (Get-Date).ToUniversalTime().ToString('o') + '] ' + $Message)
}

try {
  while ($true) {
    $token = [Environment]::GetEnvironmentVariable('FUTBIN_SNAPSHOT_INGEST_TOKEN', 'User')
    if (-not $token) { $token = [Environment]::GetEnvironmentVariable('FUTBIN_SNAPSHOT_INGEST_TOKEN', 'Machine') }

    if (-not $token) {
      Write-SupervisorLog 'snapshot ingest token missing; retry in 5 minutes'
      Start-Sleep -Seconds 300
      continue
    }

    $env:FUTBIN_SNAPSHOT_INGEST_TOKEN = $token
    $env:FUTBIN_BRAVE_COLLECTOR_ENABLED = '1'
    $env:FUTBIN_BRAVE_COLLECTOR_PORT = '9230'
    $env:FUTBIN_BRAVE_COLLECTOR_MAX_CARDS = '6'
    $env:FUTBIN_BRAVE_COLLECTOR_INTERVAL_MS = '1800000'
    $env:FUTBIN_BRAVE_SPACING_MS = '3000'
    $env:FUTBIN_BRAVE_CLOSE_AFTER_CYCLE = '1'

    Set-Location $repo
    Write-SupervisorLog 'collector start'
    & $node $collector
    $exitCode = $LASTEXITCODE
    Write-SupervisorLog ('collector exited code=' + $exitCode + '; restart in 60 seconds')
    Start-Sleep -Seconds 60
  }
}
finally {
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
