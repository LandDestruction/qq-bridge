# restart-watchdog-wmi.ps1 -- kill every watchdog loop, then spawn exactly one through WMI.
# WMI is used on purpose: a process created by Win32_Process.Create belongs to WmiPrvSE,
# not to the shell's job object, so the caller's job can end cleanly (Start-Process children
# inherit the job and block later shell commands with "Job runner ... managed range empty").
$ErrorActionPreference = 'SilentlyContinue'
$root  = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'
$state = Join-Path $root 'state'

Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*watchdog-stack.ps1*' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
Start-Sleep -Seconds 2
Remove-Item (Join-Path $state 'watchdog.lock') -Force

$cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $root + '\scripts\watchdog-stack.ps1"'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root }
Write-Output ('spawn rc=' + $r.ReturnValue + ' pid=' + $r.ProcessId)
Start-Sleep -Seconds 4
$n = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*watchdog-stack.ps1*' }).Count
Write-Output ('watchdog instances: ' + $n)
