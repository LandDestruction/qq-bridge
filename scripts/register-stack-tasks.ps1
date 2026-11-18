# register-stack-tasks.ps1 -- one-shot: disable the old NapCat bot tasks, register the
# qq-bridge autostart + watchdog tasks. Pure ASCII.
$ErrorActionPreference = 'Stop'
$vbs = '<本机路径>\Documents\deepseek-harness\qq-bridge-src\scripts\start-stack-hidden.vbs'
$wscript = 'C:\Windows\System32\wscript.exe'

foreach ($old in @('DSH-QQ-Bot', 'DSH-QQ-Bot-Watchdog')) {
  $t = Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue
  if ($t) {
    Disable-ScheduledTask -TaskName $old | Out-Null
    Write-Output ("disabled old task: " + $old)
  }
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $vbs + '"')
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = 'PT1M'
Register-ScheduledTask -TaskName 'QQBridge-Stack' -Action $action -Trigger $logon -Principal $principal -Settings $settings -Force | Out-Null
Write-Output 'registered: QQBridge-Stack (at logon, +1 min)'

$start = (Get-Date).AddMinutes(1)
$repeat = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName 'QQBridge-Watchdog' -Action $action -Trigger $repeat -Principal $principal -Settings $settings -Force | Out-Null
Write-Output 'registered: QQBridge-Watchdog (every 2 min)'
