@echo off
setlocal

REM DHS-Lair launcher. Boots the dashboard server, mission worker,
REM memory consolidator, and all in-process workers in one shot.

cd /d "%~dp0"

echo.
echo === DHS-Lair launcher ===
echo  cwd: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found on PATH. Install Node 20+ and retry.
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    echo [setup] No .env found. Copying .env.example -^> .env
    copy /y ".env.example" ".env" >nul
  ) else (
    echo [warn] No .env or .env.example found. Continuing anyway.
  )
)

if not exist "node_modules" (
  echo [setup] node_modules missing. Running npm install...
  call npm install
  if errorlevel 1 (
    echo [error] npm install failed.
    pause
    exit /b 1
  )
)

echo [db] Running migrations...
call npm run migrate
if errorlevel 1 (
  echo [error] Migration failed. Aborting.
  pause
  exit /b 1
)

REM Read DASHBOARD_PORT from .env so we can pop the dashboard. Default 7777.
set "DASHBOARD_PORT=7777"
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="DASHBOARD_PORT" set "DASHBOARD_PORT=%%B"
)

echo.
echo [hive] Starting DHS-Lair on http://127.0.0.1:%DASHBOARD_PORT%/
echo        (Ctrl+C to stop)
echo.

REM Open the dashboard after a short delay, in the background.
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start "" http://127.0.0.1:%DASHBOARD_PORT%/"

call npm start

endlocal
