# autostart.ps1 — 开机自启 + 崩溃守护（Windows 计划任务），一个入口三种动作。
#
# 设计取舍（写清楚，免得后来人再纠结一次）：
#   1) 用「计划任务」而不是 HKCU\Software\Microsoft\Windows\CurrentVersion\Run：
#      注册表自启会被部分安全软件拦截、用户也难以在「启动应用」里看到和关闭，
#      卸载时还容易留残；计划任务可以用 Get-ScheduledTask 审计、随时禁用、卸载时干净删除。
#   2) 守护用「同一个任务每 N 分钟跑一次 scripts\ensure-bridge.ps1」而不是常驻 watchdog：
#      watchdog 自己会死，还要再守护它；计划任务由 Windows 调度器拉起，崩溃/重启都能自愈，
#      并且每次运行都在任务历史里留痕，出问题直接看 LastRunTime / LastTaskResult。
#      任务本体两件事合一：登录时触发一次（开机拉起）+ 每 N 分钟触发一次（崩了补起），
#      两种触发都调同一个幂等脚本，已经在跑就静默退出。
#   3) 全部动作支持 -DryRun：只打印将要执行的命令，不改系统。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action status
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action install -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action install
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action uninstall
#
# 注意：本文件含中文，必须 UTF-8 带 BOM，否则 Windows PowerShell 5.1 按 ANSI 解析会乱码。

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'uninstall', 'status')]
    [string]$Action,

    [switch]$DryRun,

    [string]$TaskName = 'QQDeepSeekBot-Bridge',

    [string]$Root = '',

    [ValidateRange(1, 60)]
    [int]$IntervalMinutes = 5
)

$ErrorActionPreference = 'Stop'

# 任务名会拼进 schtasks/Get-ScheduledTask，只允许保守字符集（防注入、也防奇怪名字）。
if ($TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9 _\-\.]{0,62}$') {
    Write-Host "ERROR 任务名不合法：$TaskName（只允许字母数字、空格、- _ .，1~63 字符）"
    exit 2
}

if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = [System.IO.Path]::GetFullPath($Root)

# 路径会进任务参数（双引号包裹），不允许出现引号/换行，否则参数会被拆开。
foreach ($p in @($Root)) {
    if ($p -match '["\r\n]') {
        Write-Host "ERROR 路径含非法字符（引号或换行）：$p"
        exit 2
    }
}

$entry = Join-Path $Root 'src\bridge.js'
$ensure = Join-Path $Root 'scripts\ensure-bridge.ps1'
$legacyRunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Write-Step([string]$text) {
    if ($DryRun) {
        Write-Host ('[DryRun] ' + $text)
    } else {
        Write-Host $text
    }
}

function Test-Prereqs {
    if (-not (Test-Path -LiteralPath $entry)) {
        Write-Host "ERROR 找不到桥接入口：$entry（-Root 指到仓库根/安装目录，而不是它的上级）"
        return $false
    }
    if (-not (Test-Path -LiteralPath $ensure)) {
        Write-Host "ERROR 找不到守护脚本：$ensure"
        return $false
    }
    return $true
}

function Get-BridgeProcesses {
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
            Where-Object {
                $_.CommandLine -and (
                    $_.CommandLine -like '*src\bridge.js*' -or
                    $_.CommandLine -like '*src/bridge.js*'
                )
            }
    } catch {
        @()
    }
}

function Get-TaskState {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    return @{ Task = $task; Info = $info }
}

function Show-Status {
    Write-Host '── 自启/守护状态 ──────────────────────────────────────────'
    Write-Host ("任务名        : " + $TaskName)
    Write-Host ("仓库根        : " + $Root)
    Write-Host ("桥接入口      : " + $entry + $(if (Test-Path -LiteralPath $entry) { '' } else { '（不存在！）' }))
    Write-Host ("守护脚本      : " + $ensure + $(if (Test-Path -LiteralPath $ensure) { '' } else { '（不存在！）' }))

    $state = Get-TaskState
    if ($state.Task) {
        Write-Host '计划任务      : 已创建'
        Write-Host ("  状态        : " + $state.Task.State)
        Write-Host ("  运行用户    : " + $state.Task.Principal.UserId + "（" + $state.Task.Principal.RunLevel + "）")
        foreach ($t in @($state.Task.Triggers)) {
            $desc = $t.CimClass.CimClassName
            if ($t.Repetition -and $t.Repetition.Interval) {
                $desc = $desc + "，每 " + $t.Repetition.Interval
            }
            Write-Host ("  触发器      : " + $desc)
        }
        if ($state.Info) {
            Write-Host ("  上次运行    : " + $state.Info.LastRunTime + "（结果码 " + $state.Info.LastTaskResult + "）")
            Write-Host ("  下次运行    : " + $state.Info.NextRunTime)
        }
    } else {
        Write-Host '计划任务      : 未创建（当前只有手动启动；用 -Action install 打开自启+守护）'
    }

    $procs = @(Get-BridgeProcesses)
    if ($procs.Count -gt 0) {
        Write-Host ("桥接进程      : 运行中（" + $procs.Count + " 个）")
        foreach ($p in $procs) {
            $start = 'unknown'
            try { $start = (Get-Process -Id $p.ProcessId -ErrorAction Stop).StartTime.ToString('o') } catch { }
            Write-Host ("  pid=" + $p.ProcessId + "  启动时间=" + $start)
            Write-Host ("  命令行=" + $p.CommandLine)
        }
    } else {
        Write-Host '桥接进程      : 未运行（计划任务会在下次触发时拉起，或先跑 scripts\ensure-bridge.ps1）'
    }

    $log = Join-Path $Root 'logs\ensure-bridge.log'
    if (Test-Path -LiteralPath $log) {
        $last = Get-Content -LiteralPath $log -Tail 1 -ErrorAction SilentlyContinue
        Write-Host ("守护最近日志  : " + $last)
    }
    Write-Host '──────────────────────────────────────────────────────────'
}

