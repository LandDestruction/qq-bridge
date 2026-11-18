# watchdog-stack.ps1 -- hidden supervisor loop: run ensure-stack.ps1 every 2 minutes.
# Used instead of Task Scheduler because registering a task needs admin rights on this box
# (Register-ScheduledTask returns 0x80070005). Pure ASCII (PS 5.1 ANSI reads).
$ErrorActionPreference = 'SilentlyContinue'
$root   = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'
$ensure = Join-Path $root 'scripts\ensure-stack.ps1'
$stateDir = Join-Path $root 'state'
$lockFile = Join-Path $stateDir 'watchdog.lock'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

# Single instance, race-free: hold an exclusive handle on the lock file for the whole
# lifetime of the loop. A second loop cannot open it and exits immediately.
# (A read-PID-then-start check raced and once left six loops running.)
$handle = $null
try {
  $handle = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
} catch {
  exit 0
}
try {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes([string]$PID)
  $handle.Write($bytes, 0, $bytes.Length)
  $handle.Flush()
  for (;;) {
    try { & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ensure } catch {}
    Start-Sleep -Seconds 120
  }
} finally {
  if ($handle) { $handle.Dispose() }
}
