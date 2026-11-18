# 以「脱离 DSH 进程树」的方式重启桥接。
# 背景：DSH 重启时会回收它启动的整棵进程树。若桥接是在 DSH 的工具调用里
# 用 node/Start-Process 起的，DSH 一重启桥接就被一起杀掉（表现为控制台/客户端
# 报「桥接没有起来」或 3100 直接 000）。这里改用 WMI Win32_Process.Create：
# 新进程的父进程是 WmiPrvSE，不在 DSH 的作业对象里，DSH 重启不影响它。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-bridge-detached.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-bridge-detached.ps1 -Kill
param([switch]$Kill)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $repo 'scripts\bridge-launcher.cmd'
$lock = Join-Path $repo 'state\bridge.lock'

if (-not (Test-Path $launcher)) { throw "找不到 $launcher" }

if ($Kill) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'bridge\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "已停止桥接 pid=$($_.ProcessId)" }
  Start-Sleep -Seconds 2
}

if (Test-Path $lock) { Remove-Item $lock -Force; '已清除 state\bridge.lock' }

$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = 'cmd.exe /c "' + $launcher + '"'
  CurrentDirectory = $repo
}
if ($r.ReturnValue -ne 0) { throw "启动失败，ReturnValue=$($r.ReturnValue)" }
"已启动（脱离子进程树）pid=$($r.ProcessId)"

$deadline = (Get-Date).AddSeconds(40)
$code = 0
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3100/api/status' -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    $code = [int]$resp.StatusCode
  } catch {
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } else { $code = 0 }
  }
  if ($code -ne 0) { break }
}
if ($code -eq 0) { throw '等了 40 秒 3100 仍无响应，请看 state\bridge.out' }
"3100 已响应：HTTP $code（401 = 活着，需要令牌）"
