# probe-start.ps1 -- find out why the supervisor chain dies immediately (pure ASCII).
$ErrorActionPreference = 'Continue'
$root = '<本机路径>\Documents\deepseek-harness\qq-bridge-src'

Write-Output ('start-bridge-forever.bat exists: ' + (Test-Path (Join-Path $root 'start-bridge-forever.bat')))
Write-Output ('start.bat exists: ' + (Test-Path (Join-Path $root 'start.bat')))
$vbs = Join-Path $root 'scripts\start-bridge-hidden.vbs'
Write-Output ('vbs exists: ' + (Test-Path $vbs))

# run the bat synchronously with output captured to a file, detached from this console
$bat = Join-Path $root 'start-bridge-forever.bat'
$out = Join-Path $root 'logs\probe-start.out.log'
$err = Join-Path $root 'logs\probe-start.err.log'
Remove-Item $out -Force -ErrorAction SilentlyContinue
Remove-Item $err -Force -ErrorAction SilentlyContinue

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = '/c "' + $bat + '"'
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi
$null = $p.Start()
$done = $p.WaitForExit(6000)
Write-Output ('bat ran; exited within 6s: ' + $done)
if ($done) {
  Set-Content -Path $out -Value $p.StandardOutput.ReadToEnd() -Encoding UTF8
  Set-Content -Path $err -Value $p.StandardError.ReadToEnd() -Encoding UTF8
  Write-Output ('exit code: ' + $p.ExitCode)
}

Write-Output '--- stdout ---'
if (Test-Path $out) { Get-Content $out -Tail 20 | ForEach-Object { Write-Output ('  ' + $_) } }
Write-Output '--- stderr ---'
if (Test-Path $err) { Get-Content $err -Tail 20 | ForEach-Object { Write-Output ('  ' + $_) } }
