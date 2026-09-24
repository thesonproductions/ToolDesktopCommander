@echo off
REM Start the OpenCommander HTTP MCP server (ChatGPT endpoint).
REM Jobs keep running even if this window is closed or the server restarts.
setlocal
cd /d "%~dp0\..\..\.."
if not exist "dist\opencommander\cli.js" (
  echo [OpenCommander] dist not found - building first...
  call npm run build || exit /b 1
)
title OpenCommander MCP
node dist\opencommander\cli.js serve %*
