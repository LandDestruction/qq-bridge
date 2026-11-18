# run-elevated-register.ps1 -- launch the task registration with a UAC prompt (pure ASCII).
#
# The registration itself must run elevated (a bare Register-ScheduledTask with an
# Interactive principal needs admin; the earlier attempt failed with 0x80070005).
# This wrapper just asks Windows for elevation and waits for the result.
$ErrorActionPreference = 'Stop'
$root = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'
$script = Join-Path $root 'scripts\register-qqbridge-tasks.ps1'
$outLog = Join-Path $root 'logs\register-tasks.out.log'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null

$argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"'
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -Verb RunAs -Wait -PassThru
Write-Output ('elevated run exit code: ' + $p.ExitCode)
