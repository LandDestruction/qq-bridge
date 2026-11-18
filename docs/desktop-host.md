# 桌面宿主（QQDeepSeekBot.exe）

把控制台 `/client` 页面装进一个独立 Windows 窗口。用户拍板的形态：**自写 WebView2 宿主**，
不是 `msedge --app` / 快捷方式套壳——那样没有单实例、没有托盘、没法控制错误页。

源码在 [`desktop/`](../desktop/)，构建脚本 `scripts/desktop/build-host.ps1`，
静态闸门 `scripts/test-desktop-host.mjs`。

## 1. 为什么是这条工具链

| 约束 | 结论 |
|---|---|
| 本机只有 .NET Core 3.1 SDK（无 net8 桌面运行时） | 不能用 `dotnet build` 的 WinForms/WPF 模板 |
| 目标机要「双击就能跑」 | .NET Framework 4.8 在 Win10/11 自带，`csc.exe` 直接出 exe，零安装依赖 |
| WebView2 官方 SDK 只提供 NuGet 包 | 首次构建下载 nupkg（约 9.4 MB）解压取三件：`Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`、`runtimes\win-x64\native\WebView2Loader.dll` |
| `csc.exe` 4.8.9221.0 的语言上限 | **C# 5**：不许字符串插值、`?.`、`nameof`、自动属性初始化器（静态测试有守卫） |

产物 4 个文件（exe + 两个托管 DLL + 原生 loader），全部由脚本复制到位，可重复执行。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\desktop\build-host.ps1   # 首次约 10 s（含下载），之后约 2 s
```

## 2. 功能对照（v1 清单）

| 要求 | 实现位置（Host.cs） |
|---|---|
| 单实例 + 二次启动激活已有窗口 | `Program.Main` 具名 Mutex + `Local\…activate` 事件；第二实例只发信号就退出 |
| 默认 1024×700，最小 **360×560**（逻辑像素，按 DPI 折算物理值） | `MinSizeForDpi(360,560)` + `WM_DPICHANGED` 重算（150% → 540×840，200% → 720×1120）；默认开窗尺寸仍是 1024×700 |
| 记住窗口大小/位置 | `%LOCALAPPDATA%\<Brand>\window.json`，读坏文件回退默认尺寸（`RestoreBoundsFromDisk` 全程 try/catch） |
| PerMonitorV2 DPI | `desktop/app.manifest`（.NET FX 没有 `SetHighDpiMode`，清单是唯一干净路径） |
| 浅色标题栏（粉白） | `DwmSetWindowAttribute`：`DWMWA_USE_IMMERSIVE_DARK_MODE=0`，Win11 22000+ 再染 `CAPTION_COLOR/TEXT_COLOR`；全部 try/catch |
| 令牌拼 URL | 读 `<root>\state\console-token`，拼 `http://127.0.0.1:<consolePort>/client?token=<tok>`；端口只读 `config.json` |
| 令牌不落日志/标题 | 无 `Console.*`、标题永不含 URL、异常文案过 `Scrub()` 擦 `token=` |
| 防白屏 | 先显示骨架页（粉白 + 「正在连接桥接…」），`NavigationCompleted.IsSuccess` 才隐藏；`DefaultBackgroundColor` 也设成粉白 |
| 服务没起来 | 壳自己拉起桥接（`--root` 目录里的 `node.exe src\bridge.js`，detached），最多等 30 s；仍不通才显示纯 WinForms 错误页（人话 + 端口/地址 + 错误码 + 「重试」+ 日志路径） |
| 托盘 | 关闭窗口 = 隐藏 + 气泡提示；菜单「打开 / 启动桥接 / 重启桥接 / 停止桥接 / 开机自启 / 关于 / 退出」；退出走 `ExitApplication()` 一条路径 |
| 桥接托管（P0-2） | `BridgeGuard`：spawn `node src\bridge.js`（cwd=root，优先 `<root>\node.exe`，退回 PATH），stdout/stderr 追加 `logs\bridge-stdout.log`，`cmd /c` 拉起后**不阻塞 UI**；只记录/只杀自己启动的 PID |
| 桥接状态 | 托盘菜单用 `/api/status?token=` 每 5 s 探测：运行中（显示 pid）/ 未运行 / 不响应；托盘 tooltip 同步 |
| 守护 | 自己启动的进程意外退出且用户没点「停止」→ 5 s 后重拉，**最多 3 次/小时**，写 `logs\bridge-guard.log`；超限停手，状态里说明原因 |
| 开机自启（可选） | HKCU `Software\Microsoft\Windows\CurrentVersion\Run`，值名取 `Brand.AppDataDirName`，命令 `QQDeepSeekBot.exe --root <目录>`；托盘菜单可随时开/关，**默认关**（安装器完成页可勾选；静默安装要 `/autostart`） |
| WebView2 运行时缺失 | `GetAvailableBrowserVersionString()` 判空 → 提示 + 微软官方 Evergreen 下载链接（`go.microsoft.com/fwlink/p/?LinkId=2124703`） |
| 托盘 | 关闭窗口 = 隐藏 + 气泡提示；菜单「打开 / 启动桥接 / 重启桥接 / 停止桥接 / 开机自启 / 关于 / 退出」；退出走 `ExitApplication()` 一条路径 |
| F12 默认关 | `AreDevToolsEnabled = opt.DevTools`（同时管右键菜单与浏览器快捷键） |
| 命令行 | `--root` / `--url` / `--devtools` / `--quit`；未知参数忽略 |

