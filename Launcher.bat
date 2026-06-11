@echo off
chcp 65001 >nul
title Mitang TriCore Agent V5.0.0
echo.
echo   Mitang TriCore Agent V5.0.0 GA
echo   Tricore Fusion Agent
echo.
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found! Install from https://nodejs.org/
    pause & exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do echo [INFO] Node.js: %%i
echo.
if not exist "node_modules\" (
    echo [INFO] Installing dependencies...
    call npm install --production --no-audit --no-fund
    if %ERRORLEVEL% NEQ 0 ( echo [ERROR] Install failed! & pause & exit /b 1 )
    echo [DONE]
    echo.
)
echo [START] Launching Mitang TriCore Agent...
node src/index.js
pause
