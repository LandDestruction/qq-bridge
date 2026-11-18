# start-bridge-wmi.ps1 -- start the bridge supervisor OUTSIDE any job object (pure ASCII).
#
# Why WMI: when wscript/cmd/node are launched from a shell that itself runs inside a
# Windows job object (the DSH subprocess runner), the whole tree is killed when that job
# is torn down. A process created by Win32_Process.Create belongs to WmiPrvSE, survives
# the caller, and therefore keeps the bridge alive across DSH restarts.
$ErrorActionPreference = 'SilentlyContinue'
$root = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'
$vbs  = Join-Path $root 'scripts\start-bridge-hidden.vbs'
$lock = Join-Path $root 'state\bridge.lock'

# 1. clear a stale lock (only when its PID is really gone)
if (Test-Path $lock) {
  $raw = (Get-Content $lock -Raw).Trim()
  $alive = $false
  if ($raw -match '^\d+$') { $alive = [bool](Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue) }
  if ($alive) {
    Write-Output ('bridge already alive (pid ' + $raw + '), not starting another')
    exit 0
  }
  Remove-Item $lock -Force
  Write-Output ('removed stale lock (pid ' + $raw + ')')
}

# 2. spawn through WMI so the supervisor is not owned by this shell's job
$cmd = 'wscript.exe "' + $vbs + '"'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root }
Write-Output ('spawn rc=' + $r.ReturnValue + ' wscript pid=' + $r.ProcessId)

Start-Sleep -Seconds 8

# 3. report what actually came up
$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]bridge\.js' })
$cmds  = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'"  | Where-Object { $_.CommandLine -match 'start\.bat|start-bridge-forever' })
Write-Output ('bridge node procs: ' + $nodes.Count)
foreach ($n in $nodes) { Write-Output ('  node PID ' + $n.ProcessId) }
Write-Output ('cmd supervisor procs: ' + $cmds.Count)
foreach ($c in $cmds) { Write-Output ('  cmd PID ' + $c.ProcessId) }
