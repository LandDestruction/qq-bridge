<#
  demo-install.ps1 - real install / re-install / uninstall run of the built setup (L1).

  L1 means: after install, the bridge runs and the client connects, on a machine
  that has neither this project nor Node.js. So this demo also:
    - strips node from PATH for the install (proves the bundled node.exe is enough)
    - installs on a free port (the dev machine already runs the real bridge on 3100)
    - waits for post-install to start the bridge, then hits /api/status with the token
    - opens the client window and takes a screenshot (dist\desktop\installer-client-*.png)
    - after uninstall: bridge process gone, dir/registry/shortcuts clean

  Safety: installs into a fresh directory under %TEMP% (never
  %LOCALAPPDATA%\QQDeepSeekBot). Shortcuts + HKCU key are real while the demo runs
  and are removed by the uninstall step.

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less UTF-8 as
  ANSI and a multi-byte comment can swallow the following newline (seen in T28:
  a Chinese comment ate the "$p = Start-Process" line -> null reference).
#>
[CmdletBinding()]
param(
    [string]$Setup = '',
    [string]$InstallDir = '',
    [string]$EvidenceDir = 'dist\installer-demo',
    [int]$Port = 0,
    [switch]$KeepInstall
)

$ErrorActionPreference = 'Stop'
# this script lives in scripts\installer\; repo root is two levels up
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

if (-not $Setup) {
    $setupItem = Get-ChildItem (Join-Path $root 'dist\installer') -Filter 'QQDeepSeekBot-Setup-*.exe' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $setupItem) { throw 'no QQDeepSeekBot-Setup-*.exe found; run build-installer.ps1 first' }
    $Setup = $setupItem.FullName
}
if (-not (Test-Path $Setup)) { throw "setup not found: $Setup" }
if (-not $InstallDir) {
    $InstallDir = Join-Path $env:TEMP ('qdbt-demo-' + (Get-Date).ToString('HHmmss') + '-' + (Get-Random -Maximum 9999))
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$localDefault = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'QQDeepSeekBot'))
if ($InstallDir.TrimEnd('\') -eq $localDefault.TrimEnd('\')) { throw 'refusing to demo into the real install dir' }

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
# -EvidenceDir may be relative (default) or absolute (other windows pass their own
# sandbox temp dir). Join-Path with an absolute second argument produces an invalid
# path ("path's format is not supported"), so resolve it explicitly.
if ([System.IO.Path]::IsPathRooted($EvidenceDir)) {
    $evidenceDirFull = [System.IO.Path]::GetFullPath($EvidenceDir)
} else {
    $evidenceDirFull = [System.IO.Path]::GetFullPath((Join-Path $root $EvidenceDir))
}
New-Item -ItemType Directory -Force -Path $evidenceDirFull | Out-Null
$evidence = Join-Path $evidenceDirFull "demo-$stamp.log"
$script:results = @()

# Binaries launched from inside the session workspace hang in this environment
# (process appears, never executes). Run the setup from %TEMP% instead, after
# checking the copy is byte-identical.
$stagedSetup = Join-Path $env:TEMP ("QQDeepSeekBot-Setup-staged-$stamp.exe")
Copy-Item -LiteralPath $Setup -Destination $stagedSetup -Force
$hashBuilt = (Get-FileHash $Setup -Algorithm SHA256).Hash.ToLower()
$hashStaged = (Get-FileHash $stagedSetup -Algorithm SHA256).Hash.ToLower()
if ($hashBuilt -ne $hashStaged) { throw 'staged setup copy does not match built artifact' }
$setupBuiltPath = $Setup
$Setup = $stagedSetup

function Say([string]$msg) { Write-Host $msg; Add-Content -LiteralPath $evidence -Value $msg -Encoding UTF8 }
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    $line = $(if ($ok) { 'PASS' } else { 'FAIL' }) + ' | ' + $name + $(if ($detail) { ' | ' + $detail } else { '' })
    $script:results += [pscustomobject]@{ Name = $name; Ok = $ok; Detail = $detail }
    Say $line
}
trap { try { Say ("FATAL: " + ($_ | Out-String)) } catch { }; exit 9 }

function ShortcutTarget([string]$lnkPath) {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnkPath)
    return $sc.TargetPath
}
function RegistryState() {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\QQDeepSeekBot'
    if (-not (Test-Path $key)) { return $null }
    return Get-ItemProperty -Path $key
}
function Test-Port([int]$p) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $c.ConnectAsync('127.0.0.1', $p)
        if (-not $task.Wait(300)) { return $false }
        return $c.Connected
    } catch { return $false } finally { try { $c.Close() } catch { } }
}
function Free-Port() {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $l.Start(); $p = ([System.Net.IPEndPoint]$l.LocalEndpoint).Port; $l.Stop(); return $p
}

