@echo off
setlocal
cd /d "%~dp0"
title FC27 FUTBIN Konsolenpreise - automatische API
if not exist "node_modules\express\package.json" (
  echo Installiere einmalig die lokalen Abhaengigkeiten...
  call npm.cmd install --no-audit --no-fund --ignore-scripts
  if errorlevel 1 (
    echo Installation fehlgeschlagen. Node.js und Internet pruefen.
    pause
    exit /b 1
  )
)
echo.
echo Futbin-only lokale API: http://127.0.0.1:5187/api/uv/futbin-console/players
echo UEV-App: http://127.0.0.1:5187/uv/
echo Browser-Companion v1.5.0 muss in Brave aktiv sein.
echo.
node scripts\run-futbin-uv-local.mjs
pause
