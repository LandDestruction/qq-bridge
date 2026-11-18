# 开机自启与崩溃守护（Windows）

装好之后，桥接应该「开机就在、崩了自己回来」，不需要你每次手动点。这一页讲清楚它做了什么、怎么关、出问题看哪里。

## 它做了什么

安装器最后一步会创建**一个 Windows 计划任务**：`QQDeepSeekBot-Bridge`。

- **登录时拉起**：你登录 Windows 后触发一次，桥接不在跑就启动它。
- **每 5 分钟检查一次**：任务同时带一个 5 分钟的重复触发器，调用 `scripts/ensure-bridge.ps1`；脚本先查 `node src\bridge.js` 是否在跑，在跑就静默退出，不在就重新拉起。
- **不重复起实例**：任务设置里是 `MultipleInstances = IgnoreNew`，脚本里还有本地互斥锁；已经在跑时不会起第二个（否则会 `EADDRINUSE` 抢 3100 端口）。

为什么是「计划任务每 5 分钟检查」而不是常驻 watchdog：常驻进程自己也会死、还得再守护它；计划任务由 Windows 调度器负责，崩溃、睡眠唤醒、重启都能自愈，而且每次运行都在任务历史里留痕，出问题能直接看 `LastRunTime / LastTaskResult`。

为什么**不写注册表自启**（`HKCU\...\Run`）：容易被安全软件拦、用户难以在「启动应用」里看到和关掉，卸载也容易留残。计划任务可以用 `Get-ScheduledTask` 审计、随时禁用、卸载时干净删除。

## 怎么查状态

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action status
```

会打印：任务是否存在、任务状态与运行用户（Limited 权限）、触发器（登录 + 每 5 分钟）、上次运行时间与结果码、下次运行时间、桥接进程是否在跑（pid / 启动时间 / 命令行）、守护日志最后一行。

任务历史也可以直接看：

```powershell
Get-ScheduledTaskInfo -TaskName 'QQDeepSeekBot-Bridge'
Get-Content logs\ensure-bridge.log -Tail 20
```

## 怎么关掉自启

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action uninstall
```

这会删除计划任务（并顺手清理旧版本可能写过的注册表自启项），**不会**杀掉正在运行的桥接——想停桥接请另外结束对应的 `node.exe`。

也可以在系统的「任务计划程序」库里找到 `QQDeepSeekBot-Bridge`，右键禁用/删除；效果相同。

## 先看看它会做什么（不改系统）

所有动作都支持 `-DryRun`，只打印将要执行的命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action install -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Action uninstall -DryRun
```

## 重新打开

再跑一次 `-Action install` 即可（幂等：会先删同名旧任务再重建，不会叠出两个）。

## 出问题看哪里

| 现象 | 先看 | 常见原因 |
| --- | --- | --- |
| 登录后没起来 | `logs\ensure-bridge.log`（守护日志）、`logs\bridge-stderr.log` | 没有 `node.exe`（安装包自带 `<root>\node.exe`，没有就要求 PATH 里有 node）；`src\bridge.js` 被移动 |
| 起来又立刻退 | `logs\bridge-stderr.log`、`state\bridge.log` | `config.json` 没填好（ownerQQ 等）；端口被占 |
| 任务状态异常 | `Get-ScheduledTaskInfo -TaskName 'QQDeepSeekBot-Bridge'` 的 `LastTaskResult` | `0x41301`=正在运行；其它值多为脚本报错，日志里有原因 |
| 5 分钟内没补起来 | `status` 里的「下次运行」 | 任务被禁用 / 电源策略跳过；`-Action install` 重装一次 |

## 安全说明

- 任务以**当前用户**、**Limited（非管理员）**权限运行，只拉起桥接，不提升权限。
- 脚本里所有路径都加引号；任务名与根目录做了白名单校验，不把未校验输入拼进命令。
- 这两个脚本（`scripts\autostart.ps1`、`scripts\ensure-bridge.ps1`）是 UTF-8 带 BOM，兼容 Windows PowerShell 5.1 的中文解析。
