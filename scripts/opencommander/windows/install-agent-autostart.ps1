<#
  Registers a scheduled task that runs `opencommander agent` at logon (hidden),
  so this computer stays connected to the hub and ChatGPT can reach it any time
  you are signed in. Configure hub.url / hub.agent_key / machine_name first.
    powershell -ExecutionPolicy Bypass -File scripts\opencommander\windows\install-agent-autostart.ps1
  Remove:  -Uninstall
#>
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$node = (Get-Command node).Source
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName "OpenCommander-Agent" -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed OpenCommander-Agent task."
  exit 0
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$repo\dist\opencommander\cli.js`" agent" -WorkingDirectory $repo
Register-ScheduledTask -TaskName "OpenCommander-Agent" -Action $action -Trigger $trigger -Settings $settings `
  -Description "OpenCommander hub agent" -Force | Out-Null
Start-ScheduledTask -TaskName "OpenCommander-Agent"
Write-Host "OpenCommander-Agent installed and started. It reconnects automatically."