$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'QQ DeepSeek Bot.lnk'
$startLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'QQ DeepSeek Bot.lnk'
$clientExe = Join-Path $InstallDir 'QQDeepSeekBot.exe'
if (-not $Port) { $Port = Free-Port }

Say "=== QQ DeepSeek Bot installer demo (L1) $stamp ==="
Say "setup      = $setupBuiltPath"
Say "setup copy = $Setup (sha256 $hashStaged)"
Say "installDir = $InstallDir"
Say "consolePort= $Port"
Say "evidence   = $evidence"

# ---- clean slate -----------------------------------------------------------
Say ''
Say '--- step 0: clean slate ---'
Get-Process QQDeepSeekBot -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
Remove-Item $desktopLnk, $startLnk -Force -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\QQDeepSeekBot' -Recurse -Force -ErrorAction SilentlyContinue
Check 'clean slate: no install dir' (-not (Test-Path $InstallDir))
Check 'clean slate: no uninstall key' ((RegistryState) -eq $null)
Check 'clean slate: demo port is free' (-not (Test-Port $Port)) "port=$Port"

# ---- install with node stripped from PATH ---------------------------------
Say ''
Say '--- step 1: silent install with NO node on PATH ---'
$origPath = $env:PATH
$pathParts = $origPath.Split(';') | Where-Object { $_ -and ($_ -notmatch 'nodejs') }
$env:PATH = ($pathParts -join ';')
$nodeOnPath = Get-Command node -ErrorAction SilentlyContinue
Say "PATH has node? $(if ($nodeOnPath) { $nodeOnPath.Source } else { 'NO (stripped)' })"
Check 'node is NOT on PATH for this install' ($null -eq $nodeOnPath)

# Do NOT use Start-Process -Wait here: it waits for the whole process tree, and
# the installer leaves a long-running bridge (node.exe) behind -> it never returns.
$p = Start-Process -FilePath $Setup -ArgumentList @('/S', "/D=$InstallDir", "/port=$Port", '/owner=100000001', '/nolaunch') -PassThru
$p.WaitForExit()
Say "installer exit = $($p.ExitCode)"
Check 'installer exit code 0' ($p.ExitCode -eq 0) "exit=$($p.ExitCode)"
$env:PATH = $origPath
Say 'PATH restored'

Check 'bundled node.exe installed' (Test-Path (Join-Path $InstallDir 'node.exe'))
if (Test-Path (Join-Path $InstallDir 'node.exe')) {
    $nodeSize = (Get-Item (Join-Path $InstallDir 'node.exe')).Length
    Check 'bundled node.exe looks real (>50 MB)' ($nodeSize -gt 50MB) "$([math]::Round($nodeSize/1MB,1)) MB"
}
Check 'bridge entry src/bridge.js installed' (Test-Path (Join-Path $InstallDir 'src\bridge.js'))
Check 'node_modules installed' (Test-Path (Join-Path $InstallDir 'node_modules'))
Check 'dsh presets installed' (Test-Path (Join-Path $InstallDir 'dsh'))
Check 'public/client.html installed' (Test-Path (Join-Path $InstallDir 'public\client.html'))
Check 'config.template.json installed' (Test-Path (Join-Path $InstallDir 'config.template.json'))
Check 'config.json created from template' (Test-Path (Join-Path $InstallDir 'config.json'))
if (Test-Path (Join-Path $InstallDir 'config.json')) {
    $cfgObj = Get-Content (Join-Path $InstallDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Check 'config.json consolePort honours /port=' ([int]$cfgObj.consolePort -eq $Port) "want=$Port got=$($cfgObj.consolePort)"
    Check 'config.json ownerQQ from /owner=' ([string]$cfgObj.ownerQQ -eq '100000001') "got=$($cfgObj.ownerQQ)"
    Check 'config.json allow.groups placeholders cleaned' (@($cfgObj.allow.groups).Count -eq 0) "got=$(@($cfgObj.allow.groups) -join ',')"
}
Check 'Uninstall.exe installed' (Test-Path (Join-Path $InstallDir 'Uninstall.exe'))
Check 'ops/post-install.ps1 present' (Test-Path (Join-Path $InstallDir 'ops\post-install.ps1'))
Check 'payload has NOTICE.txt' (Test-Path (Join-Path $InstallDir 'NOTICE.txt'))

$desktopOk = Test-Path $desktopLnk
Check 'desktop shortcut created' $desktopOk $desktopLnk
Check 'start menu shortcut created' (Test-Path $startLnk) $startLnk
if ($desktopOk) {
    $target = ShortcutTarget $desktopLnk
    Check 'desktop shortcut target = client exe' ([string]::Equals($target, $clientExe, 'OrdinalIgnoreCase')) "target=$target"
    Check 'shortcut target is not cmd.exe' ($target -notmatch 'cmd\.exe')
    Check 'shortcut target is not msedge' ($target -notmatch 'msedge')
}
$reg = RegistryState
Check 'HKCU uninstall key exists' ($reg -ne $null)
if ($reg) {
    Check 'DisplayName = QQ DeepSeek Bot' ($reg.DisplayName -eq 'QQ DeepSeek Bot') "got=$($reg.DisplayName)"
    Check 'DisplayIcon points at client exe' ($reg.DisplayIcon -like ($clientExe + '*')) "got=$($reg.DisplayIcon)"
    Check 'UninstallString points at Uninstall.exe' ($reg.UninstallString -like '*Uninstall.exe*') "got=$($reg.UninstallString)"
}

# ---- post-install started the bridge ---------------------------------------
Say ''
Say '--- step 2: bridge started by post-install ---'
$bridgeUp = $false
for ($i = 0; $i -lt 60; $i++) { if (Test-Port $Port) { $bridgeUp = $true; break }; Start-Sleep -Milliseconds 500 }
Check 'bridge listening on demo port' $bridgeUp "port=$Port"
$postLog = Join-Path $InstallDir 'logs\post-install.log'
Check 'post-install.log written' (Test-Path $postLog) $postLog
$nodeProc = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, 'OrdinalIgnoreCase') } | Select-Object -First 1
Check 'bridge runs on the BUNDLED node.exe' ($null -ne $nodeProc) $(if ($nodeProc) { "pid=$($nodeProc.Id) path=$($nodeProc.Path)" } else { 'no node.exe from install dir' })