## 3. 真机验收记录（2026-10-28 02:5x）

环境：本机 Win11，WebView2 运行时 `157.0.4341.16`，`csc 4.8.9221.0`。
因为 `/client` 由 T16（w4）并行开发，**线上 3100 现在对 `/client` 返回 404**（实测：`GET /client` 带有效令牌 → `404 len=41`），
所以加载链用隔离桩（端口 3199，`/client?token=` 校验令牌后回 200）验证；宿主本身走的是同一套真实 WebView2 代码。

| 验收项 | 结果 |
|---|---|
| 构建产出 exe | `dist/desktop/QQDeepSeekBot.exe` = **22,528 字节**，旁边三个 DLL 齐全；SDK 首次下载 **9,818,548 字节** |
| 双击加载 /client | 窗口 1024×700、标题 `QQ DeepSeek Bot`、页面正文「桌面壳已成功加载 /client」、令牌透传校验通过（长度 26）——截图 `dist/desktop/shot-ok.png` |
| 服务停掉 → 错误页 | 停桩进程后重启：标题「桥接没有响应（ConnectionAborted）」+ 错误码 + `http://127.0.0.1:3199/client` + 重试/我已启动，**无白屏**——截图 `dist/desktop/shot-err.png` |
| 单实例 | 连续启动两次 → 始终 1 个 `QQDeepSeekBot.exe` 进程，第二次只把已有窗口前置 |
| 干净退出（托盘「退出」同一方法） | `--quit` 前：host 1 个、我方 user-data 的 `msedgewebview2.exe` 6 个；退出后：**host 0、msedgewebview2 0** |
| 窗口位置记忆 | 退出后 `window.json` = `{"x":768,"y":346,"w":1024,"h":700,"maximized":false}`，重启后按此还原 |
| 静态闸门 | `node scripts/test-desktop-host.mjs` 全绿；`node scripts/test-code-size.mjs` 5/5 |

未在真机做的：窗口关闭→托盘气泡的可视确认（托盘图标的 UIA 在本机溢出窗里不暴露，脚本点不到；
`--quit` 与托盘「退出」调用同一个 `ExitApplication()`，清理路径已由它证明）。

### 3.1 真实 `/client` 真机复验：**已完成**（2026-10-28 04:3x，桥接 pid 206016）

桥接在 04:30:44 重启后（`GET /client` 带令牌 → **200 / 39,409 字节 / `<title>QQ DeepSeek Bot</title>`），
宿主对**线上安装目录**跑了一遍完整链路，不再用桩：

