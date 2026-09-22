param(
  [Parameter(Mandatory=$true)][int]$Port,
  [Parameter(Mandatory=$true)][string]$BravePath,
  [Parameter(Mandatory=$true)][string]$ProfileDir,
  [Parameter(Mandatory=$true)][string]$ShortcutPath
)

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $ShortcutPath) | Out-Null

# The collector profile is disposable browser state. Clear only its saved session so
# a crash/restart can never restore dozens of old FUTBIN tabs.
$sessionDir = Join-Path $ProfileDir 'Default\Sessions'
if (Test-Path $sessionDir) {
  Remove-Item -Path (Join-Path $sessionDir '*') -Force -ErrorAction SilentlyContinue
}

$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut($ShortcutPath)
$s.TargetPath = $BravePath
# App mode gives the isolated collector one reusable page and no tab strip.
$s.Arguments = '--remote-debugging-port=' + $Port + ' --user-data-dir="' + $ProfileDir + '" --no-first-run --no-default-browser-check --start-minimized --window-position=-32000,-32000 --hide-crash-restore-bubble --app=https://www.futbin.com/27/players'
$s.WindowStyle = 7
$s.Save()
Start-Process explorer.exe -ArgumentList $ShortcutPath

# Hide only the exact collector browser window. Never enumerate or hide normal Brave.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CollectorWindow {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@
$deadline = (Get-Date).AddSeconds(10)
do {
  $sigPort = '--remote-debugging-port=' + $Port
  $collector = Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object {
    $_.CommandLine -like ('*' + $sigPort + '*') -and $_.CommandLine -like ('*' + $ProfileDir + '*')
  } | Select-Object -First 1
  if ($collector) {
    $collectorProcess = Get-Process -Id $collector.ProcessId -ErrorAction SilentlyContinue
    if ($collectorProcess -and $collectorProcess.MainWindowHandle -ne 0) {
      [CollectorWindow]::ShowWindowAsync($collectorProcess.MainWindowHandle, 0) | Out-Null
      break
    }
  }
  Start-Sleep -Milliseconds 100
} while ((Get-Date) -lt $deadline)

# Normal Brave is never touched. Selection is restricted to the dedicated profile + CDP port.
