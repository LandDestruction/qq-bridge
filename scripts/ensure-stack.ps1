# ensure-stack.ps1 -- keep SnowLuma + qq-bridge + the watchdog loop alive.
# Idempotent: safe to run at logon and every 2 minutes.
# Pure ASCII on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM,
# so a single non-ASCII character (even in a comment) breaks parsing.
$ErrorActionPreference = 'SilentlyContinue'
$root     = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'
$snowDir  = 'C:\SnowLuma'
$logDir   = Join-Path $root 'logs'
$stateDir = Join-Path $root 'state'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$log   = Join-Path $logDir 'ensure-stack.log'
$mutex = Join-Path $stateDir 'ensure.lock'

function WriteLog([string]$msg) {
  $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  Add-Content -Path $log -Value $line -Encoding UTF8
}

# Mutex: the watchdog runs every 2 minutes. Skip if the previous run is still going,
# otherwise logon + watchdog can race and spawn two bridges (the second dies on port 3100).
if (Test-Path $mutex) {
  $holder = 0
  try { $holder = [int](Get-Content $mutex -ErrorAction Stop) } catch { $holder = 0 }
  if ($holder -gt 0 -and (Get-Process -Id $holder -ErrorAction SilentlyContinue)) {
    WriteLog ('skip: another ensure is running (pid ' + $holder + ')')
    exit 0
  }
  Remove-Item $mutex -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $mutex -Value $PID -Encoding ASCII
try {
  $procs  = Get-CimInstance Win32_Process
  $node   = $procs | Where-Object { $_.Name -eq 'node.exe' }
  $snow   = $node  | Where-Object { $_.CommandLine -match 'SnowLuma\\index\.mjs' }
  $bridge = $node  | Where-Object { $_.CommandLine -match 'qq-bridge-src\\src\\bridge\.js' }
  $watch  = $procs | Where-Object { $_.CommandLine -match 'watchdog-stack\.ps1' }

  # A freshly started node may not show up in CIM for a second or two; fall back to
  # state\bridge.lock so we do not start a duplicate bridge.
  $lockPid = 0
  $lockFile = Join-Path $stateDir 'bridge.lock'
  if (Test-Path $lockFile) {
    try { $lockPid = [int](Get-Content $lockFile -ErrorAction Stop) } catch { $lockPid = 0 }
  }
  # The lock PID alone is not proof: Windows reuses PIDs, and a stale lock once made
  # ensure-stack believe a dead bridge was alive. Confirm the PID's command line too.
  $lockIsBridge = $false
  if ($lockPid -gt 0) {
    $lp = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $lockPid) -ErrorAction SilentlyContinue
    if ($lp -and $lp.Name -eq 'node.exe' -and $lp.CommandLine -match 'bridge\.js') { $lockIsBridge = $true }
  }
  $bridgeAlive = [bool]$bridge -or $lockIsBridge

  if (-not $snow) {
    WriteLog 'SnowLuma not running -> starting'
    Start-Process -FilePath (Join-Path $snowDir 'node.exe') `
      -ArgumentList 'index.mjs' -WorkingDirectory $snowDir -WindowStyle Hidden
  } else {
    WriteLog ('SnowLuma ok (pid ' + ($snow | Select-Object -First 1 -ExpandProperty ProcessId) + ')')
  }

  if (-not $bridgeAlive) {
    WriteLog 'bridge not running -> starting'
    Start-Process -FilePath 'node.exe' -ArgumentList 'src\bridge.js' -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDir 'bridge.out.log') `
      -RedirectStandardError  (Join-Path $logDir 'bridge.err.log')
  } else {
    WriteLog ('bridge ok (pid ' + ($bridge | Select-Object -First 1 -ExpandProperty ProcessId) + ' / lock ' + $lockPid + ')')
  }

  if (-not $watch) {
    WriteLog 'watchdog loop not running -> starting'
    Start-Process -FilePath 'powershell.exe' `
      -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $root 'scripts\watchdog-stack.ps1') `
      -WindowStyle Hidden
  } else {
    WriteLog ('watchdog ok (pid ' + ($watch | Select-Object -First 1 -ExpandProperty ProcessId) + ')')
  }
} finally {
  Remove-Item $mutex -Force -ErrorAction SilentlyContinue
}