| 检查 | 结果 |
|---|---|
| 可重复构建 | `build-host.ps1` 重跑 → `QQDeepSeekBot.exe` **22,528 字节**（与 T20 首建同尺寸） |
| 加载真实 /client | `--root <线上安装目录>` 启动，窗口标题 `QQ DeepSeek Bot`，**无白屏**，页面即 client.html 仪表盘 |
| 导航 9 项 | 仪表盘 / 会话 / 人设 / 记忆 / 表情 / 文件库 / AI 黑名单 / 日志 / 设置，全部在 |
| 六张卡片有数 | 运行状态（模式 reserved2、DSH 就绪、SnowLuma 已连接、运行时长 3 分钟、白名单 4 群/3 私聊）、服务健康 5/5（bridge PID **206016** · reserved2 · :3100）、自检（**暂无数据**，空态属正常）、用量与花费（¥112.91 / 1,324 轮 / 9 个会话 / 缓存命中 97.0%）、会话（8 个会话 · 未读 13）、AI 黑名单（已开启 reduce · 名单 0） |
| 尺寸与拉伸 | 初始 **1024×700**；请求 1400×900 → 1400×900（可拉伸）；96 DPI 下请求 300×500 被钳回 **360×560**（新下限，T23） |
| 浅色标题栏 | DWM 生效：白底深字（不是系统深色标题栏） |
| 断线错误页 | 另起 `--url http://127.0.0.1:39999/client`（没人监听的端口，**没有停线上 3100**）→「桥接没有响应（ConnectionAborted）」+ 错误码 + 探测地址 + 重试/我已启动，无白屏 |
| 单实例 | 连开两次 → 始终 **1** 个 `QQDeepSeekBot.exe`；第二次只把已有窗口前置 |
| 退出无残留 | `--quit`（与托盘「退出」同一方法）后 host **0**、该 profile 下 `msedgewebview2.exe` **6 → 0**；`window.json` = `{"x":768,"y":346,"w":1024,"h":700,"maximized":false}` |

截图（`dist/` 已 gitignore，只在构建机上，供复核）：
`dist/desktop/shot-live-dark.png`（1024×700，默认跟随系统 → 深色）、
`shot-live-tall.png`（1400×980 六卡全览）、`shot-live-light.png`（1024×700，切成浅色主题）、
`shot-live-mobile.png`（390×844 窄屏，汉堡菜单折叠态）、`shot-live-mobile-menu.png`（窄屏点开侧栏）、
`shot-live-error.png`（39999 断线错误页）、
`shot-real-360.png` + `shot-real-360-error.png`（T23/T27：真窗口 360×560 的正常态与断线错误页，**窄屏验收看这两张**，已于 T24 合入后重拍）。

**主题与窄屏补测（2026-10-28 04:4x）**：

- 默认主题保持「跟随系统」（本机深色系统 → 深色），点右上角「浅色」可切粉白，两侧都可用。
- 浅色下对比度用像素采样 + WCAG 公式实测：侧栏文字 **13.4:1**、卡片标签 **5.31:1**、卡片值 **13.4:1**、
  页面副标题 **4.87:1**（粉白底）、"更新于" 时间 **5.31:1** —— 全部 ≥ 4.5:1，**没有发灰看不清的地方**；
  卡片描边是装饰性细线，不参与文字对比度。（若以后要调，归 T15 的 token，不在这里改样式。）
- 窄屏（T23 后已能真窗口验证）：宿主 `MinimumSize` 由 1024×700 改为逻辑 **360×560**（DPI 折算），
  真窗口拖到 360 宽可用，见 §3.2。上面用 WebView2 远程调试口（CDP 390×844）拍的
  `shot-live-mobile*.png` 从 T23 起**降级为参考**，验收看真窗口截图。

**令牌口径（别误判成 bug）**：`/client` 自带鉴权，地址里不带 `token` 就是 **401**。宿主读
`<root>\state\console-token` 自己拼 `?token=`，所以双击启动永远能进；只有人肉在浏览器里输
`http://127.0.0.1:3100/client` 才会看到 401（这是设计，不是坏页）。
宿主代码不用改——它只认 `http://127.0.0.1:<consolePort>/client?token=`。

### 3.2 真窗口 360 宽（T23，2026-10-28 04:5x）

用户拍板「要可以到 360」，`MinimumSize` 从 1024×700 改成逻辑 **360×560**，并做了 DPI 折算。

