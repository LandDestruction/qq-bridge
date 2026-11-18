# check-qqbridge.ps1 -- one-shot health report for the QQ bridge stack (pure ASCII).
$ErrorActionPreference = 'SilentlyContinue'
$root = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'

Write-Output '--- scheduled tasks ---'
foreach ($n in @('QQBridge-SnowLuma', 'QQBridge-Bridge')) {
  $t = Get-ScheduledTask -TaskName $n
  $i = Get-ScheduledTaskInfo -TaskName $n
  Write-Output ('  ' + $n + '  state=' + $t.State + '  lastResult=' + $i.LastTaskResult)
}

Write-Output '--- processes ---'
$bridge = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bridge\.js' -and $_.CommandLine -notmatch 'mcp-' })
Write-Output ('  bridge: ' + $bridge.Count)
foreach ($p in $bridge) { Write-Output ('    pid ' + $p.ProcessId) }
$snow = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.ExecutablePath -like 'C:\SnowLuma\*' })
Write-Output ('  snowluma: ' + $snow.Count)
foreach ($p in $snow) { Write-Output ('    pid ' + $p.ProcessId) }
$vbs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'start-bridge-hidden' })
Write-Output ('  bridge launcher (wscript): ' + $vbs.Count)

Write-Output '--- bridge.lock ---'
$lock = Join-Path $root 'state\bridge.lock'
if (Test-Path $lock) {
  $pid = (Get-Content $lock -Raw).Trim()
  $alive = $null -ne (Get-Process -Id $pid -ErrorAction SilentlyContinue)
  Write-Output ('  content=' + $pid + '  alive=' + $alive)
} else {
  Write-Output '  (none)'
}

Write-Output '--- ports ---'
foreach ($p in @(3000, 3001, 3100)) {
  $hit = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  Write-Output ('  ' + $p + ': ' + $(if ($hit) { 'LISTEN' } else { 'down' }))
}

Write-Output '--- DSH baseUrl / last log ---'
$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
Write-Output ('  config dsh.baseUrl=' + $cfg.dsh.baseUrl)
$log = Join-Path $root 'logs\bridge-stdout.log'
if (Test-Path $log) {
  Get-Content $log -Tail 4 | ForEach-Object { Write-Output ('  ' + $_) }
}
