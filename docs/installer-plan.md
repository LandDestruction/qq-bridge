# 安装包方案（T17）：四条路线实测对比 + 推荐

> 目标：把「下载 zip → 手动装 Node → 跑 setup-dsh → 改 config → 开浏览器」变成
> 「双击安装包 → 装好 → 桌面快捷方式 → 启动就是客户端窗口」。
> 客户端宿主本身是 w6 的 T20（`dist\desktop\QQDeepSeekBot.exe`），本文只谈**安装器**。
>
> 本文所有数字都是本机实跑得到的（2026-10-28，Windows PowerShell 5.1 /
> csc 4.8.9221.0 / WebView2 157.0.4341.16），不是查资料估的。

## 0. 本机起点（实测）

| 事实 | 结果 |
|---|---|
| Inno Setup `iscc` | NOT FOUND |
| NSIS `makensis` | NOT FOUND |
| 7-Zip `7z` | NOT FOUND |
| `winget` | 存在（`<本机路径>\WindowsApps\winget.exe`） |
| `choco` / `scoop` | NOT FOUND |
| IExpress | `C:\Windows\System32\iexpress.exe`（系统自带） |
| C# 编译器 | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，版本 4.8.9221.0 |
| .NET SDK | 只有 3.1（不能 `dotnet publish` 出单个 self-contained exe 的现代方案） |
| WebView2 运行时 | 157.0.4341.16（`HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-...}` 的 `pv`） |
| Edge | 157.0.4341.16 |
| Node | v24.16.0 |

结论：**不联网也能出包的工具只有 IExpress + csc**。这决定了推荐路线。

## 1. 四条路线实测

### 路线 A：IExpress 自解压 exe + install.cmd

- 构建：脚本生成 `.sed`，`iexpress /N /Q xxx.sed` → `routeA-setup.exe` **188,416 B，约 2 秒**。
- 运行：从 `%TEMP%` 副本 `routeA-setup.exe /Q` → 自解压目录里执行 `install.cmd`，
  载荷里的 `marker.txt` 被正确复制出来（`copied=True done=True`），跑完 SFX 自己清理临时目录。
- 静默安装必须在 SED 里填 `UserQuietInstCmd` / `AdminQuietInstCmd`，否则 `/Q` 只解压不执行。
- 致命短板：**它只是个自解压壳**。快捷方式、HKCU 卸载项、config 初始化、卸载时的进程停止，
  全部要自己写进 `install.cmd`/PowerShell —— 等于把路线 B 的活重写一遍，却只能用 cmd 写。
  也没有卸载入口、没有增量升级。
- 结论：**备选**（依赖最少，但功能上限最低）。

### 路线 B：csc 编译 C# 安装器（内嵌 zip 载荷）—— 推荐

- 构建：`build-installer.ps1` 编译 stub 客户端 + 安装器，`csc` 两次，各约 1 秒；
  载荷 zip 用 .NET 自带 `ZipFile` 生成（不依赖 7z）。
- 产物：`dist\installer\QQDeepSeekBot-Setup-0.1.0.exe`，**44,704,256 B ≈ 42.63 MiB**（载荷 4,902 文件 = 完整产品：src + node_modules + node.exe + public + dsh + plugins + docs + 客户端 exe）。
- 安装（实测 exit 0）：解压 4,902 文件到 `%TEMP%\qdbt-demo-*`、`config.json` 由模板生成、
  `.installed.json` 幂等标记、`Uninstall.exe` 落地、桌面 + 开始菜单两个 `.lnk`
  （TargetPath = 安装目录 `\QQDeepSeekBot.exe`）、HKCU 卸载项 9 个值、
  `ops/post-install.ps1` 由 PowerShell 跑完（exit 0）。
- 幂等：改过 `config.json` 后再装一遍，sha256 不变（**不覆盖用户配置**）。
- 卸载（实测 exit 0）：停自己起的进程 → 删快捷方式 → 删注册表 → 延迟 `rmdir` 整目录，
  三查全绿。
- 弱点：C# WinForms 手写 UI（欢迎页/完成页/卸载确认页），代码量约 600 行；无签名。

### 路线 C：Edge `--app` 当客户端（用户已否，兜底）

