# 交付包使用说明（先看这一页）

> 这是**一台能跑起来的 QQ 机器人系统**，不是只有桥接代码的壳。
> 目标：别人拿到这个目录，30 分钟内在自己的机器上跑起来；极端情况下能照这里的文档从零重建。

## 0. 30 秒判断你属于哪档

| 你手上有什么 | 走哪档 | 预计耗时 |
|---|---|---|
| 已装 DSH + 自己的模型 key | **A 档**：只装网关与桥接（本文 §3） | 20–30 分钟 |
| 全新 Windows 机器，什么都没有 | **B 档**：从零装 DSH/SnowLuma（本文 §4） | 60–120 分钟 |
| 只想读代码/学架构 | **C 档**：`docs/` 随便翻，不用跑 | — |

先跑一次自检，它会告诉你差什么：

```powershell
node scripts/setup-doctor.mjs
```

exit 0 = 可以启动；exit 1 = 有阻断项，按它给的 `→` 修。

## 1. 这个包里有什么

```
src/               桥接主程序（bridge.js 约 1.9 万行）+ DSH 客户端 + 三个 MCP server
scripts/           安装（setup-dsh）、自检（setup-doctor）、测试、打包、归档、度量
public/            控制台前端页面
assets/            控制台素材
dsh/agent-presets/ qq-chat / qq-chat-v2 两条 preset 的权威源（setup-dsh 从这里生成 patch）
plugins/           QQ 模式插件 bundle（qq-mode-console / qq-agent-presets）
roles/             角色卡（人设）：每张 .md 一个角色，文件名=角色名
persona/           当前角色选择 + 首启提示示例（手动放进 state/ 才生效）
state/stickers.json + state/sticker-files/
                   表情库（**默认带**，约 150 MB）：记录数/图片数随群聊收集增长，实际条数以包内
                   DELIVERY-MANIFEST.json 或构建输出为准
delivery/ops/      start-all / stop-all / status-all 三件套
docs/              全部可公开文档：规格（M4-M7）、CHANGELOG、runbook、重建手册、第三方清单
config.template.json  配置模板（占位符，必须改；字段说明见 docs/CONFIG-FIELDS.md）
DELIVERY-README.md    本文件
```

> **包体积约 160 MB**（解压后），其中九成以上是表情库图片（随收集增长）；zip 因图片已压缩，大小接近。
> 如果嫌大见 §7.1——表情库可以整个删掉，不影响收发消息。

## 2. 对方必须自备（我们不随包）

| 必需 | 说明 |
|---|---|
| Node.js ≥ 22.13 | 桥接用到内置 `node:sqlite`；低版本直接起不来 |
| DeepSeek Harness（DSH） | 模型运行时，**闭源桌面应用，请到官方下载安装**（我们不随包分发） |
| 一个 QQ 小号 | 能扫码登录；建议别用主号 |
| SnowLuma（或任意 OneBot 11 网关） | QQ 协议网关，非商业许可；自行下载 + 扫码登录 + 开 OneBot WS/HTTP |
| 模型凭据 | DSH 登录自己的 DeepSeek 账号；或自己在 DSH 里加 OpenAI 兼容 provider（WorkBuddy2API / MiMo / ollama…） |

可选：ffmpeg（视频抽帧/HEIC）、Python + faster-whisper（语音转写）、ollama（本地兜底）、本地 TTS（RVC 音色）。

## 3. A 档：三步跑起来

> 所有 PowerShell 命令都建议用这个形式，避免执行策略拦截：
> `powershell -NoProfile -ExecutionPolicy Bypass -File <脚本.ps1>`

```powershell
# 1) 依赖
cd <解压目录>
npm install

# 2) 配置（先复制模板，再改 4 个必填项）
copy config.template.json config.json
notepad config.json      # 填 ownerQQ / allow.groups / snowluma.accessToken / dsh.baseUrl

# 3) 接线 DSH（profile 名要和你的 DSH 一致：desktop 或 web）
node scripts/setup-dsh.mjs desktop
#    然后**重启 DSH**（MCP 与 preset 只在启动时加载）
```

