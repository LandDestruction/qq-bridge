# register-qqbridge-tasks.ps1 -- register the two logon tasks, window-hidden (pure ASCII).
#
# Design notes (learned the hard way, 2026-10-24):
#   * Everything DSH spawns dies when DSH restarts -- including SnowLuma, which used to be
#     started from the DSH subprocess tree. When SnowLuma dies the bridge cannot reach
#     OneBot and quits on its own. So BOTH processes must live under Task Scheduler.
#   * WMI-created processes and HKCU Run launchers were both dragged down with the DSH
#     session; scheduled tasks run under the Task Scheduler service and survive.
#   * Task Scheduler starts a console program (node.exe / cmd.exe) in a NEW VISIBLE console.
#     Launching through VBS with Run(..., 0, True) hides the console AND keeps the task in
#     Running state while the child lives.
#   * The VBS path is passed to wscript.exe WITHOUT surrounding quotes: these paths contain
#     no spaces, and a quoted argument made wscript exit 1 instantly (observed 02:59).
#   * No custom watchdog loop: start.bat already restarts node every 5s and the bridge has a
#     single-instance lock. An extra loop once spawned 4 concurrent supervisors.
#
# Registering needs elevation; run this from an elevated PowerShell.
$ErrorActionPreference = 'Stop'

$root      = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'
$snowVbs   = Join-Path $root 'scripts\start-snowluma-hidden.vbs'
$bridgeVbs = Join-Path $root 'scripts\start-bridge-hidden.vbs'

foreach ($f in @($snowVbs, $bridgeVbs)) {
  if (-not (Test-Path $f)) { throw ('missing launcher: ' + $f) }
}

$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# ---- task 1: SnowLuma, at logon, hidden ---------------------------------------
$snowName = 'QQBridge-SnowLuma'
Unregister-ScheduledTask -TaskName $snowName -Confirm:$false -ErrorAction SilentlyContinue
$snowAction  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $snowVbs -WorkingDirectory $root
$snowTrigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$snowSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$snowPrincipal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $snowName -Action $snowAction -Trigger $snowTrigger `
  -Settings $snowSettings -Principal $snowPrincipal `
  -Description 'SnowLuma OneBot gateway (hidden, autostart, independent of DSH).' | Out-Null
Write-Output ('registered ' + $snowName)

# ---- task 2: bridge supervisor, at logon + 20s delay, hidden -------------------
$bridgeName = 'QQBridge-Bridge'
Unregister-ScheduledTask -TaskName $bridgeName -Confirm:$false -ErrorAction SilentlyContinue
$bridgeAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $bridgeVbs -WorkingDirectory $root
$bridgeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$bridgeTrigger.Delay = 'PT20S'
$bridgeSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$bridgePrincipal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $bridgeName -Action $bridgeAction -Trigger $bridgeTrigger `
  -Settings $bridgeSettings -Principal $bridgePrincipal `
  -Description 'qq-bridge supervisor (start.bat loop), hidden. Survives DSH restarts.' | Out-Null
Write-Output ('registered ' + $bridgeName)

Write-Output '--- registered ---'
foreach ($n in @($snowName, $bridgeName)) {
  $t = Get-ScheduledTask -TaskName $n
  $a = $t.Actions[0]
  Write-Output ('  ' + $t.TaskName + '  exec=' + $a.Execute + '  args=' + $a.Arguments + '  hidden=' + $t.Settings.Hidden)
}
