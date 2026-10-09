@echo off
cd /d "%~dp0"
title FC UEV Brain - Original-App mit FUTBIN-PS-Preisquelle
if not exist "node_modules\express\package.json" (
  echo Installiere lokale Abhaengigkeiten einmalig...
  call npm.cmd install --no-audit --no-fund --ignore-scripts
  if errorlevel 1 (
    echo Installation fehlgeschlagen.
    pause
    exit /b 1
  )
)
echo Originale UEV-App: http://127.0.0.1:5188/uv/
echo FUTBIN-only FC27, PS-Konsole
node scripts\run-original-uv-futbin.mjs
pause
