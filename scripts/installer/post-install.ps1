# post-install.ps1 — 安装器最后一步（由 Installer.exe 用 PowerShell 调起）。
#
# L1 目标：装完就能用 ——
#   1) 确保 config.json 在（不存在则从 config.template.json 复制，已存在不覆盖）
#   2) 探测端口（默认 3100，可能被占用/已有实例）
#   3) 用包内自带的 node.exe 起桥接（目标机 PATH 里没有 node 也能跑）
#   4) 轮询 /api/status，确认桥接真的起来了
# 失败必须留下可读原因（安装器会把非 0 退出码与日志路径弹给用户，不白屏不黑框）：
#   exit 2 = 找不到包内 node.exe / 入口脚本
#   exit 3 = 桥接 30 秒内没起来（端口被占或启动崩溃，日志里有原始输出）
# DSH 不在本脚本范围内：桥接连不上 DSH 时客户端会显示「DSH 未连接」提示，
# 安装完成页也会说明「本项目需要 DSH」。
# 注意：本文件含中文，必须 UTF-8 带 BOM，否则 Windows PowerShell 5.1 按 ANSI 解析会报错。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # ops/ 的上一级 = 安装目录

$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'post-install.log'

function Write-Log([string]$msg) {
    $line = (Get-Date).ToString('o') + ' ' + $msg
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

function Test-Port([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $port)
        $client.Close()
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

Write-Log "post-install start, root=$root"

# ── 1. config.json ──────────────────────────────────────────────────────────
$cfgPath = Join-Path $root 'config.json'
$tplPath = Join-Path $root 'config.template.json'
$created = $false
if (-not (Test-Path $cfgPath)) {
    if (-not (Test-Path $tplPath)) { Write-Log 'ERROR config.json and config.template.json both missing'; exit 4 }
    Copy-Item -LiteralPath $tplPath -Destination $cfgPath
    $created = $true
    Write-Log 'config.json created from template'
} else {
    Write-Log 'config.json already exists (kept)'
}

# 模板里的占位符（"<QQ号 你自己的 QQ 数字号>" / ["<群号>"]）会让桥接启动失败：
#   [bridge] 启动失败: Error: ownerQQ 必须是 QQ 号（正整数）
# 兜底逻辑对「占位符」生效，不区分本次是否刚生成：安装器会先建 config.json，
# 所以 post-install 看到的永远是"已存在"。只替换不合法占位符，用户填好的数字原样保留。
if ($true) {
    try {
        $obj = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $changed = $false
        if ([string]$obj.ownerQQ -notmatch '^\d{5,12}$') {
            $obj.ownerQQ = 100000000
            $changed = $true
            Write-Log 'WARN ownerQQ was a placeholder; wrote 100000000 (edit config.json before real use)'
        }
        foreach ($field in @('private', 'groups')) {
            $arr = @($obj.allow.$field | Where-Object { [string]$_ -match '^\d{5,12}$' })
            if (@($obj.allow.$field).Count -ne $arr.Count) { $changed = $true }
            # PS 5.1 里 $obj.allow.$field = ... 对 PSCustomObject 无效（不会真写进去），
            # 必须走 PSObject.Properties。
            $obj.allow.PSObject.Properties[$field].Value = @($arr)
        }
        if ($changed) {
            # 不带 BOM：桥接用 JSON.parse 读，BOM 会让它报错
            [IO.File]::WriteAllText($cfgPath, ($obj | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
            Write-Log 'config placeholders normalized (ownerQQ / allow.private / allow.groups)'
        }
    } catch {
        Write-Log "WARN config normalize failed: $($_.Exception.Message)"
    }
}

$port = 3100
try {
    $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.consolePort) { $port = [int]$cfg.consolePort }
} catch {
    Write-Log "WARN config.json unreadable ($($_.Exception.Message)); using port 3100"
}
Write-Log "consolePort=$port"

# ── 2. node.exe + 入口 ──────────────────────────────────────────────────────
$node = Join-Path $root 'node.exe'
$entry = Join-Path $root 'src\bridge.js'
if (-not (Test-Path $node)) { Write-Log "ERROR bundled node.exe missing: $node"; exit 2 }
if (-not (Test-Path $entry)) { Write-Log "ERROR bridge entry missing: $entry"; exit 2 }
Write-Log ("node.exe " + (& $node -v))

# ── 3. 端口探测 ─────────────────────────────────────────────────────────────
if (Test-Port $port) {
    Write-Log "port $port already listening (another bridge or leftover process); skip start"
    exit 0
}

# ── 4. 起桥接（新进程，脱离安装器）──────────────────────────────────────────
$outLog = Join-Path $logDir 'bridge-stdout.log'
$errLog = Join-Path $logDir 'bridge-stderr.log'
Write-Log "starting bridge: $node src\bridge.js (cwd=$root)"
$proc = Start-Process -FilePath $node -ArgumentList @('src\bridge.js') -WorkingDirectory $root `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
Write-Log "bridge pid=$($proc.Id)"

$up = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) {
        Write-Log "ERROR bridge exited early, code=$($proc.ExitCode)"
        break
    }
    if (Test-Port $port) { $up = $true; break }
}

if (-not $up) {
    Write-Log "ERROR bridge not listening on $port within 30s"
    if (Test-Path $errLog) {
        $tail = Get-Content -LiteralPath $errLog -Tail 20 -ErrorAction SilentlyContinue
        foreach ($l in $tail) { Write-Log ("  stderr: " + $l) }
    }
    exit 3
}

# /api/status 能回 401 也算起来（没带 token），说明 HTTP 栈活了
$status = 'n/a'
try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$port/api/status") -TimeoutSec 5 -UseBasicParsing
    $status = [string]$r.StatusCode
} catch {
    if ($_.Exception.Response) { $status = [string][int]$_.Exception.Response.StatusCode } else { $status = "err:" + $_.Exception.Message }
}
Write-Log "bridge is up on $port, /api/status -> $status"

$token = Join-Path $root 'state\console-token'
if (Test-Path $token) { Write-Log 'state/console-token created' } else { Write-Log 'WARN state/console-token missing' }

# ── 5. 开机自启 + 崩溃守护（计划任务）──────────────────────────────────────
# 失败只 warn：装不上任务也必须能正常用（用户还能手动启动桥接），不能因此让安装失败。
# 调用 scripts\autostart.ps1 -Action install（登录拉起 + 每 5 分钟检查一次，见 docs/guides/AUTOSTART.md）。
$autostart = Join-Path $root 'scripts\autostart.ps1'
if (-not (Test-Path -LiteralPath $autostart)) {
    # 仓库内直接跑 post-install 时的位置：<repo>\scripts\installer\..\autostart.ps1
    $alt = Join-Path $PSScriptRoot '..\autostart.ps1'
    if (Test-Path -LiteralPath $alt) { $autostart = $alt }
}
if (Test-Path -LiteralPath $autostart) {
    try {
        $autoOut = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $autostart -Action install 2>&1
        foreach ($line in @($autoOut)) { Write-Log ('  autostart: ' + [string]$line) }
        Write-Log 'autostart installed (task QQDeepSeekBot-Bridge)'
    } catch {
        Write-Log ('WARN autostart install failed: ' + $_.Exception.Message)
    }
} else {
    Write-Log 'WARN autostart.ps1 not found, skip autostart setup'
}

Write-Log 'post-install done'
exit 0
