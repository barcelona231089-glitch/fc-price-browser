@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Bitte zuerst Node.js 24 installieren.
  pause
  exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm wird eingerichtet...
  call npm install --global pnpm@11.25.0
  if errorlevel 1 goto failed
)
if not exist node_modules\.bin\tsc (
  call pnpm install --frozen-lockfile
  if errorlevel 1 goto failed
)
call pnpm setup:browser
if errorlevel 1 goto failed
call pnpm dev --open
if errorlevel 1 goto failed
exit /b 0
:failed
echo Start fehlgeschlagen. Siehe die Meldung oben oder README.md.
pause
exit /b 1
