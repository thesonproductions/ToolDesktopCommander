@echo off
REM Quick public HTTPS tunnel to the local OpenCommander port (default 7800).
REM Install once:  winget install --id Cloudflare.cloudflared
REM The printed https://*.trycloudflare.com URL changes every run; for a stable URL
REM create a named tunnel (see OPENCOMMANDER.md) or use ngrok with a reserved domain.
setlocal
set PORT=%1
if "%PORT%"=="" set PORT=7800
cloudflared tunnel --url http://127.0.0.1:%PORT%
