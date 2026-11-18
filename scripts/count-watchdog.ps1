# count-watchdog.ps1 -- count live watchdog loops without matching the counting process itself.
$ErrorActionPreference = 'SilentlyContinue'
$re = '-File\s+\S*watchdog-stack\.ps1'
$list = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -match $re -and $_.CommandLine -notmatch 'count-watchdog'
}
Write-Output ('watchdog count: ' + @($list).Count)
$list | Select-Object ProcessId | ForEach-Object { Write-Output ('  pid ' + $_.ProcessId) }
