@echo off
setlocal
cd /d "%~dp0"
title Tomato Uploader Assistant

set "NODE_EXE=%~dp0node\node.exe"
if not exist "%NODE_EXE%" (
  where node.exe >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Node.js 20 or newer was not found.
    echo         Install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

if not exist "%~dp0node_modules\playwright\package.json" (
  echo [ERROR] Project dependencies were not installed.
  echo         Run npm install first.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0server.mjs" (
  echo [ERROR] server.mjs was not found:
  echo         %~dp0server.mjs
  echo.
  pause
  exit /b 1
)

echo ============================================
echo   Tomato Uploader Assistant
echo   URL: http://127.0.0.1:4321
echo   Keep this window open while using the app.
echo ============================================
echo.

rem If a healthy copy is already running, reuse it instead of starting a second server.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4321/api/status' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  echo The service is already running. Opening the app...
  start "" "http://127.0.0.1:4321/?refresh=%RANDOM%"
  exit /b 0
)

rem Remove only a stale copy of this portable app that still owns port 4321.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$root = [IO.Path]::GetFullPath('%~dp0'); $owner = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 4321 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($owner) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owner.OwningProcess) -ErrorAction SilentlyContinue; if ($p -and $p.Name -eq 'node.exe' -and $p.ExecutablePath -like ($root + '*')) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 400 } }"

"%NODE_EXE%" "%~dp0server.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo [ERROR] The service stopped with exit code %EXIT_CODE%.
) else (
  echo The service has stopped.
)
pause
exit /b %EXIT_CODE%
