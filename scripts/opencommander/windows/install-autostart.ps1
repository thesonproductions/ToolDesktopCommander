<#
  Registers two Windows scheduled tasks that start at logon (hidden):
    OpenCommander-Server  -> node dist\opencommander\cli.js serve
    OpenCommander-Tunnel  -> cloudflared tunnel run <name>   (only if -TunnelName is given)
  Usage (PowerShell):
    powershell -ExecutionPolicy Bypass -File scripts\opencommander\windows\install-autostart.ps1
    powershell -ExecutionPolicy Bypass -File scripts\opencommander\windows\install-autostart.ps1 -TunnelName opencommander
  Remove:  -Uninstall
#>
param([string]$TunnelName = "", [switch]$Uninstall)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$node = (Get-Command node).Source

if ($Uninstall) {
  foreach ($n in "OpenCommander-Server","OpenCommander-Tunnel") {
    Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Host "Removed OpenCommander scheduled tasks."
  exit 0
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$serverAction = New-ScheduledTaskAction -Execute $node -Argument "`"$repo\dist\opencommander\cli.js`" serve" -WorkingDirectory $repo
Register-ScheduledTask -TaskName "OpenCommander-Server" -Action $serverAction -Trigger $trigger -Settings $settings `
  -Description "OpenCommander MCP server for ChatGPT" -Force | Out-Null
Write-Host "Registered OpenCommander-Server (starts at logon, restarts on crash)."

if ($TunnelName -ne "") {
  $cf = (Get-Command cloudflared).Source
  $tunnelAction = New-ScheduledTaskAction -Execute $cf -Argument "tunnel run $TunnelName" -WorkingDirectory $repo
  Register-ScheduledTask -TaskName "OpenCommander-Tunnel" -Action $tunnelAction -Trigger $trigger -Settings $settings `
    -Description "Cloudflare tunnel for OpenCommander" -Force | Out-Null
  Write-Host "Registered OpenCommander-Tunnel ($TunnelName)."
}
Start-ScheduledTask -TaskName "OpenCommander-Server"
Write-Host "Started. Logs: $env:USERPROFILE\.opencommander\server.log   Dashboard: http://127.0.0.1:7801/"
