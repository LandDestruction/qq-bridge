# restart-watchdog.ps1 -- kill every watchdog loop, then start exactly one (hidden).
$ErrorActionPreference = 'SilentlyContinue'
$root  = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'
$state = Join-Path $root 'state'
$lock  = Join-Path $state 'watchdog.lock'

Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*watchdog-stack.ps1*' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
Start-Sleep -Seconds 2
Remove-Item $lock -Force
Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $root 'scripts\watchdog-stack.ps1') `
  -WindowStyle Hidden
Start-Sleep -Seconds 3
$n = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*watchdog-stack.ps1*' }).Count
Write-Output ('watchdog instances after restart: ' + $n)
