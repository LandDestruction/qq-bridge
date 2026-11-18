# check-stack.ps1 -- report bridge / SnowLuma / supervisor health (pure ASCII).
$ErrorActionPreference = 'SilentlyContinue'
$root = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'

Write-Output '--- node bridge process ---'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' } |
  ForEach-Object { Write-Output ('  PID ' + $_.ProcessId + '  ' + $_.CommandLine) }

Write-Output '--- cmd supervisor (start.bat / start-bridge-forever) ---'
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -match 'start\.bat|start-bridge-forever' } |
  ForEach-Object { Write-Output ('  PID ' + $_.ProcessId + '  ' + $_.CommandLine) }

Write-Output '--- wscript launcher ---'
Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" |
  ForEach-Object { Write-Output ('  PID ' + $_.ProcessId + '  ' + $_.CommandLine) }

Write-Output '--- SnowLuma ---'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'SnowLuma' } |
  ForEach-Object { Write-Output ('  PID ' + $_.ProcessId + '  ' + $_.CommandLine) }

Write-Output '--- bridge.lock ---'
$lock = Join-Path $root 'state\bridge.lock'
if (Test-Path $lock) {
  $raw = (Get-Content $lock -Raw).Trim()
  Write-Output ('  content=' + $raw)
  if ($raw -match '^\d+$') {
    $alive = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
    Write-Output ('  pid alive: ' + [bool]$alive)
  }
} else { Write-Output '  (missing)' }

Write-Output '--- last 5 log lines ---'
$log = Join-Path $root 'state\bridge.log'
if (Test-Path $log) { Get-Content $log -Tail 5 | ForEach-Object { Write-Output ('  ' + $_) } }
