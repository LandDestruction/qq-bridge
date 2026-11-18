#requires -Version 5
# One-shot bootstrap for a freshly extracted copy (ASCII only, PowerShell 5.1 safe).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
# Steps: check node -> npm ci (if node_modules missing) -> create config.json from example -> run setup-doctor -> print next steps.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "=== QQ Bridge bootstrap ===" -ForegroundColor Cyan
Write-Host "project: $root"

# 1) Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "[FAIL] Node.js not found. Install Node.js 22 LTS or newer: https://nodejs.org/" -ForegroundColor Red
  exit 1
}
$ver = (& node -p "process.versions.node").Trim()
Write-Host "[ok] node v$ver"

# 2) Dependencies
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host "[..] node_modules missing, running npm ci (needs network) ..."
  & npm ci
  if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] npm ci failed. Check network/proxy." -ForegroundColor Red; exit 1 }
} else {
  Write-Host "[ok] node_modules present"
}

# 3) Config
if (-not (Test-Path (Join-Path $root 'config.json'))) {
  Copy-Item (Join-Path $root 'config.example.json') (Join-Path $root 'config.json')
  Write-Host "[..] config.json created from config.example.json - EDIT IT: snowluma.accessToken, dsh.baseUrl, allow.groups, ownerQQ" -ForegroundColor Yellow
} else {
  Write-Host "[ok] config.json present"
}

# 4) Doctor
Write-Host ""
& node (Join-Path $root 'scripts\setup-doctor.mjs')
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
  Write-Host "NEXT: start the bridge with  node src/bridge.js  (or start.bat)" -ForegroundColor Green
  Write-Host "      then open http://127.0.0.1:3100 and read state/console-token"
} else {
  Write-Host "Fix the blocked items above, then run: node scripts/setup-doctor.mjs" -ForegroundColor Yellow
}
exit $code