$statusOk = $false; $statusText = ''
$tokenPath = Join-Path $InstallDir 'state\console-token'
if (Test-Path $tokenPath) {
    $token = (Get-Content $tokenPath -Raw).Trim()
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$Port/api/status") -Headers @{ 'x-console-token' = $token } -TimeoutSec 8 -UseBasicParsing
        $statusText = $r.Content
        $statusOk = ($r.StatusCode -eq 200 -and $statusText.Length -gt 10)
    } catch { $statusText = 'ERR ' + $_.Exception.Message }
}
Check 'state/console-token generated' (Test-Path $tokenPath)
Check '/api/status returns data with token' $statusOk $statusText.Substring(0, [Math]::Min(200, $statusText.Length))

# ---- client window ---------------------------------------------------------
Say ''
Say '--- step 3: client window ---'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $clientExe
$psi.UseShellExecute = $true
[void][System.Diagnostics.Process]::Start($psi)
$title = ''; $clientProc = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $cand = Get-Process QQDeepSeekBot -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($cand) { $clientProc = $cand; $title = $cand.MainWindowTitle; if ($title) { break } }
}
Check 'client window shows up (title starts with brand)' ($title -like 'QQ DeepSeek Bot*') "title=$title"

$shot = ''
if ($clientProc -and $clientProc.MainWindowHandle -ne 0) {
    Add-Type -AssemblyName System.Drawing
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W3 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
    $hwnd = [IntPtr]$clientProc.MainWindowHandle
    # 截图前必须把窗口提到最前并确认它真的是前台窗口，否则 CopyFromScreen 拍到的是
    # 同一块屏幕上别的程序（第一次就拍成了 QQ 聊天窗）。
    [void][W3]::ShowWindow($hwnd, 9)
    [void][W3]::MoveWindow($hwnd, 40, 40, 1024, 700, $true)
    $rect = New-Object W3+RECT
    [void][W3]::GetWindowRect($hwnd, [ref]$rect)
    [void][W3]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 1200
    # 别的程序（比如 QQ）可能在这几秒里抢焦点：重试几次，只有确认在我们窗口上才截图
    $fg = [W3]::GetForegroundWindow()
    for ($k = 0; $k -lt 15 -and $fg -ne $hwnd; $k++) {
        [void][W3]::SetForegroundWindow($hwnd)
        Start-Sleep -Milliseconds 400
        $fg = [W3]::GetForegroundWindow()
    }
    if ($fg -ne $hwnd) {
        # Some apps (QQ) keep stealing focus. A real click on the title bar is the
        # only thing Windows honours; click the title bar, not the page, so we do
        # not interact with the client UI.
        [void][W3]::SetCursorPos($rect.Left + 120, $rect.Top + 12)
        [W3]::mouse_event(0x0002, 0, 0, 0, 0)
        [W3]::mouse_event(0x0004, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 500
        $fg = [W3]::GetForegroundWindow()
    }
    Check 'client window is foreground before capture' ($fg -eq $hwnd) "fg=$fg hwnd=$hwnd"
    [void][W3]::GetWindowRect($hwnd, [ref]$rect)
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
    # 即便抢不到前台，也可以把窗口临时置顶（HWND_TOPMOST）再拍，拍到的一定是自己。
    $raised = [W3]::SetWindowPos($hwnd, [IntPtr](-1), $rect.Left, $rect.Top, $w, $h, 0x0040)
    Start-Sleep -Milliseconds 700
    Check 'client window raised to topmost for capture' ($raised -or $fg -eq $hwnd)
    if ($w -gt 100 -and $h -gt 100) {
        # dist may be read-only in another window's sandbox; fall back to the
        # evidence dir so the run still produces a picture.
        $shotDir = Join-Path $root 'dist\desktop'
        try {
            New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
            $probe = Join-Path $shotDir ".write-probe-$stamp"
            [IO.File]::WriteAllText($probe, 'x'); Remove-Item $probe -Force
        } catch {
            $shotDir = $evidenceDirFull
            New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
        }
        $shot = Join-Path $shotDir "installer-client-$stamp.png"
        $bmp = New-Object Drawing.Bitmap($w, $h)
        $g = [Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
        $bmp.Save($shot, [Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
    }
    [void][W3]::SetWindowPos($hwnd, [IntPtr](-2), $rect.Left, $rect.Top, $w, $h, 0x0040)
}
Check 'client screenshot captured' ([bool]$shot -and (Test-Path $shot)) $shot
if ($shot) { Say "  screenshot: $shot" }
Get-Process QQDeepSeekBot -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# ---- idempotent re-install -------------------------------------------------
Say ''
Say '--- step 4: re-install must be idempotent (config.json untouched) ---'
$cfg = Join-Path $InstallDir 'config.json'
Add-Content -LiteralPath $cfg -Value '# user-edit-marker' -Encoding UTF8
$edited = (Get-FileHash $cfg -Algorithm SHA256).Hash
$p2 = Start-Process -FilePath $Setup -ArgumentList @('/S', "/D=$InstallDir", "/port=$Port", "/owner=100000001", '/nolaunch') -PassThru
$p2.WaitForExit()
Start-Sleep -Milliseconds 500
$after = (Get-FileHash $cfg -Algorithm SHA256).Hash
Say "reinstall exit = $($p2.ExitCode)"
Check 're-install exit code 0' ($p2.ExitCode -eq 0)
Check 'user edit survived re-install' ($after -eq $edited) "edited=$edited after=$after"
$reg2 = RegistryState
Check 're-install keeps the uninstall key' ($reg2 -ne $null -and $reg2.DisplayName -eq 'QQ DeepSeek Bot')

# ---- uninstall -------------------------------------------------------------
Say ''
Say '--- step 5: silent uninstall ---'
$unins = Join-Path $InstallDir 'Uninstall.exe'
$p3 = Start-Process -FilePath $unins -ArgumentList @('/uninstall', '/S') -PassThru
$p3.WaitForExit()
Say "uninstaller exit = $($p3.ExitCode)"
for ($i = 0; $i -lt 60; $i++) { if (-not (Test-Path $InstallDir)) { break }; Start-Sleep -Milliseconds 500 }
Check 'uninstaller exit code 0' ($p3.ExitCode -eq 0)
Check 'check 1: install dir removed' (-not (Test-Path $InstallDir)) $InstallDir
Check 'check 2: uninstall registry key removed' ((RegistryState) -eq $null)
Check 'check 3a: desktop shortcut removed' (-not (Test-Path $desktopLnk))
Check 'check 3b: start menu shortcut removed' (-not (Test-Path $startLnk))
$leftNode = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, 'OrdinalIgnoreCase') }
Check 'bridge process stopped by uninstaller' ($null -eq $leftNode)
Check 'demo port released' (-not (Test-Port $Port)) "port=$Port"

if (-not $KeepInstall -and (Test-Path $InstallDir)) {
    Say 'WARN install dir survived uninstall; leaving it for inspection'
}

$failed = @($script:results | Where-Object { -not $_.Ok })
Say ''
Say ("=== $($script:results.Count - $failed.Count)/$($script:results.Count) checks passed ===")
foreach ($f in $failed) { Say ("FAILED: " + $f.Name + ' ' + $f.Detail) }
Say "evidence: $evidence"
if ($failed.Count -gt 0) { exit 1 }
exit 0