- 实测：`msedge --app=file:///...` 起窗口，标题 `QQ DeepSeek Bot`，
  从进程启动到窗口可交互约 **6.5 秒**，共 **16 个 msedge 进程**（Edge 多进程模型）。
- 差异：根本不是安装器 —— 没有安装目录、没有快捷方式控制、没有卸载项、
  升级跟着 Edge 走（用户关掉 Edge 更新就停在旧内核）、无法保证离线一致。
- 相比 B：省掉 WebView2 宿主的开发量，但把「产品」变成「书签」，用户已否。
- 结论：只作为兜底，不进交付。

### 路线 D：第三方（Electron / Inno Setup / NSIS / 7z）

- `winget` 能查到元数据：Inno Setup **6.7.3**（安装器 URL + SHA256 + 许可证 URL）、
  NSIS **3.13**（zlib/libpng + bzip2 + CPLv1）。
- 但**本轮实测下载失败**：`files.jrsoftware.org/is/6/innosetup-6.7.3.exe` → HTTP 404；
  GitHub release → `curl: (56) Recv failure: Connection was reset`。
  也就是说，在这个构建环境里 D 路线**没法产出可用包**（不是"没试"，是试了不通）。
- 即便网络可用：Inno 安装器约 6~7 MB（未实测，下载没成功）、NSIS 约 3 MB（同上），
  还要评估许可证随包分发、签名与 SmartScreen 差异。
- 结论：**不采用**（联网依赖 + 工具链许可 + 无法离线复现）；若将来要 LTS 级安装器，
  再评估 Inno（它的卸载/升级/多语言是现成的）。

## 2. 对比表

| 维度 | A IExpress+cmd | B csc 安装器（选） | C Edge --app | D 第三方 |
|---|---|---|---|---|
| 安装包体积 | 188 KB（空壳）+ 载荷 | 42.63 MB（完整载荷 4,902 文件 / 装完约 123 MB，含 node.exe 88 MB） | 0 | 6~7 MB 工具 + 载荷 |
| 离线可装 | ✅ | ✅ | ⚠️ 要本机有 Edge | ❌ 构建要联网 |
| 管理员权限 | 不需要（HKCU 安装） | 不需要（HKCU + `%LOCALAPPDATA%`） | 不需要 | Inno/NSIS 默认也要管理员，可配 per-user |
| 卸载是否干净 | ❌ 要自己写 | ✅ 进程/快捷方式/注册表/目录四件套，实测三查全绿 | ❌ 无卸载 | ✅ 成熟 |
| 升级 | ❌ 无 | ✅ 同版本重装幂等；高版本覆盖安装、保留 config.json | N/A | ✅ |
| 启动/停止进程 | 只能 `start` | ✅ 安装器最后一步调 PowerShell；卸载按安装目录 kill | 由 Edge 管 | ✅ 服务/进程管理现成 |
| 失败模式与回滚 | 黑盒，命令失败无回执 | ✅ 退出码 0/3/4/5 + `%TEMP%\QQDeepSeekBot-install.log` 每步留痕；重跑即修复 | 无 | ✅ |
| 无签名 SmartScreen | 会拦（未知发布者） | 会拦（未知发布者） | 不涉及 | 工具本身已签名，产出的包仍然会拦 |
| 开发成本 | 低（但卸载/升级要重写） | 中（~600 行 C#，一次写完） | 极低 | 低（网络可用时） |

## 3. 推荐与第一阶段范围

**推荐 B（csc 自编译安装器）**，A 作为兜底（例如将来要在无 .NET 的机器上出包）。

第一阶段（本任务已完成的一半）：
1. 安装 → 快捷方式 → 首次启动准备 config → HKCU 卸载项 → 卸载（停进程/删快捷方式/删注册表/删目录）；
2. WebView2 缺失检测（明确提示 + 官方下载链接，exit 3，不静默）；
3. 幂等（二次安装不覆盖 `config.json`）；
4. 安装目录可参数覆盖（`/D=<dir>`，demo 用它装到 `%TEMP%`，绝不碰真实安装目录）；
5. 载荷清单复用 `scripts/pack-exclude.json` 的排除口径；
6. 静态断言 `scripts/test-installer.mjs`（26 条）。

