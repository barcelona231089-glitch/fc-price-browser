@echo off
cd /d "%~dp0"
title FC27 FUTBIN Konsolenpreise
echo Oeffne im Browser: http://127.0.0.1:5187/uv/
node scripts\run-futbin-uv-local.mjs
pause
