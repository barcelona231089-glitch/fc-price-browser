$ErrorActionPreference = 'Stop'
$Root = 'C:\Users\barce\FCTraderBrain'
$WorkerDir = Join-Path $Root 'world-max-worker'
$RegistryRepo = 'C:\Users\barce\FCWorldMaxRegistry'
$Python = Join-Path $WorkerDir '.venv\Scripts\python.exe'
$Cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$Port = 18081
$WorkerOut = Join-Path $WorkerDir 'worker.stdout.log'
$WorkerErr = Join-Path $WorkerDir 'worker.stderr.log'
$TunnelOut = Join-Path $WorkerDir 'tunnel.stdout.log'
$TunnelErr = Join-Path $WorkerDir 'tunnel.stderr.log'

function Test-WorkerHealth {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
    return [bool]($r.ok -and $r.device -eq 'cuda' -and $r.chronos2.enabled)
  } catch { return $false }
}

function Start-WorldMaxWorker {
  if (Test-WorkerHealth) { return $null }
  $env:ENABLE_CHRONOS2 = '1'
  $env:ENABLE_TIMESFM3_SHADOW = '0'
  return Start-Process -FilePath $Python -ArgumentList @('-m','uvicorn','server:app','--host','127.0.0.1','--port',"$Port") -WorkingDirectory $WorkerDir -WindowStyle Hidden -RedirectStandardOutput $WorkerOut -RedirectStandardError $WorkerErr -PassThru
}
function Stop-OldTunnels {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '127\.0\.0\.1:18081' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-WorldMaxTunnel {
  Stop-OldTunnels
  Remove-Item $TunnelOut,$TunnelErr -Force -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $Cloudflared -ArgumentList @('tunnel','--url',"http://127.0.0.1:$Port",'--no-autoupdate') -WindowStyle Hidden -RedirectStandardOutput $TunnelOut -RedirectStandardError $TunnelErr -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Seconds 1
    $text = ''
    if (Test-Path $TunnelErr) { $text += (Get-Content $TunnelErr -Raw -ErrorAction SilentlyContinue) }
    if (Test-Path $TunnelOut) { $text += (Get-Content $TunnelOut -Raw -ErrorAction SilentlyContinue) }
    $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) { return @{ Process = $p; Url = $m.Value } }
    if ($p.HasExited) { throw "cloudflared exited with code $($p.ExitCode)" }
  } while ((Get-Date) -lt $deadline)
  throw 'Timed out waiting for Cloudflare quick tunnel URL'
}

function Test-PublicTunnel([string]$Url) {
  try {
    $r = Invoke-RestMethod -Uri "$Url/health" -TimeoutSec 8
    return [bool]($r.ok -and $r.device -eq 'cuda' -and $r.chronos2.enabled)
  } catch { return $false }
}
function Publish-Registry([string]$Url) {
  git -C $RegistryRepo fetch origin worldmax-registry | Out-Null
  git -C $RegistryRepo reset --hard origin/worldmax-registry | Out-Null
  $registryPath = Join-Path $RegistryRepo 'worker-registry.json'
  [ordered]@{
    workerUrl = $Url
    enabled = $true
    shadowMode = $true
    productionConfirmed = $false
    updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  } | ConvertTo-Json | Set-Content -Path $registryPath -Encoding UTF8
  git -C $RegistryRepo add worker-registry.json
  git -C $RegistryRepo diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    git -C $RegistryRepo commit -m "Refresh World-Max tunnel registry" | Out-Null
    git -C $RegistryRepo push origin worldmax-registry | Out-Null
  }
}

$null = Start-WorldMaxWorker
$healthDeadline = (Get-Date).AddSeconds(90)
while (-not (Test-WorkerHealth)) {
  if ((Get-Date) -gt $healthDeadline) { throw 'World-Max worker failed health check' }
  Start-Sleep -Seconds 2
}

$tunnel = Start-WorldMaxTunnel
Publish-Registry $tunnel.Url
while ($true) {
  Start-Sleep -Seconds 30
  if (-not (Test-WorkerHealth)) {
    $null = Start-WorldMaxWorker
    Start-Sleep -Seconds 10
  }

  $tunnelDead = $false
  try { $tunnelDead = $tunnel.Process.HasExited } catch { $tunnelDead = $true }
  if ($tunnelDead) {
    $tunnel = Start-WorldMaxTunnel
    Publish-Registry $tunnel.Url
    continue
  }
}