第二阶段（T20 宿主已落地，剩全量载荷）：
1. 真宿主（`scripts\desktop\build-host.ps1` → `dist\desktop\QQDeepSeekBot.exe` + 3 个 WebView2 DLL）
   已接进载荷；安装器写快捷方式时带 `--root "<安装目录>"`，宿主据此找 `src/bridge.js`；
2. 载荷从 demo 清单换成 `scripts/delivery-manifest.json` 的 include 列表（同一套剪枝规则），
   产出带表情库的完整包（预计 ≈ 161 MB）；
3. 升级路径：读 `.installed.json` / 注册表 `DisplayVersion`，高版本覆盖时保留 `config.json` 与 `state/`；
4. 安装完成页的「立即启动」真正拉起宿主，并验证控制台端口与 DSH 连接；
5. 代码签名（若有证书）；没有证书就把 SmartScreen 提示写进交付文档。

## 3.5 L1 落地：安装器从 demo 变成真产品（T28）

`payload.json` 的 `stub` 已置 false，载荷 = **完整产品**（4,902 文件 / 123.7 MB 解压）：

| 载荷 | 为什么 |
|---|---|
| `src/` + `node_modules/` | 桥接本体与依赖；目标机**不需要** `npm install` |
| `node.exe`（88 MB，v24.16.0） | 目标机可能没有 Node 22+；只带自包含单文件，不带整个 node 安装目录 |
| `public/`（含 360/420 窄屏规则） | 客户端页 |
| `dsh/` + `plugins/` | DSH preset 权威源与 QQ 插件 bundle |
| `docs/` `scripts/` `tools/` `assets/` `ops/` | 文档、维护脚本、启动/停止三件套 |
| `config.template.json` / `package*.json` / LICENSE / NOTICE | 配置模板与元数据（**真 config.json 不入包**） |

安装器新增两个参数（都只影响新生成的配置）：
- `/port=<n>`：改写 `consolePort`，给测试/与线上桥接共存用；
- `/owner=<QQ>`：改写 `ownerQQ`（不传则 post-install 写 `100000000` 并记警告）。

`post-install.ps1` 现在做四件事：查/生成 `config.json` → 清理模板占位符
（`ownerQQ`、`allow.private/groups` 里的 `<QQ号>`，否则桥接起不来）→ 用包内
`node.exe` 起 `src\bridge.js`（脱离安装器）→ 轮询端口直到 `/api/status` 有响应。
失败时安装器弹「需要手动处理」并给 `logs\post-install.log` 路径，不白屏不黑框。

**前置依赖**：本项目是「QQ ↔ DSH 桥接」。没有 DSH 时窗口能开、客户端会显示
「DSH 未连接」，安装完成页已写明这一点；QQ 收发还需要 SnowLuma/OneBot 网关 + 自己的
群号/QQ 填进 `config.json`（安装器不猜这些值）。

实测（46/46）：PATH 里去掉 node → 静默装到 `%TEMP%` 新目录 → post-install 用包内
`node.exe` 起桥接（PID 属于安装目录里的 node.exe）→ `/api/status` 带 token 返回数据
（DSH 就绪、SnowLuma 未连接、bridge PID）→ 客户端窗口加载 `/client` 出六卡（截图
`dist\desktop\installer-client-*.png`）→ 二次安装保留用户改过的 config → 卸载后
目录/注册表/快捷方式三查全无残留、桥接进程被杀。

## 3.6 P0-3：升级不丢 `state/`，开机自启可选（2026-10-28）

**升级语义 = 在同一个安装目录上再跑一次 setup，只做合并式覆盖**：

- `ExtractPayload` 只 `Directory.CreateDirectory` + `ExtractToFile`，**没有删除分支**；
  `config.json` 已存在时跳过（日志 `keep existing config.json`），用户改过的端口/QQ 不会被重置；
- `state/` **永不进包**（`payload.json` 的 `forbidden` 显式列了 `state/`），安装器也从不创建/写 `state/`——
  记忆库、黑话、表情库、群名/好友名只归桥接自己管；
