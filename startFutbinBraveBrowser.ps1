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
$s.Arguments = '--remote-debugging-port=' + $Port + ' --user-data-dir="' + $ProfileDir + '" --no-first-run --no-default-browser-check --start-minimized --hide-crash-restore-bubble --app=https://www.futbin.com/27/players'
$s.WindowStyle = 7
$s.Save()
Start-Process explorer.exe -ArgumentList $ShortcutPath
# Never enumerate, hide, close, or otherwise touch normal Brave windows here.
# The collector is isolated by its dedicated --user-data-dir and CDP port only.