| 检查 | 结果 |
|---|---|
| 96 DPI 下限 | 请求 300×500 → 钳回 **360×560**（旧版是钳在 1024×700） |
| 真 360 窗口 | 拖到 **360×560**：标题栏最小化/最大化/关闭三键都在，无横向滚动条，卡片单列、文字不裁切 —— `dist/desktop/shot-real-360.png` |
| 360 下错误页 | `--url http://127.0.0.1:39999/client`（**没停线上 3100**）→ 标题/详情/错误码/地址全部按宽度换行，重试与我已启动可点，无横向溢出 —— `dist/desktop/shot-real-360-error.png` |
| 150% 缩放 | 收到 `WM_DPICHANGED(144)` 后下限变 **540×840**（= 360×1.5 / 560×1.5），请求 400×600 被钳回 |
| 200% 缩放 | 收到 `WM_DPICHANGED(192)` 后下限变 **720×1120**，请求 500×700 被钳回 |
| 回到 100% | 收到 `WM_DPICHANGED(96)` 后回到 **360×560** |
| window.json 夹取 | 读回时先 `w = Math.Max(w, MinimumSize.Width)`、`h` 同理；旧版本存过 200px 宽只会被抬到 360，不会恢复成不可用的小窗 |

说明两点：
1. 本机只有 96 DPI 显示器，改系统缩放要动用户的显示设置，所以 150%/200% 是用 `WM_DPICHANGED`
   消息驱动**宿主自己的处理路径**（`WndProc` → `ApplyMinimumSize`）验证的，不是改系统 DPI；
   折算公式是 `360 × dpi / 96`，得到 540 / 720。
2. csc 产出的 exe 没有 `app.config`，.NET Framework 的 WinForms 默认不把 `WM_DPICHANGED`
   当缩放事件处理（`DeviceDpi` 也不更新），所以宿主在 `WndProc` 里直接认 `0x02E0` 并重算下限。

360 宽下 client.html 的页面布局（顶部状态行换行、主题按钮孤立在第二行等）归 w4 的 T24；
T24 已在 2026-10-28 04:55 合入 main（`edbad41`），宿主侧复核通过，见下。

**T24 合入后复核（2026-10-28 05:3x，`feat/w6` 已 merge main=`e98b980`）**：
宿主 exe 未变（Host.cs 与 T23 同一份，页面是桥接按请求读 `public/client.html`，不用重启桥接），
真窗口 **360×560** 重拍两张图，并用 CDP 读 DOM 量化：

| 检查 | 结果 |
|---|---|
| 顶栏不换行错乱 | 品牌 `y=15`、主题按钮 `y=10` —— 同一行；状态 chips 单独一行，不再把主题按钮挤到第二行 |
| 汉堡菜单 | `.qdb-hamburger`（aria-label「打开导航」）：点一下侧栏从 `x=-204` 滑到 `x=12`（宽 191），再点回到 `x=-204` —— 能开能合 |
| 无整页横向滚动 | `documentElement.scrollWidth=329 ≤ innerWidth=344`；强行 `scrollLeft=9999` 后仍为 **0**；page 内无 `scrollWidth>clientWidth` 的元素 |
| 卡片单列 | 360 下卡片纵向单列，文字不裁切 |
| 长群号 | `group:<群号>` / `private:<QQ号>` 等行宽 107–120px，`scrollWidth==clientWidth` —— **没有触发省略**（放得下就没裁切，`text-overflow: clip` 未丢字） |

截图已按 T24 后的页面重拍：`dist/desktop/shot-real-360.png`（正常态）、`shot-real-360-error.png`（断线页，宿主侧代码未变，图与 T23 同）。

### 3.3 桥接托管冒烟：桩进程（2026-10-28 20:5x）

线上 3100 有真桥接在跑，按纪律不重启，托管链路用桩 `src\bridge.js` 验证：

