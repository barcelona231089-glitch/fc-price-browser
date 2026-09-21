@echo off
setlocal
cd /d C:\Users\barce\FCTraderBrain
if not exist logs mkdir logs
echo [%date% %time%] FUTBIN FC27 collector start>>logs\futbin_fc27_collector.log
py uv\futbin_fc27_collector.py "https://www.futbin.com/players" --adaptive --core-pages 4 --rotate-pages 4 --rotate-max-page 16 --delay 8 >>logs\futbin_fc27_collector.log 2>&1
if errorlevel 1 (
  echo [%date% %time%] collector failed>>logs\futbin_fc27_collector.log
  exit /b 1
)
echo [%date% %time%] collector ok>>logs\futbin_fc27_collector.log