验证：DSH 新建会话能看到「QQ 聊天角色（二代仿真）」preset，会话里能看到 `mcp__snowluma__*` 工具。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-all.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ops\status-all.ps1
```

启动后打开 `http://127.0.0.1:3100`（token 在 `state/console-token`，桥接首次启动自动生成），
确认模式是 **reserved2（二代仿真）**，然后在群里 @ 它一句 —— 10–60 秒内有回复即成功。

## 3.5 可选：打成安装包（双击安装，桌面快捷方式）

包里带安装器源码（`scripts/installer/` + 根目录 `build-installer.ps1`），但**不带预编译 exe**
（未签名、体积、以及"包内不放二进制"的隐私口径）。安装器打出来是**完整产品**（约 42.6 MB，
内含 `node.exe`，目标机不需要装 Node），装完会自动用包内 node 起桥接。想走"双击安装"就打一次：

```powershell
# 1) 先构建客户端宿主（首次会从 nuget 下载 WebView2 SDK，约 9.4 MB）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\desktop\build-host.ps1
# 2) 再出安装包（csc 编译，离线，不依赖 Inno/NSIS/7z）
powershell -NoProfile -ExecutionPolicy Bypass -File build-installer.ps1
# 产物：dist\installer\QQDeepSeekBot-Setup-<version>.exe
```

安装到 `%LOCALAPPDATA%\QQDeepSeekBot`，桌面与开始菜单快捷方式指向 `QQDeepSeekBot.exe`
（带 `--root "<安装目录>"`），卸载项在「设置 → 应用」，也可直接跑安装目录里的 `Uninstall.exe`。
可选参数：`/D=<目录>` 换安装目录、`/port=<端口>` 换控制台端口、`/owner=<QQ>` 写 ownerQQ。
**前置依赖**：本项目是「QQ ↔ DSH 桥接」——没有 DSH 时客户端会显示「DSH 未连接」；
QQ 收发还需要 SnowLuma/OneBot 网关，并把群号/QQ 填进安装目录里的 `config.json`。
宿主需要 **WebView2 运行时**（Win10/11 一般已装；缺失时安装器会弹窗给官方下载链接并退出，不会静默失败）。
安装包与宿主都**未签名**：首次运行会看到 SmartScreen「未知发布者」，点「更多信息 → 仍要运行」。
这是已拍板的取舍（不买签名证书，理由见 `docs/installer-plan.md` §4）；介意的话先自查哈希：
`certutil -hashfile QQDeepSeekBot-Setup-x.y.z.exe SHA256`，与发你的那份哈希对一下再装。
设计取舍与四条路线实测见 `docs/installer-plan.md`。


## 4. B 档：全新机器

在 §3 之前补三步：

1. 装 Node.js 22.13+（官网 LTS）→ `node -v` 验证
2. 装 DSH（官方下载页）→ 启动 → 登录自己的 DeepSeek 账号 → 能新建会话对话
3. 装 SnowLuma（官方 releases）→ 扫码登录 → 打开 OneBot WS(3001)/HTTP(3000) → 设 accessToken（与 `config.json` 里一致）

再按 §3 走。**注意 B 档现实耗时 60–120 分钟**（DSH 安装包约 1 GB、npm 依赖、扫码风控），别按 30 分钟预期。

## 5. PowerShell 执行策略（一定会遇到的坑）

新会话里直接 `.\ops\start-all.ps1` 可能被拦（`无法加载文件，因为在此系统上禁止运行脚本`）。两种解法任选：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-all.ps1
# 或（仅当前进程，退出即失效）
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

`.ps1` 文件请保持 **ASCII 内容**或存成 **UTF-8 with BOM**：PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI，
中文注释可能吞掉下一行（本项目踩过，报错信息很怪）。

## 6. 目录导航：遇到问题去哪看