- 安装/升级路径没有任何删除；整个安装目录只在**卸载**时由延迟 `rmdir` 删除（本质是删自己）；
- 升级前会先停掉「从安装目录启动的进程」（否则 node.exe 被锁），停的是本目录内的进程，不误杀别的 node。

**开机自启（可选，不强制）**：

| 场景 | 默认 | 覆盖方式 |
|---|---|---|
| 交互安装 | 完成页勾选框，**默认不勾选** | 用户勾上才写（不强制开机自启） |
| 静默安装 `/S` | **不写** Run 键 | 传 `/autostart` 才写 |
| 卸载 | 清掉 Run 值 | — |

写的位置是 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，值名 `QQDeepSeekBot`，
内容 `"<安装目录>\QQDeepSeekBot.exe" --root "<安装目录>"`（与桌面壳的托盘开关同一约定）。
卸载步骤里加了 `RemoveAutostart()`（失败计入卸载问题数）。

**断言**：`node scripts/test-installer.mjs` **100/100**（新增第 9/10 段：解压无删除分支、
`state/` 不在载荷且被禁止、`config.json` 保留分支、真文件系统演练「v1 装 → 改 config + 造 state/ → v2 覆盖装」
后 state 逐字节保留 / 程序文件已更新；以及 `/autostart`、Run 键文案、卸载清理）。
`demo-install.ps1` 未扩展二次安装段：跑一次 demo 要完整出包（4,900 文件、约 42 MB）+ 静默装卸，
本轮只做静态 + 文件系统级演练；真机 demo 的 46 项仍是改动前的口径。

## 3.7 12A 出安装包：只发 Setup.exe（2026-10-28）

**用户拍板：只发一个 Setup.exe，不做绿色版/免安装包。** 构建命令（仓库根目录）：

```powershell
powershell -ExecutionPolicy Bypass -File build-installer.ps1
```

版本号来自 `scripts/installer/version.txt`（当前 `0.1.0`），不用传 `-Version`；载荷清单是
`scripts/installer/payload.json`，排除清单复用 `scripts/pack-exclude.json`（没有第二份排除表）。
`build-installer.ps1` 用 Windows 自带 csc 离线编译，不联网、不依赖 Inno/NSIS/7z。

**本次产物**（2026-10-28 21:21）：

| 项 | 值 |
|---|---|
| 安装包 | `dist\installer\QQDeepSeekBot-Setup-0.1.0.exe` |
| 大小 | 45,050,880 B（42.96 MiB） |
| SHA256 | `6712863c90169abc582923f733043c3168d1b0da54baabb9169128f91da61e3b` |
| 载荷 | 4,918 个文件 / 124,372,540 B（payload.zip 43,967 KB） |
| 客户端 exe | 包内 `QQDeepSeekBot.exe` 199,680 B（本轮重建，含托盘更新检查） |
| 自带 node | `node.exe` v24（免用户装 Node） |

**载荷自检**（解 `dist\installer\payload.zip` 直接看条目，不靠猜）：

- `public/client.html` 34,723 B、`public/client.js` 392,327 B、`public/client.css` 82,192 B 都在；
  `public/` 共 6 个文件（另有 library/ops/ui-preview 三页），安装后能直接打开控制台；
- `docs/` 共 90 个文件（含 `desktop-host.md`、`installer-plan.md`），排障文档随包；
- `src/bridge.js`、`node_modules/`（4,290 个文件全部在）都在；`config.json`/`state/`/`logs/` 仍被
  `payload.json` 的 `forbidden` 拒绝进包。

**与 6B 一键更新的衔接**：壳下载的就是这个 setup，用现成的 `/S` 静默安装；安装器自身按 3.6 的合并式覆盖
保留 `state/` 与用户改过的 `config.json`。升级时安装器会先停掉「从安装目录启动的进程」，覆盖完成后由用户
再打开壳（壳会重新拉起桥接）。

**本轮未做**：没跑 `demo-install.ps1` 的完整静默装卸 demo（完整跑一次要出包 + 真实装卸，且会动
`%TEMP%` 安装目录）；`state/` 保留的断言仍由 `scripts/test-installer.mjs` 的静态 + 文件系统级演练覆盖
（P0-3 段 100/100 口径不变）。

## 4. SmartScreen / 签名（不装样子）

无代码签名证书，所以：

