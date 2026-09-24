@echo off
REM Connect this computer to the OpenCommander hub so ONE ChatGPT connector can drive it.
REM Configure once:  opencommander config set hub.url https://<hub>.workers.dev
REM                  opencommander config set hub.agent_key <AGENT_KEY>
REM                  opencommander config set machine_name PC
setlocal
cd /d "%~dp0\..\..\.."
if not exist "dist\opencommander\cli.js" call npm run build || exit /b 1
title OpenCommander agent
node dist\opencommander\cli.js agent %*