| 我想… | 看这里 |
|---|---|
| 知道每个配置字段怎么填 | `docs/CONFIG-FIELDS.md` |
| 看端口/依赖/启动顺序 | `docs/OPERATIONS-HANDBOOK.md` |
| 从零重建（极端情况） | `docs/OPERATIONS-HANDBOOK.md` §重建清单 |
| 出包/校验/回滚 | `docs/release-runbook.md` |
| 为什么改 src 要重启 | `docs/HOT-RELOAD.md` |
| 换人设 / 写角色卡 | `roles/README.md` |
| 表情/语音/黑话怎么用 | `docs/` 下对应文档 |
| 历史变更 | `docs/CHANGELOG.md` |
| 第三方软件来源与许可 | `docs/THIRD-PARTY.md` |
| **改完代码/填完配置，先确认能不能起来** | `node scripts/boot-smoke.mjs`（沙箱真跑一遍启动装配，不连网关、不发 QQ；红了会直接打印是哪个符号/模块没接上） |
| 连上了但收不到消息 | `README.md` §SnowLuma 版本与上游健康 |

## 7. 包里**没有**什么（隐私边界）

- `state/`：**只有表情库是例外**（见 §7.1）。群聊记录、群友 QQ、好感度与印象、摘要、会话映射、
  控制台 token —— 全部剥离
- `logs/`、`audio/`（可能含群友声音）、`dist/`、`node_modules/`（走 `npm install` 恢复）
- `.git/`（历史里可能有旧 token，**必须剥离**）
- `config.json` 本体 → 已换成 `config.template.json`（占位符）
- 部分私人角色卡（是否带上由原作者决定；包里至少带当前在用的那张）
- 归档库 `booth-inbox/` 属于群友内容，不外发

### 7.1 表情库（默认带，可删）

- 内容：`state/stickers.json`（记录数见 DELIVERY-MANIFEST.json；字段级已脱敏：`collectedBy`→`<群友>`、
  `collectedContext`/`lastContext` 清空、`source`/`collectedFrom` 的群号→`<群号>`；
  `id`/`url`/`fileid` 等发消息必需的字段原样保留）+ `state/sticker-files/`（图片文件，约 150 MB）
- **图片本身来自群聊，可能包含群友头像/截图**。若接收方不接受，直接删掉 `state/sticker-files/`
  与 `state/stickers.json` 即可，**其余功能不受影响**（表情包功能会从零开始重新收集）。
- 这条是 `state/` 的唯一白名单例外，构建清单里单独注明（`delivery-manifest.json` → `stateWhitelist`）。

## 8. 极端情况：只有这个 zip 时怎么重建

1. 按 §2 装 Node / DSH / SnowLuma / 模型凭据
2. 解压 → `npm install` → 复制模板填配置
3. `node scripts/setup-dsh.mjs <profile>` → 重启 DSH
4. `node scripts/verify-rebuild.mjs`（随包提供，逐项核对重建结果；非 0 退出即按提示修）
5. `ops\start-all.ps1` → 控制台切 reserved2 → 群里验证
6. 想恢复表情库：把备份的 `state/stickers.json` 与 `state/sticker-files/` 放回 `state/` 下，
   重启桥接即可（没有也能用，只是从零重新收集）

完整逐步清单（含每一步的失败处置）见 `docs/OPERATIONS-HANDBOOK.md` §5。

## 9. 常见故障速查

| 现象 | 先查 |
|---|---|
| `snowluma 未连接` | SnowLuma 是否启动、3000/3001 是否监听、`accessToken` 是否两边一致 |
| `dshReady=false` | DSH 是否启动、`dsh.baseUrl` 端口对不对（不确定就留空自动发现） |
| 群里说话没反应 | 控制台活动流有没有入站；模式是不是 reserved2；`qq_*` 工具是否加载（没加载=DSH 没重启） |
| `npm install` 失败 | 网络/代理；`postinstall` 会修 `@snowluma/sdk` 的 ESM 打包，失败会导致连不上网关 |
| 启动报 `node:sqlite` 不存在 | Node 低于 22.13，升级 |
| 改了 `src/` 没变化 | 必须重启桥接（`ops\stop-all.ps1` 再 `ops\start-all.ps1`） |

## 10. 开源与许可

- 本仓库：MIT（见 `LICENSE`）
- 第三方：详见 `docs/THIRD-PARTY.md`（DSH、SnowLuma 等**不随包**，来源与许可状态逐项列明）
