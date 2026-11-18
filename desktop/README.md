# desktop/ —— WebView2 桌面外壳

把桥接控制台的 `/client` 页面装进一个独立 exe：`QQDeepSeekBot.exe`。
形态是**自写 WebView2 宿主**（不是 `msedge --app`），单实例、托盘常驻、浅色标题栏、断线给可读错误页。

> 非腾讯 / 非 DeepSeek 官方产品（Not affiliated with Tencent or DeepSeek）

## 构建

```powershell
powershell -ExecutionPolicy Bypass -File scripts\desktop\build-host.ps1
```

首次会下载 WebView2 SDK（约 9.4 MB）到 `desktop/vendor/`（已 gitignore），之后复用缓存。
产物在 `dist/desktop/`：

```text
QQDeepSeekBot.exe                        (~22 KB)
Microsoft.Web.WebView2.Core.dll
Microsoft.Web.WebView2.WinForms.dll
WebView2Loader.dll
```

工具链固定：`.NET Framework 4.8` 的 `csc.exe`（`4.8.9221.0`，C# 5）。
不用 `dotnet`/MSBuild——本机只有 .NET Core 3.1 SDK，没有 net8 桌面运行时。

## 运行

```powershell
dist\desktop\QQDeepSeekBot.exe --root "<本机路径>\qq-bot-worktrees\w6"
```

| 参数 | 作用 |
|---|---|
| `--root <dir>` | 安装/仓库根目录（读 `config.json` 的 `consolePort` 与 `state\console-token`）。不传时从 exe 所在目录往上找 `src\bridge.js` |
| `--url <url>` | 调试：直接用给定地址，跳过 root/令牌拼装 |
| `--devtools` | 打开 F12 与右键菜单（默认关） |
| `--quit` | 通知已运行的实例退出（安装器/更新替换 exe 前用；和托盘「退出」同一条路径） |

其他参数忽略不报错（快捷方式里带历史开关也不会崩）。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 窗口显示「没装 WebView2 运行时」 | 本机没有 Edge WebView2 运行时。点界面里的链接装一次（微软官方 Evergreen 安装包），装完点「重试」，不用重装本程序 |
| 窗口显示「桥接没有响应（ConnectionAborted）」 | 桥接没起来或端口不对。先启动桥接，再点「重试」。地址和错误码都印在页面上 |
| 窗口显示「读不到控制台令牌」 | `--root` 指错了，或桥接从没启动过（令牌由桥接首次启动时生成到 `state\console-token`） |
| 启动就提示 `UnauthorizedAccessException ... webview2` | `%LOCALAPPDATA%` 不可写（受控账号/杀软/受沙箱限制的环境）。设环境变量 `QQDESKTOP_DATA_DIR` 指到可写目录即可；正常桌面用户不会遇到 |
| 双击没反应 | 已经有一个实例在跑了（单实例）：它会自己前置窗口。要关掉用托盘「退出」或 `--quit` |

## 边界

- 只读 `config.json` 与 `state\console-token`；**不写** config / state / logs / audio。
- **不负责**启动或重启桥接：服务没起来就显示错误页，绝不在这里 spawn `node src/bridge.js`。
- 控制台令牌只在内存里拼 URL，不进标题、日志、崩溃文案（显示/落盘前统一 `Scrub`）。
- 不签名、不打包、不提交二进制：`desktop/vendor/` 与 `dist/` 都在 `.gitignore`。
