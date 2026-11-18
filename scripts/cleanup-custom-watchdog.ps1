# cleanup-custom-watchdog.ps1 -- remove the hand-rolled watchdog stack (pure ASCII).
# Why: qq-bridge already ships its own supervisor (start.bat :loop + 5s timeout) and a
# single-instance lock. The custom watchdog duplicated that and spawned 4 concurrent loops.
$ErrorActionPreference = 'SilentlyContinue'
$root = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'

# 1. kill every custom watchdog loop (do NOT match this script itself)
$re = '-File\s+\S*watchdog-stack\.ps1'
$loops = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -match $re
}
$killed = 0
foreach ($p in $loops) { Stop-Process -Id $p.ProcessId -Force; $killed++ }
Write-Output ('killed watchdog loops: ' + $killed)
Start-Sleep -Seconds 2

# 2. remove the HKCU Run entry that pointed at the custom launcher
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'QQBridgeStack' -Force
if (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') {
  $v = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run').QQBridgeStack
  Write-Output ('QQBridgeStack after removal: [' + $v + ']')
}

# 3. clear stale lock files
foreach ($f in @('watchdog.lock','ensure.lock')) {
  $p = Join-Path $root ('state\' + $f)
  if (Test-Path $p) { Remove-Item $p -Force; Write-Output ('removed ' + $f) }
}

Write-Output 'cleanup done'