| 验收项 | 结果 |
|---|---|
| 构建 | `dist/desktop/QQDeepSeekBot.exe` = **191,488 字节**（比 v1 多约 170 KB：托管/守护/自启代码） |
| 静态闸门 | `node scripts/test-desktop-host.mjs` **72/72**；`node scripts/test-code-size.mjs` 9/9 |
| 壳拉起桥接 | 托盘「启动桥接」后 `logs\bridge-stdout.log` 出现 `stub-bridge start pid=214684`；`logs\bridge-guard.log` 记录 `start pid=186132 entry=src/bridge.js node=node.exe` |
| stdout 落盘 | 桩进程 console 输出完整追加进 `logs\bridge-stdout.log`，UI 不阻塞 |
| 关壳不杀桥接 | `--quit` 后 guard 日志写 `host exit (bridge left running, pid=186132)`，桩进程仍在 |
| 精确停止 | `taskkill /PID 186132 /T /F`（只对 guard 记录的 cmd PID）连同子进程 214684 一起结束 —— 「按记录的 PID 树停、不误杀别人的 node」 |
| 探活超时 | 桩不监听端口 → 30 s 后错误页给出 `logs\bridge-stdout.log` 路径（不白屏、不卡 UI） |

未做：用真 `src/bridge.js` 在 3100 上演练「停止/重启线上桥接」——会写线上 `state/`，按纪律未执行；
托管与真桥接的差异只在「子进程是谁」，spawn/日志/PID/退出语义已由桩覆盖。

## 4. 桥接托管与开机自启（P0-2）

**手动控制**（托盘菜单，状态每 5 s 刷新）：

- **启动桥接**：`node <root>\src\bridge.js`，cwd=`<root>`；优先用安装目录自带 `node.exe`，没有才退回 PATH。
  stdout/stderr 追加 `logs\bridge-stdout.log`；`cmd /c` 拉起，壳不等它退出（detached）。
  起来后轮询 `/api/status?token=`，就绪才把骨架页换成客户端；30 s 不通就显示错误页并打印日志路径。
- **停止桥接**：只杀**本壳记录过**的 PID（cmd 的进程树）；不是本壳起的桥接，按钮会拒绝并提示
  「这个桥接不是本壳启动的，请用原来的方式停止」——绝不按进程名扫杀。
- **重启桥接**：停 + 起；用户点「停止」后守护不会重拉（区分「用户停的」与「自己崩的」）。

**守护**：壳自己启动的进程意外退出 → 5 s 后重拉，**最多 3 次/小时**，每次写 `logs\bridge-guard.log`；
超限后停手，托盘状态显示「已停止重试（原因见 bridge-guard.log）」。关壳不会杀桥接；
壳再打开时若桥接已在跑（`/api/status` 通），只接管显示、不重启。

**开机自启**（可选，默认关）：写
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，值名 `QQDeepSeekBot`，
命令 `QQDeepSeekBot.exe --root <安装目录>`；托盘「开机自启」勾选即可开关。
安装器完成页也有同名勾选框（**默认不勾选**，勾了才写）；静默安装默认不写 Run 键，需显式 `/autostart`；卸载会清掉。

**边界**：壳只写 `logs/` 与自己的 PID 记录（内存），不写 `config.json`/`state/`；令牌只进内存与
WebView2 的 URL，不进标题、不进日志（`Scrub()` 擦 `token=`）。

## 4.5 更新检查与一键更新（6B）

壳自己检查新版本，**绝不自动安装**（必须用户在托盘点确认）。

**更新源**：`config.json` 的 `desktop.updateUrl`（缺省/空串 = 关闭检查）。返回 JSON：

```json
{ "version": "1.1.0", "url": "https://example.com/QQDeepSeekBot-Setup-1.1.0.exe",
  "notes": "可选说明", "sha256": "可选，给了就校验", "minVersion": "可选，当前只解析不强制" }
```

- 只认 `http(s)://`；`version`/`url` 必填；`notes` 会进日志；`sha256` 有就下载后校验。
- 当前版本：优先读安装目录 `scripts\installer\version.txt`（打包时写入），读不到才退回 `Brand.Version`。
- 检查时机：WebView 就绪后一次 + 之后每 **6 小时**一次（`UpdateCheckIntervalMs = 6*60*60*1000`）；
  探失败/版本号不认识只写 `logs\desktop-update.log` 后跳过，不弹窗（网络抖动不该天天打扰）。
