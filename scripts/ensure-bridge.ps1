# ensure-bridge.ps1 — 桥接「崩溃守护 / 开机拉起」的幂等入口（计划任务调用它）。
#
# 为什么用「计划任务每 5 分钟跑一次这个脚本」而不是「常驻 watchdog 进程」：
#   1) 常驻 watchdog 自己也会死，还得再守护它；计划任务由 Windows 调度器负责，
#      bridge 崩溃、机器睡眠唤醒、甚至任务计划服务重启后都能自愈。
#   2) 每次运行都会在任务历史里留一条 LastRunTime/LastTaskResult，出问题可直接审计。
#   3) 脚本幂等：已经在跑就立刻安静退出，不占资源，也不会重复起第二个实例。
#
# 安全说明：不写 HKCU\...\Run（注册表自启容易被安全软件拦截，卸载时也容易留残）。
# 所有路径都加引号；-Root 由调用方传入，只做「必须存在且含 src\bridge.js」的校验。
# 注意：本文件含中文，必须 UTF-8 带 BOM，否则 Windows PowerShell 5.1 按 ANSI 解析会乱码。

param(
    [string]$Root = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = [System.IO.Path]::GetFullPath($Root)
$entry = Join-Path $Root 'src\bridge.js'
$logDir = Join-Path $Root 'logs'
$log = Join-Path $logDir 'ensure-bridge.log'

function Write-Log([string]$message) {
    $line = (Get-Date).ToString('o') + ' ' + $message
    # 清一次超大日志，避免守护自己把磁盘写满（保留最近一次）。
    if (Test-Path -LiteralPath $log) {
        $size = (Get-Item -LiteralPath $log).Length
        if ($size -gt 2MB) {
            Move-Item -LiteralPath $log -Destination ($log + '.1') -Force
        }
    }
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

function Get-BridgeProcesses {
    # 只认 node.exe 且命令行里带 src\bridge.js（兼容 forward slash：两种都匹配）。
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
            Where-Object {
                $_.CommandLine -and (
                    $_.CommandLine -like '*src\bridge.js*' -or
                    $_.CommandLine -like '*src/bridge.js*'
                )
            }
    } catch {
        Write-Log ('WARN 查询进程失败：' + $_.Exception.Message)
        @()
    }
}

function Resolve-NodeExe {
    # 优先用安装包自带的 node.exe（目标机可能没有 Node），否则用 PATH 里的 node。
    $bundled = Join-Path $Root 'node.exe'
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    return ''
}

function Start-Bridge {
    $node = Resolve-NodeExe
    if (-not $node) {
        Write-Log 'ERROR 找不到 node.exe（既没有 <root>\node.exe，PATH 里也没有 node）'
        return $false
    }
    if (-not (Test-Path -LiteralPath $entry)) {
        Write-Log "ERROR 入口不存在：$entry"
        return $false
    }
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    }
    $outLog = Join-Path $logDir 'bridge-stdout.log'
    $errLog = Join-Path $logDir 'bridge-stderr.log'
    # 轮转上一个 stdout/stderr：Start-Process 的重定向会截断文件，不轮转就丢历史。
    foreach ($f in @($outLog, $errLog)) {
        if (Test-Path -LiteralPath $f) {
            Move-Item -LiteralPath $f -Destination ($f + '.1') -Force
        }
    }
    if ($DryRun) {
        Write-Log ('[DryRun] Start-Process -FilePath "' + $node + '" -ArgumentList "src\bridge.js" -WorkingDirectory "' + $Root + '" -WindowStyle Hidden')
        return $true
    }
    Write-Log ('启动桥接：' + $node + ' src\bridge.js (cwd=' + $Root + ')')
    $proc = Start-Process -FilePath $node -ArgumentList @('src\bridge.js') -WorkingDirectory $Root `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
    Write-Log ('桥接已启动 pid=' + $proc.Id)
    Start-Sleep -Seconds 2
    if ($proc.HasExited) {
        $tail = ''
        if (Test-Path -LiteralPath $errLog) {
            $tail = (Get-Content -LiteralPath $errLog -Tail 5 -ErrorAction SilentlyContinue) -join ' | '
        }
        Write-Log ('ERROR 桥接启动后 2 秒内退出，code=' + $proc.ExitCode + ' stderr=' + $tail)
        return $false
    }
    return $true
}

# 串行化：任务计划设置里已经是 IgnoreNew，这里再加一把本地互斥锁，
# 防止「手动双击 + 定时触发」同时进来起两个实例（EADDRINUSE）。
$mutex = $null
$acquired = $false
try {
    $mutex = New-Object System.Threading.Mutex($false, 'Local\QQDeepSeekBot-EnsureBridge')
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) {
        Write-Log '另一个 ensure-bridge 正在运行，本轮跳过'
        exit 0
    }

    $running = @(Get-BridgeProcesses)
    if ($running.Count -gt 0) {
        $pids = ($running | ForEach-Object { $_.ProcessId }) -join ','
        Write-Log ('桥接已在运行 pid=' + $pids + '，本轮无事可做')
        exit 0
    }

    Write-Log '桥接不在运行，准备拉起'
    $ok = Start-Bridge
    if (-not $ok) { exit 1 }
    exit 0
} catch {
    Write-Log ('ERROR 意外失败：' + $_.Exception.Message)
    exit 1
} finally {
    if ($acquired) { try { $mutex.ReleaseMutex() } catch { } }
    if ($mutex) { try { $mutex.Dispose() } catch { } }
}