- 首次双击 `QQDeepSeekBot-Setup-*.exe`，Windows 会弹 **「Windows 已保护你的电脑 / 未知发布者」**
  → 必须点「更多信息」→「仍要运行」；
- 安装后第一次启动 `QQDeepSeekBot.exe` 同样可能被拦（取决于 SmartScreen 信誉）；
- 这不是 bug，也不是能靠改文件名/去掉 MOTW 绕过的；**不要**在文档里承诺"免提示"。
- 缓解：包内 `NOTICE.txt` 与安装完成页都写明来源与非官方声明；提供 SHA256 让用户自查。

**决定（2026-10-28，用户拍板 A）：不买代码签名证书。** 理由：这是个人自用/小圈子分发的工具，
证书按年计费、还要走企业实名，收益只是去掉一次点击；而 SHA256 + 开源仓库自查已经能覆盖
「这个包是不是我发的」这个问题。所以只在**交付文档里把步骤写清楚**，不改安装器行为：

1. 双击 `QQDeepSeekBot-Setup-x.y.z.exe` → 看到「Windows 已保护你的电脑」；
2. 点「更多信息」→「仍要运行」；
3. 装完第一次启动壳时若再拦一次，同样「更多信息 → 仍要运行」。

给收货人的一句话模板：「包是未签名的开源工具，Windows 会提示未知发布者，属正常；介意的话
用 `certutil -hashfile QQDeepSeekBot-Setup-x.y.z.exe SHA256` 和仓库里公布的哈希对一下。」
（这条口径同时写在 `docs/DELIVERY-README.md` 的安装段。）

## 5. 命名契约（用户定稿，全窗口统一）

| 项 | 值 |
|---|---|
| 品牌名 | QQ DeepSeek Bot（暂定） |
| 客户端 exe | `QQDeepSeekBot.exe` |
| 安装目录 | `%LOCALAPPDATA%\QQDeepSeekBot` |
| 卸载键 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\QQDeepSeekBot`（DisplayName=QQ DeepSeek Bot，DisplayIcon 指向 exe） |
| 快捷方式 | `QQ DeepSeek Bot.lnk`（桌面 + 开始菜单） |
| 安装包 | `QQDeepSeekBot-Setup-<version>.exe` |
| 非官方声明 | 「非腾讯 / 非 DeepSeek 官方产品（Not affiliated with Tencent or DeepSeek）」——安装完成页 + 卸载确认页 + NOTICE.txt |

## 6. 卸载后三查（验收口径）

```powershell
Test-Path "$env:LOCALAPPDATA\QQDeepSeekBot"                     # 目录
Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\QQDeepSeekBot'
Test-Path ([Environment]::GetFolderPath('Desktop') + '\QQ DeepSeek Bot.lnk')
Test-Path ([Environment]::GetFolderPath('Programs') + '\QQ DeepSeek Bot.lnk')
```

demo 用 `%TEMP%` 安装目录跑同一套三查（见 `dist\installer-demo\demo-*.log`，46/46 PASS）。

## 7. 环境坑（会坑下一个窗口）

1. **工作区里的 exe 起不来**：从 `<本机路径>\qq-bot-worktrees\w2\...` 直接启动自编译 exe，
   进程会出现但**永不执行**（无退出码、无日志）；同一文件复制到 `%TEMP%` 就正常。
   demo 因此会把安装包先复制到 `%TEMP%` 并校验 sha256 一致再跑（见 `demo-install.ps1`）。
   排查时别误判成"安装器坏了"。
2. **PS 5.1 读无 BOM UTF-8 当 ANSI**：`.ps1` 里的中文注释会导致 `ParserError`。
   `scripts/installer/*.ps1` 全部保持 ASCII（`test-installer.mjs` 有断言锁住）。
3. **csc 源码编码**：`Installer.cs` 含中文，必须 `csc /codepage:65001`，否则 UI/日志乱码。
4. **`Start-Process -Wait` + GUI exe 会挂住调用方**（管道句柄继承）；
   脚本里统一用 `-RedirectStandardOutput` 或 `.NET Process` 重定向。
5. `dist/` 被 gitignore：安装包产物不进提交，交付时用 `Get-FileHash` 给 sha256。
