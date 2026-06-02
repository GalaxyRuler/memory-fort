@echo off
REM ============================================================
REM  Memory Fort Dashboard launcher
REM  Builds the UI/server if missing, then starts the dashboard
REM  and opens the browser. Safe to run any time.
REM ============================================================
setlocal
cd /d "C:\CodexProjects\memory-system"

echo [Memory Fort] Checking dashboard build...

if not exist "dist\cli.mjs" (
  echo [Memory Fort] Server bundle missing - building...
  call npm run build || goto :error
)

if not exist "dist\dashboard-ui\index.html" (
  echo [Memory Fort] Dashboard UI missing - building...
  call npm run build:ui || goto :error
)

echo [Memory Fort] Starting dashboard at http://127.0.0.1:4410/memory/
echo [Memory Fort] (leave this window open; press Ctrl+C to stop)
node dist\cli.mjs dashboard
goto :eof

:error
echo.
echo [Memory Fort] Build failed. Check the output above.
pause
exit /b 1
