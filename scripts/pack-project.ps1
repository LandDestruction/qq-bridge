#requires -Version 5
# Build a clean distributable copy of the project (no runtime data, no secrets).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-project.ps1 [-DryRun]
# Output: dist\qq-bridge-<yyyyMMdd-HHmm>.zip + .sha256 (MANIFEST.tsv inside the zip)
#
# Exclusion rules live in scripts/pack-exclude.json (shared by both pack scripts).
# Before the zip is written, scripts/pack-egress-scan.mjs --stage <stage> must pass:
# no sensitive file names, and no local absolute paths left in any staged text file.
# -DryRun stops after that check and leaves the stage for inspection (no zip).

param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$dist = Join-Path $root 'dist'
# stage name must include $PID: the timestamp only resolves to minutes, so two processes
# packing within the same minute land in the same dir and the later one deletes the earlier
# one's stage via the Test-Path/Remove-Item guard below. Symptom: Remove-Item IOException,
# positive-control files missing, and a bogus egress-scan report. Hit the 2026-10-26 regression.
$stage = Join-Path $env:TEMP ("qq-bridge-pack-" + $stamp + "-" + $PID)
$zip = Join-Path $dist ("qq-bridge-$stamp.zip")

New-Item -ItemType Directory -Path $dist -Force | Out-Null
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# The whitelist must cover everything the DSH-side install actually reads:
#   dsh/agent-presets  -> authoritative source for preset patches (setup-dsh)
#   plugins/           -> QQ mode plugin bundle
#   assets/            -> console UI assets
# Missing dsh/ makes setup-dsh.mjs fail with ENOENT dsh/agent-presets/qq-chat/preset.yml,
# so the recipient is stuck at step 4 (verified 2026-10-27 in a temp DSH_HOME).
# roles/ is intentionally NOT packed: it holds private user role cards; shipping them is
# the user's decision, not a packaging default.
$includeDirs = @('src', 'scripts', 'docs', 'tools', 'public', 'dsh', 'plugins', 'assets', 'desktop')
$includeFiles = @(
  'package.json', 'package-lock.json', 'config.example.json', 'config.template.json',
  'README.md', 'README.en.md', 'README-COMMANDS.md', 'RULES.md',
  'LICENSE', 'start.bat', 'restart.bat', 'start-bridge-forever.bat',
  '_snowluma-catalog.json'
)
if (Test-Path (Join-Path $root 'AGENTS.md')) { $includeFiles += 'AGENTS.md' }

foreach ($d in $includeDirs) {
  $src = Join-Path $root $d
  if (Test-Path $src) { Copy-Item $src -Destination $stage -Recurse -Force }
}
foreach ($f in $includeFiles) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src -Destination (Join-Path $stage $f) -Force }
}

# ── Exclusions: read the shared manifest (do NOT hardcode names here) ─────────
$rulesFile = Join-Path $root 'scripts\pack-exclude.json'
if (-not (Test-Path $rulesFile)) { throw "missing exclusion manifest: $rulesFile" }
$rules = Get-Content $rulesFile -Raw -Encoding UTF8 | ConvertFrom-Json

# 1) stage-root items (runtime data, build output, bundled deps in normal mode)
#    NOTE: keep the null/empty filter -- an empty name would make Join-Path return the
#    stage root itself and delete the whole stage (this actually happened once).
$packMode = 'normal'
$modeRemove = @()
if ($rules.modeExtra -and $rules.modeExtra.$packMode) { $modeRemove = @($rules.modeExtra.$packMode.removeAtRoot) }
$removeAtRoot = @(@($rules.removeAtRoot) + $modeRemove) | Where-Object { $_ -and ([string]$_).Trim() -ne '' }
foreach ($n in $removeAtRoot) {
  if ([string]::IsNullOrWhiteSpace($n)) { continue }
  $p = Join-Path $stage $n
  if ($p -eq $stage) { throw "refusing to delete the stage root (empty exclusion name)" }
  if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
# 2) directories with these names at ANY depth (state/logs/__pycache__/…)
foreach ($n in $rules.removeDirsAnywhere) {
  Get-ChildItem $stage -Recurse -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq $n } | Sort-Object FullName -Descending |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
# 3) explicit relative paths (internal docs that .gitignore keeps out of the repo)
foreach ($rel in $rules.removePaths) {
  $p = Join-Path $stage $rel
  if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
# 4) file-name globs at ANY depth (*.log, *.bak*, .env*, privacy-rules.json, …)
Get-ChildItem $stage -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $name = $_.Name
  $hit = $false
  foreach ($g in $rules.removeNameGlobs) { if ($name -like $g) { $hit = $true; break } }
  if ($hit) { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
}
# 5) file-name globs only at the stage root (internal planning md, stray .py)
Get-ChildItem $stage -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $name = $_.Name
  $hit = $false
  foreach ($g in $rules.removeRootNameGlobs) { if ($name -like $g) { $hit = $true; break } }
  if ($hit) { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
}

# ── Sanitize the staged copy only (repo files stay untouched) ────────────────
# 1) known QQ/group IDs -> placeholder IDs; 2) local absolute paths -> placeholder.
$idMap = @{
  '100000001' = '100000001'
  '100000002' = '100000002'
  '100000003' = '100000003'
  '100000004' = '100000004'
  '100000005' = '100000005'
  '100000006' = '100000006'
  '100000007' = '100000007'
}
$san = $rules.sanitize
$binExt = @($san.binaryExtensions)
$pathPatterns = @($san.patterns)
Get-ChildItem $stage -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
  if ($binExt -contains $_.Extension.ToLower()) { return }
  $path = $_.FullName
  $content = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
  $original = $content
  foreach ($k in $idMap.Keys) {
    if ($content.Contains($k)) { $content = $content.Replace($k, $idMap[$k]) }
  }
  foreach ($pat in $pathPatterns) {
    $content = [regex]::Replace($content, $pat.regex, $pat.replace)
  }
  if ($content -ne $original) {
    [IO.File]::WriteAllText($path, $content, (New-Object Text.UTF8Encoding($false)))
  }
}

# ── Pre-release gate: no sensitive names, no local paths left in the stage ───
$scanner = Join-Path $root 'scripts\pack-egress-scan.mjs'
if (Test-Path $scanner) {
  & node $scanner --stage $stage
  if ($LASTEXITCODE -ne 0) {
    throw "pack-egress-scan failed (sensitive file name or local path left in stage) -- zip NOT written. Stage kept at $stage"
  }
} else {
  Write-Warning "scripts/pack-egress-scan.mjs not found; stage gate skipped"
}

if ($DryRun) {
  Write-Host "DRYRUN OK: stage ready at $stage (no zip written)"
  return
}

$manifest = Get-ChildItem $stage -Recurse -File | ForEach-Object {
  "{0}`t{1}" -f $_.FullName.Substring($stage.Length + 1), $_.Length
}
Set-Content -Path (Join-Path $stage 'MANIFEST.tsv') -Value $manifest -Encoding UTF8

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Set-Content -Path ("$zip.sha256") -Value ("$hash  " + (Split-Path $zip -Leaf)) -Encoding ASCII

$size = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "PACK OK: $zip ($size MB)"
Write-Host "SHA256: $hash"
Write-Host "MANIFEST.tsv included in zip"