switch ($Action) {
    'install' {
        if (-not (Test-Prereqs)) { exit 3 }

        $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Root "{1}"' -f $ensure, $Root
        $user = "$env:USERDOMAIN\$env:USERNAME"

        Write-Step ("New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '" + $argLine + "' -WorkingDirectory '" + $Root + "'")
        Write-Step ('New-ScheduledTaskTrigger -AtLogOn -User "' + $user + '"')
        Write-Step ('New-ScheduledTaskTrigger -Once -At <now+1m> -RepetitionInterval <' + $IntervalMinutes + ' 分钟> -RepetitionDuration <9999 天>')
        Write-Step ('New-ScheduledTaskPrincipal -UserId "' + $user + '" -LogonType Interactive -RunLevel Limited')
        Write-Step 'New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit <10 分钟>'
        Write-Step ('Register-ScheduledTask -TaskName "' + $TaskName + '" -Action <action> -Trigger <logon,repeat> -Principal <principal> -Settings <settings> -Description "QQ DeepSeek Bot：登录拉起 + 每 ' + $IntervalMinutes + ' 分钟检查桥接" -Force')

        if ($DryRun) {
            Write-Step '（DryRun 结束：未创建任务、未改注册表、未启动桥接）'
            exit 0
        }

        # 先删同名旧任务，保证重复 install 是幂等的（不会叠出两个任务）。
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Host ("发现同名任务，先删除再重建：" + $TaskName)
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }

        $taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory $Root
        $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
            -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
            -RepetitionDuration (New-TimeSpan -Days 9999)
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
        if ($settings.PSObject.Properties['Hidden']) { $settings.Hidden = $true }

        Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger @($logonTrigger, $repeatTrigger) `
            -Principal $principal -Settings $settings `
            -Description ("QQ DeepSeek Bot：登录时拉起桥接，并每 " + $IntervalMinutes + " 分钟检查一次（崩了补起）") -Force | Out-Null

        Write-Host ("已创建计划任务：" + $TaskName)
        # 立刻跑一次守护（幂等：已经在跑就安静退出），装完状态就是「已就绪」。
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $ensure -Root $Root
        Show-Status
        Write-Host ''
        Write-Host '想关掉自启：运行 scripts\autostart.ps1 -Action uninstall'
        exit 0
    }

    'uninstall' {
        Write-Step ('Unregister-ScheduledTask -TaskName "' + $TaskName + '" -Confirm:$false')
        Write-Step ('Remove-ItemProperty -Path ''' + $legacyRunKey + ''' -Name ''' + $TaskName + '''（若存在旧版注册表自启项）')

        if ($DryRun) {
            Write-Step '（DryRun 结束：任务与注册表项都还在）'
            exit 0
        }

        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host ("已删除计划任务：" + $TaskName)
        } else {
            Write-Host ("计划任务本来就不存在：" + $TaskName)
        }

        # 历史版本可能写过 HKCU Run（本脚本不写），有就顺手清掉，卸载不留残。
        $legacy = Get-ItemProperty -Path $legacyRunKey -Name $TaskName -ErrorAction SilentlyContinue
        if ($legacy) {
            Remove-ItemProperty -Path $legacyRunKey -Name $TaskName
            Write-Host '已清理旧版注册表自启项（HKCU Run）'
        }

        Write-Host '自启与守护已关闭（正在运行的桥接进程不会被杀掉；需要的话手动结束 node src\bridge.js）'
        exit 0
    }

    'status' {
        Show-Status
        exit 0
    }
}
