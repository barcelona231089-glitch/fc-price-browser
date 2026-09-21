param(
  [Parameter(Mandatory=$true)][int]$Port,
  [Parameter(Mandatory=$true)][string]$BravePath,
  [Parameter(Mandatory=$true)][string]$ProfileDir,
  [Parameter(Mandatory=$true)][string]$ShortcutPath
)

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $ShortcutPath) | Out-Null
$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut($ShortcutPath)
$s.TargetPath = $BravePath
$s.Arguments = '--remote-debugging-port=' + $Port + ' --user-data-dir="' + $ProfileDir + '" --new-window --no-first-run --no-default-browser-check --start-minimized https://www.futbin.com/27/players'
$s.Save()
Start-Process explorer.exe -ArgumentList $ShortcutPath