- 版本比较是语义化 `x.y.z` 逐段数字比：`1.10.0 > 1.9.3`，`2.0.0-beta` 与 `2.0.0` 视为同一版，
  `v1.2.0`/`1.2` 宽容解析，`abc`/`1..2` 算「不认识」直接跳过。实现在 `desktop/UpdateVersion.cs`，
  纯逻辑、不碰 UI/网络/注册表，`test-desktop-host.mjs` 会把它编成控制台程序真跑用例。

**托盘交互**：

1. 发现新版：菜单出现「有新版本 vX.Y.Z（点击更新）」（空闲时显示「检查更新」）；
2. 点开二次确认，明确写「会关闭机器人并重装，`state/` 记忆库与 `config.json` 会保留」；
3. 点「是」才下载到 `%TEMP%`（文件名带版本），有 `sha256` 就校验；
4. 校验通过后 `Process.Start(Setup, "/S")` 静默安装，壳自己退出等安装器接管；安装器会先停掉本目录进程再覆盖，
   `state/` 与用户改过的 `config.json` 都由 P0-3 的合并式覆盖保留；
5. 任何一步失败（网络/校验/权限）都在托盘气泡写明原因，细节进 `logs\desktop-update.log`；
   **失败时不会启动安装器**。

**边界**：下载/安装只发生在用户确认之后；壳不新增对 `config.json`/`state/` 的写入（更新源是只读）；
安装包是现成 setup（`QQDeepSeekBot-Setup-<version>.exe`），静默参数 `/S` 与安装器一致。

## 5. 常见问题（用户视角）

**「没装 WebView2 运行时」**：这是壳在 `CreateAsync` 之前做的存在性检测，不是崩溃。
点界面里的链接装微软官方 Evergreen 运行时（约 150 MB，一次即可），装完点「重试」；不需要重装本程序。

**「桥接没有响应（ConnectionAborted）」**：客户端会自己尝试拉起桥接（最多 30 s）。仍失败时：
看 `logs\bridge-stdout.log`（桥接自己的输出）和 `logs\bridge-guard.log`（壳的托管记录），
再点「重试」。手动排查：`node src/bridge.js`（或安装目录里的 `start.bat`）。
页面同时打印探测到的地址与错误码，方便判断是「没启动」还是「端口不是 3100」。

**「读不到控制台令牌」**：`--root` 指向的目录不对，或桥接从没启动过。令牌文件在 `<root>\state\console-token`，
由桥接首次启动生成。

**「UnauthorizedAccessException … webview2」**：`%LOCALAPPDATA%` 不可写（受控账号/杀软/沙箱）。
设 `QQDESKTOP_DATA_DIR=<可写目录>` 即可。正常桌面用户不会遇到。

**双击没反应**：已经有一个实例在跑，它会把窗口前置。要退出用托盘「退出」或 `--quit`。

## 6. 已知限制 / 后续

1. `/client` 页面本身由 T16（w4）交付；页面合入并重启桥接后，宿主才是「开箱即用」的最终形态（届时把上面的桩截图换成真实页面即可，代码零改动）。
2. 壳只托管**自己启动的**桥接：如果桥接是开机自启/start.bat/别的方式起的，壳能显示状态、能连上，但「停止/重启」会拒绝（不按进程名扫杀）。要统一托管，就都让壳来启动。
3. 守护上限 3 次/小时是刻意的：反复崩溃多半是配置/环境问题，无限重拉只会刷日志。
4. 页面里的 `window.open` 一律被拦下（`NewWindowRequested` 取消）：壳不该长出第二个浏览器窗口；需要外链时后续可加「用默认浏览器打开」的白名单。
5. 未签名：SmartScreen 会提示「未知发布者」，属预期；签名不在本任务范围。
6. 图标是 `SystemIcons.Application` 占位，没有自带 .ico（用户还没定品牌图标）。
7. 更新检查不做自动安装、也不做强制升级：`minVersion` 目前只解析、未执行「低于它就阻止使用」的策略；
   用户不点托盘确认，就一直留在旧版。
