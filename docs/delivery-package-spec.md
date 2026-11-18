# 交付包规格：把「整台机器人系统」交给别人

> 版本：2026-10-27 · 作者：W2 · 状态：规格（只调研、未出包）
> 口径：交付物 = **一台能跑起来的 QQ 机器人系统**，不是 `qq-bridge-src` 一个仓库的 zip。
> 本文所有体积/版本/路径均为本机只读实测（2026-10-27 12:35–13:0x），不含任何真实 token。

## 0. 先说结论（给拍板的人）

1. **只发桥接 = 空壳**，这一点用户说对了。一次性把 `dist\qq-bridge-*.zip` 发给别人，对方拿到的是：桥接主进程 + 控制台 + 工具，但**没有模型运行时（DSH）、没有 QQ 网关（SnowLuma）、没有 MCP 注册、没有人设卡、没有 config.json**。四样缺一样都跑不起来，缺 DSH 连「模型在哪」都没有。
2. **能随包分发的只有一小半**：桥接本体（MIT）、人设卡与 preset（我们自己的）、配置模板与文档。**DSH 是闭源商业应用、SnowLuma 是非商业许可的第三方、wb2api 是 AGPL 第三方、模型 key 与 QQ 号是对方自己的**——这几样只能「指导对方自备」，不能替对方打包（详见 §2 的「可再分发性」列）。
3. **「像不像人」的核心不是代码，是四件套**：`roles/*.md` 角色卡 + `state/current-role.json` 选择 + `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 里的 preset prefix（含 65 行「不要/别」类约束）+ `socialV2.initialPromptMaxChars=2000` 的首启提示预算。少这四样，交付出去的就是「会回话的客服」而不是「大肥鱼小姐」。
4. **交付分三档**（§3）：A 同构迁移（对方已有 DSH + 自己的模型 key）最现实，30 分钟可验收；B 全新机器要 60–120 分钟，且**必须由对方自己装 DSH 与 SnowLuma**；C 纯参考只给代码+文档。

---

## 1. 全景图

### 1.1 依赖关系（文字版）

```
QQ 客户端（对方的号，扫码登录）
   ↕ QQ 协议（SnowLuma 自己维护）
SnowLuma（第三方 QQ 网关；OneBot v11 WS :3001 / HTTP :3000）
   ↕ OneBot WS + accessToken
qq-bridge（本仓库；Node ≥ 22.13；控制台 :3100）
   ↕ DSH 本地 HTTP/WS（DSH 桌面应用，本机实测端点 http://127.0.0.1:13707）
DeepSeek Harness（模型运行时；加载 qq-chat-v2 preset + 3 个 MCP server）
   ↕ 模型 API（四选一或并存）
      · deepseek-account（DSH 自带，登录 DeepSeek 账号）
      · workbuddy2api（本地中转 :7863，AGPL 第三方，需 WorkBuddy 账号）
      · xiaomi-mimo（云 API，需 key，走 env XIAOMI_MIMO_API_KEY）
      · ollama（本地 :11434，可选兜底）
   ↘ ffmpeg（抽帧/转码，可选）
   ↘ Python + faster-whisper（语音转写，可选）
   ↘ 本地 TTS（RVC，可选；音色私有，不随包）
```

两条要点：

- **桥接不直接调模型**，它只把 QQ 消息变成 DSH 的 prompt、再把 DSH 的回复发回 QQ。所以「模型是谁」由 DSH 的 provider 决定，`config.json` 里的 `dsh.provider/model` 只是**选型偏好**，模型本身必须先在 DSH 的 `cordis.patch.yml` 里存在（`llm-pi-ai` 的 providers 段）。
- **MCP 是 DSH 启动时加载的**。`qq_*` 工具不存在时，二代仿真模式（reserved2）什么都干不了：不会看未读、不会回、不会潜水。改 MCP 配置后必须重启 DSH，不是重启桥接。

### 1.2 启动顺序（顺序错了会看到假故障）

1. **DSH**（桌面应用启动，登录账号；MCP/preset 在启动时加载）
2. **SnowLuma**（QQ 扫码登录，开 OneBot WS/HTTP）
3. **模型端点**（官方账号已在 DSH 内；wb2api/ollama 若是本地服务要先起）
4. **qq-bridge**（`node src/bridge.js` 或 `start.bat`；自动发现 DSH、连 SnowLuma、起控制台）
5. 打开 `http://127.0.0.1:3100` 控制台，确认模式为 **reserved2（二代仿真）**

### 1.3 端口表（本机实测/配置默认）

| 端口 | 谁在听 | 用途 | 备注 |
|---|---|---|---|
| 3000 | SnowLuma | OneBot HTTP API | `snowluma.httpUrl` |
| 3001 | SnowLuma | OneBot WebSocket | `snowluma.wsUrl`；token 必须一致 |
| 3100 | qq-bridge | 控制台 / REST API | `consolePort`；无 token 访问返回 401 |
| 13707 | DSH 桌面应用 | 本地 HTTP/WS 端点 | `dsh.baseUrl`；留空则自动发现 |
| 7863 | WorkBuddy2API | OpenAI 兼容中转 | 可选；`dsh.provider=workbuddy2api` 时必需 |
| 11434 | ollama | 本地兜底模型 | 可选；`socialV2.localFallback` |
| 8791 | STT 服务 | faster-whisper 常驻转写 | 可选；`socialV2.stt.service.port` |
| 8765 | 本地 TTS | RVC 语音合成 | 可选；`socialV2.tts.provider=local` 时用 |

---

## 2. 逐组件清单

> 「可再分发性」只写查得到的；查不到写**待确认**，并给出建议动作，不编。

| 组件 | 来源 | 体积（实测） | 能否合法再分发 | 本机私有必须剥离 |
|---|---|---|---|---|
| **DeepSeek Harness（DSH）** | 需外部安装：`download.deepseek.com/dsh-desk/`（本机 0.2.1-rc.2，Electron 桌面版） | 1,043 MB（其中 app.asar 174 MB、runtime 257 MB） | **待确认**：安装目录里只有 Electron/Chromium 第三方许可，没有产品 EULA/许可文本；发布方为 DeepSeek（更新源 `download.deepseek.com`）→ 默认**不随包**，让对方向官方下载；若要随包必须先取得书面许可 | 账号凭据 `~/.dsh/.credentials.yaml`、`~/.dsh/llm-deepseek/`、`~/.dsh/sessions/`、`~/.dsh/state/`、工作区路径 |
| **qq-bridge（本仓库）** | 仓库内 | 225 MB（含 `state/` 200.6 MB）；**可交付核心 ≈ 8 MB**（src 2.7 + scripts 2.2 + docs 0.8 + assets 0.4 + public 0.5 + dsh 0.03 + plugins 0.1 + 根文件 0.3，含 `config.template.json`）；`node_modules` 另 21.5 MB | **可**：MIT（`LICENSE`，Copyright 2026 Derpyu520 and qq-bridge / QSH contributors），保留版权与许可即可 | `state/`（消息库/令牌/归档）、`logs/`、`config.json`、`audio/`（6.1 MB 人声/音频素材）、`*.bak*`、`dist/`、`privacy-rules.json`（真实 QQ/路径规则）、`docs/audits|design|legacy|research`、私人研究 md、`roles/`（私人角色卡，默认不随包） |
| **MCP 接线** | 需外部配置（DSH 侧） | 0（纯配置） | 随桥接仓库代码走（MIT）；配置文件是**对方机器生成的**，不随包 | 本机绝对路径 `C:\Program Files\nodejs\node.exe`、`<本机路径>\...\src\mcp-*.js` 全部要由 `setup-dsh.mjs` 重新生成 |
| **SnowLuma（QQ 网关）** | 需外部安装：官方 releases；本机是源码构建 `slbuild`（v2.1.1）与 `SnowLuma-win-x64.zip` | 42.7 MB（win-x64 发行 zip）/ 34.6 MB（源码树） | **可（有限制）**：`SnowLuma Source-Available Non-Commercial License v1.0` §3 允许再分发，条件是**非商业** + 附许可证全文 + 保留版权声明 + 修改版公开发布需书面许可；§4 禁止商业使用、禁止基于它另立项目。**建议**：让对方向官方下载，我们只在文档里指路 | SnowLuma 自己的账号/登录态、`head.zip`/`lite.zip` 等下载残留 |
| **WorkBuddy2API 中转** | 需外部安装 + 账号：本机在 `...\_wb\wb2api\wb2api.exe`（Go 单文件，`wb2api-panel v1.4.0`） | 32.4 MB（含面板 zip 与日志） | **可（AGPL-3.0）**：允许再分发，但必须附完整许可与源码获取方式，网络服务需向使用者提供源码；**另有风险**：它把腾讯 WorkBuddy 账号转成 API，账号使用受上游条款约束 → 建议**不随包**，由对方自备账号与自装 | `config.json`（含 key/账号）、`auths/`、`data/`、`service.log` |
| **模型凭据（DeepSeek 账号 / wb2api / MiMo）** | 需对方自备 | 0 | 不可分发（账号/密钥属个人） | 一切 key、token、cookie |
| **人设与预设** | 仓库内 | 角色卡 `roles/` 37.7 KB（小鲸鱼 15,458 B、绫 9,490 B、肉便器 9,489 B、大肥鱼小姐 3,731 B、傲娇助手 497 B）；preset `qq-chat-v2` 30 KB（`agent.cordis.yml` 29,126 B，含 65 行「不要/别」类约束 + `persona` 段）；`qq-chat` 8.8 KB | **可**（自研，随桥接 MIT 一起发）；但**含私密内容**：`roles/肉便器.md` 属私密角色卡，是否外发必须用户本人拍板 | `state/current-role.json`（本机选择，写的是「大肥鱼小姐」）、私人角色卡若不外发要替换为示例卡 |
| **首启提示** | 仓库内 | `socialV2.initialPromptMaxChars=2000`（默认值）；本机**没有** `state/initial-prompts.json`（即用默认，无私人内容） | 可 | 若目标机曾写过 `state/initial-prompts.json`，属私人文本，必须剥离 |
| **Node.js 运行时** | 需外部安装（≥ 22.13，内置 `node:sqlite`；本机 v24.16.0） | 约 80 MB 安装后 | 可（Node.js 自身 MIT 系许可，随包需附 LICENSE） | 无 |
| **ffmpeg / ffprobe** | 需外部安装（本机 winget 装 9.0.2 full build，路径在 `socialV2.voice.ffmpegPath`） | 约 100–200 MB | **待确认**：gyan full build 是 GPL 构建，随包即触发 GPL 义务；建议让对方自装并只写进配置 | 本机绝对路径（要改成 `ffmpeg` 或空） |
| **Python + faster-whisper（STT）** | 需外部安装（本机 Python 3.10.7；本机 `stt.service` 未启用） | 运行时约 100 MB + 模型 0.5–1.5 GB | 可（faster-whisper MIT / Whisper 权重 MIT 系），但体积大 → 建议自装 | 模型缓存、`~/.cache/huggingface` |
| **本地 TTS（RVC）** | 本机私有：`<本机路径>\local-tts` | **9,478 MB**（`.venv` + `models/` + 音色权重） | **不可**：音色来自真人声线，涉及人格/声音权利；且含大量第三方权重 → 必须剥离 | 全部（只保留 `server.py` 的安装说明） |
| **ollama + qwen3:8b** | 需外部安装 | **13,475 MB**（模型目录） | 可（ollama MIT / qwen3 Apache-2.0），但体积巨大 → 让对方自装或直接关掉本地兜底 | 无（模型不属于隐私，但没必要随包） |
| **归档/素材（booth-inbox、qq-bot-data）** | 本机私有数据 | 252 MB（booth-inbox）+ 归档库 | **不可**：含群友上传素材与聊天衍生数据 | 全部 |
| **表情库/收藏表情** | 本机私有（群友创作） | 数百 KB～数 MB | **不可**（版权归属不明，且是群友作品） | `state/stickers*`、缩略图缓存 |

---

## 3. 三种交付档位

### 档位 A：同构迁移（**推荐**，对方已有 DSH + 自己的模型 key）

适用：对方已经装了 DSH、能登录自己的模型账号，只缺「QQ 这一侧」。
交付物：桥接代码 zip（normal 档，不含 node_modules）+ 人设四件套 + `config.template.json` + 本规格 + `docs/guides/DSH_SETUP.md` + `docs/EXTERNAL-DEPENDENCIES.md`。

步骤（每步都有判据）：

1. 解压到任意目录（路径不要带空格/中文，减少踩坑）→ 判据：目录下有 `src/bridge.js`、`package.json`。
2. `npm install` → 判据：exit 0，`node_modules/@snowluma` 存在（`postinstall` 会修 SDK 的 ESM 打包）。
3. 复制模板：`copy config.template.json config.json`，按 §4 填 4 个必填项 → 判据：`node -e "JSON.parse(require('fs').readFileSync('config.json','utf8'))"` 无输出。
4. 安装 DSH 侧：`node scripts/setup-dsh.mjs desktop`（profile 名要跟对方 DSH 实际 profile 一致；本机是 `desktop`）→ 判据：输出里有 MCP 三条与 preset 两条，`~/.dsh/profiles/desktop/cordis.patch.yml` 出现 `# === qq-bridge MCP BEGIN ===` 段。
5. **重启 DSH** → 判据：新建会话的 preset 列表里有「QQ 聊天角色（二代仿真）」；会话里能看到 `mcp__snowluma__*` 工具。
6. 装 SnowLuma 并扫码登录、开 OneBot WS/HTTP、设 access token（与 `config.json` 一致）→ 判据：`curl http://127.0.0.1:3000/get_login_info`（带 token）返回 QQ 号。
7. `node src/bridge.js` → 判据：日志出现「SnowLuma 已连接」「dshReady=true」；`http://127.0.0.1:3100` 能开。
8. 群里 @ 一句 → 判据：10–60 秒内有回复；控制台活动流有本轮记录。

预计耗时：**20–30 分钟**（下载 npm 依赖占大头）。

### 档位 B：全新机器（从零）

适用：对方只有一台 Windows 电脑和一个 QQ 小号。
交付物：A 的全部 + `docs/guides/DSH_SETUP.md`（DSH 安装指引）+ SnowLuma 官方下载地址 + 模型接入二选一说明（DeepSeek 账号 或 自建 OpenAI 兼容端点）。

步骤 = A 的 0–8，前面插入：

0. 环境检查：Windows 10/11 x64、≥ 8 GB 内存、≥ 10 GB 空闲、一个**能扫码登录的 QQ 小号**（不要用主号，风控与小号无关）。
1. 装 Node.js 22.13+（官网 LTS）→ 判据：`node -v` ≥ v22.13。
2. 装 DSH（官方下载页）→ 启动 → 登录**对方自己的** DeepSeek 账号（或自己在 DSH 里加 OpenAI 兼容 provider）→ 判据：DSH 里能新建会话并正常对话。
3. 装 SnowLuma（官方 releases）→ 扫码 → 判据：SnowLuma 界面显示在线、OneBot 服务已开。

预计耗时：**60–120 分钟**（DSH 安装包 ~1 GB、npm 依赖、扫码风控等待）。**做不到 30 分钟**，不要对外承诺 30 分钟；能承诺的是 A 档 30 分钟。

### 档位 C：纯参考（学习用，不含可运行环境）

适用：对方只想读代码/学架构，不打算跑。
交付物：桥接源码 + `docs/`（剔除私人研究文档）+ 本规格 + 架构说明（README 的架构段、`docs/EXTERNAL-DEPENDENCIES.md`、`docs/why-silly.md` 可选）+ 角色卡**示例一张**。
明确不含：config、DSH、SnowLuma、任何 key、任何 state、任何私有角色卡。
步骤：解压 → 读 `docs/FOLDER_MAP.md` → 跑 `node scripts/test-*` 里不依赖外部服务的套件（如 `test-session-cwd-guard`、`test-affinity`）验证代码可读可测。

---

## 4. 配置模板化

### 4.1 三个令牌各是什么、从哪来

| 字段 | 作用 | 怎么来 | 留空会怎样 |
|---|---|---|---|
| `snowluma.accessToken` | 连 SnowLuma 的 OneBot WS/HTTP | **对方在 SnowLuma 里自己设**，两边填一致 | WS 被拒，QQ 收发全不可用 |
| `consoleToken` | 桥接控制台/REST 的访问令牌 | 留空 → 桥接自动生成到 `state/console-token`（MCP server 也从这里读，见 `src/mcp-snowluma-safe.js:111`） | 自动生成；控制台需要它才能进 |
| `dsh.authToken` | 桥接对 DSH 的鉴权 | 留空 → 自动从 DSH 本机 guard 日志发现 launch token | 一般可行；跨机/自定义端点才需要手填 |

`socialV2.peakPause.localModel.apiKey`（小米 MiMo）走环境变量 `XIAOMI_MIMO_API_KEY` 或配置字段；**没有 key 就把 `peakPause.enabled` 设 false**。

### 4.2 必填 / 可空（模板见 `config.template.json`）

必填（不填跑不起来）：`ownerQQ`、`allow.private` 或 `allow.groups` 至少一项、`snowluma.accessToken`、`dsh.baseUrl`（或留空自动发现）。
建议必填：`dsh.provider/model`（选一个对方 DSH 里真实存在的模型）。
可空/有默认：`consoleToken`、`dsh.authToken`、`dsh.visionModels`（有图才需要）、`agentPreset`（默认 qq-chat-v2）、`consolePort`(3100)、`workspaceTitle`、`role.maxInjectChars`(6000)、`social`/`socialV2` 全部子项（内置默认，缺省即默认行为）、`pricing`、`webSearch`、`fileArchive`、`observe`。

### 4.3 改了要重启 vs 热加载

- **改完必须重启桥接**（`src/config-reload.js:5` 的 `RESTART_REQUIRED_PATHS`）：`sessionCwd`、`agentPreset`、`snowluma.wsUrl`、`snowluma.httpUrl`、`snowluma.accessToken`、`dsh.baseUrl`、`dsh.authToken`、`dsh.authHeader`、`dsh.authPrefix`。
- **其余字段热加载**（fs.watch，约 1 秒生效）：模型/降级链、白名单、社交参数、工具开关……
- **DSH 侧任何改动都要重启 DSH**：`cordis.patch.yml`（MCP、provider）、preset 安装。MCP 只在启动时加载。
- **换人设**：`state/current-role.json` + 角色卡 md 是运行期读取，改完下一条消息生效，不用重启（但角色卡本身要重跑 `setup-dsh.mjs` 才会进 preset 的默认注入——只有 preset prefix 变了才需要）。

### 4.4 三个必须写进安装文档的坑

1. **`socialV2` 是浅合并，不是深合并**：`loadConfig()` 里 `socialV2: { …完整默认…, ...(file.socialV2 ?? {}) }`（`src/bridge.js:1059`）——只要 config 里写了**哪怕一个** `socialV2` 子项，整个默认对象就被这个小对象替换掉，工具开关/唤醒/记忆全丢。所以模板**故意不写 `socialV2`**；对方要改社交参数，要么不写（用默认），要么从 `config.example.json` 整段复制后逐项改。
2. **`config.example.json` 不能直接当生产模板**：它带着失效的 `scnet` 兜底模型（第 24–27 行）和一处被写坏的 `workspaceTitle`（乱码）。用它当模板会继承死模型降级链；本文的 `config.template.json` 已剔除。
3. **`dsh.baseUrl` 端口因机而异**：桥接有 `discoverDshBaseUrl()` 自动发现（`src/bridge.js:3552`），显式填错反而连不上。不确定就按模板填本机实测值，或启动后看日志里实际连上的端点。

### 4.5 模板文件

`config.template.json`：全部机密与路径用 `<PLACEHOLDER>` 写法，JSON 合法（可用 `node -e "JSON.parse(require('fs').readFileSync('config.template.json','utf8'))"` 自检）。**模板里的任何值都不是可用值**，必须替换。

---

## 5. 安装向导 + 一条命令自检

### 5.1 一条命令自检

```
node scripts/setup-doctor.mjs
```

- 作用：干净机器上解压后先跑，逐项检查 Node 版本、端口、DSH 端点、SnowLuma 连通、config 必填、preset/MCP 是否装好；exit 0 = 可以启动（可能有警告），exit 1 = 有阻断项。
- `--json` 给机读输出，适合写进安装脚本。
- **实测（2026-10-27，在打包 stage 副本里跑）**：Node ✅、node_modules 依赖齐 ✅、SnowLuma WS/HTTP 可连 ✅、ffmpeg ✅、faster-whisper ✅；`config.json` 不存在被正确点名为阻断项（新包本来就没有 config，符合预期）；控制台 3100 被占用给出警告。即「解压→doctor」这一步对小白是可用的一步诊断。
- 已知小瑕疵：同一台机器上 doctor 曾把 DSH 端点探成 `127.0.0.1:14043` 并判连不上（实际 DSH 在 13707，桥接 config 里显式填了 13707）。新机器上 DSH 没跑时这条提示本来就该出现；若对方确信 DSH 已启动却仍看到这条，先核对 `config.dsh.baseUrl`。

运行中自检（桥接已启动后）：

```
curl -H "x-console-token: <CONSOLE_TOKEN>" http://127.0.0.1:3100/api/status
```

判据：`snowluma.connected=true`、`dshReady=true`。失败处置见 `docs/release-runbook.md` 的三道闸写法（先看 exit code 再定位，不要凭感觉重装）。

### 5.2 从零到「群里说一句它有反应」的最短路径（B 档）

| # | 动作 | 验证判据 | 失败处置 |
|---|---|---|---|
| 1 | 装 Node 22.13+ | `node -v` ≥ 22.13 | 低于则重装；`node:sqlite` 缺失会直接起不来 |
| 2 | 装并登录 DSH | DSH 里能新建会话对话 | 登录失败先查账号/网络；DSH 是闭源应用，装不上只能换机器 |
| 3 | 装 SnowLuma、扫码、开 OneBot | `/get_login_info` 返回 QQ | 端口冲突改 3000/3001；风控换小号 |
| 4 | 解压桥接 + `npm install` | exit 0 | `npm install` 失败先查网络/代理；`@snowluma` 不存在说明 postinstall 没跑 |
| 5 | `copy config.template.json config.json` 并填 4 项 | JSON.parse 通过 | 少写逗号/中文引号是最常见错 |
| 6 | `node scripts/setup-dsh.mjs desktop` | 输出 MCP×3 + preset×2 | profile 名不对就去 `~/.dsh/profiles` 看实际目录名 |
| 7 | **重启 DSH** | 新会话有「QQ 聊天角色（二代仿真）」+ `mcp__snowluma__*` | 没出现就是没重启或 setup 写到了别的 profile |
| 8 | `node scripts/setup-doctor.mjs` | exit 0 | 按提示逐项修 |
| 9 | `node src/bridge.js` | 日志「SnowLuma 已连接」「dshReady=true」，3100 可开 | dshReady=false → 回到第 7 步 |
| 10 | 控制台切 reserved2，群里 @ 它 | 10–60 秒内回复 | 无回复看控制台活动流与 `logs/`；MCP 未加载时它「看不见」消息 |

### 5.3 真实耗时估计（不许对外吹 30 分钟）

- A 档（已有 DSH + key）：**20–30 分钟**。
- B 档（全新机器，网络正常）：**60–120 分钟**；若 DSH 安装包下载慢或 QQ 扫码触发风控，上限不可控。
- 目标「新机器 30 分钟能跑起来」**只有 A 档成立**；B 档请按 1–2 小时沟通。

---

## 6. 敏感物剥离与校验

### 6.1 必须剥离清单

| 类别 | 具体 | 为什么 |
|---|---|---|
| 运行数据 | `state/` 全目录（消息库、`token-usage.jsonl` 2.2 MB、表情缓存、归档、`console-token`、`affinity.json`） | 含群聊内容、令牌、群友 QQ |
| 日志 | `logs/`、`*.log` | 含群号、QQ 号、本机路径 |
| 配置 | `config.json`、`config.json.bak-*`（仓库根现有 12 个 bak） | 真实 token/key/白名单 |
| 音频素材 | `audio/`（6.1 MB） | 人声/语音素材，含真人声线 |
| 私人文档 | `docs/audits`、`docs/design`、`docs/legacy`、`docs/research`、`docs/qq-bridge-*` 计划/审计、根目录研究 md、`privacy-rules.json` | 含内部计划、真实标识 |
| 环境文件 | `.env`、`.env.*`、`.npm-cache`、`__pycache__`、`*.pyc`、`*.db`/`*.sqlite`、`privacy-rules.json` | 通用泄漏面 |
| 私有角色卡 | `roles/` 里除「示例卡」外的私人卡（至少 `肉便器.md` 属私密；其余由用户拍板） | 用户私人创作 |
| 依赖目录 | `dist/`（7.1 MB 构建产物）、`.git/` | 无必要、可重建 |

### 6.2 校验方法（复用现有闸门，不新造）

1. **打包前**（清单是唯一真源：`scripts/pack-exclude.json`）：
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-project.ps1 -DryRun
   ```
   判据：末行 `DRYRUN OK: stage ready at …`，且 stage 里 `Test-Path <stage>\state`、`<stage>\config.json`、`<stage>\logs` 全为 False。
2. **stage 扫描**（必须 exit 0 且 0 违规）：
   ```
   node scripts/pack-egress-scan.mjs --stage <stage 路径>
   ```
3. **隐私扫描**（提交/发布前，离线只读）：
   ```
   node scripts/privacy-scan.mjs            # 扫工作树
   node scripts/privacy-scan.mjs --tracked-only
   ```
   规则来自 `scripts/privacy-rules.json`（本机真实 QQ/路径，**不入库**；模板见 `privacy-rules.example.json`）。命中即 exit 1，且只打印脱敏片段。
4. **zip 内部复查**（不解压）：用 `tar -tf` 或 PowerShell 打开 zip 列名，确认 `state/`、`config.json`、`*.log`、`*.bak*`、`audio/`、`<本机路径>` 文本均不存在。
5. **token 自查**：在待发目录跑 `git grep -nE "sk-[A-Za-z0-9]{16,}|Bearer [A-Za-z0-9_\-]{20,}"` 必须返回空；再把本机的 `ownerQQ`、控制台 token、SnowLuma accessToken 三个真实值逐个 `grep` 一遍，必须全部返回空（**本文与模板里一个真实值都不许出现**）。

---

## 7. 对方还需要自己准备什么（**发给别人时最该说清的一段**）

| 必须自备 | 说明 | 没有会怎样 |
|---|---|---|
| **一台 Windows 10/11 x64 电脑** | 8 GB 内存起，10 GB 空闲盘 | 跑不动 / 装不下 |
| **一个 QQ 小号** | 能扫码登录；建议不用主号 | 网关登不上，整个系统零输入 |
| **DeepSeek 账号（或任意 OpenAI 兼容模型端点 + key）** | DSH 登录后自动获得 `deepseek-account` provider；或自己加 provider | 没有模型层，DSH 无法推理，机器人只会沉默 |
| **DSH 桌面应用** | 自行从官方下载安装；**我们不随包分发**（许可待确认） | 桥接启动但 `dshReady=false`，消息进不了 agent |
| **SnowLuma（或其 OneBot 替代）** | 自行下载安装，非商业许可；扫码登录后开 OneBot WS/HTTP 并设 access token | 收不到任何 QQ 消息 |
| **Node.js ≥ 22.13** | 官网安装（`node:sqlite` 是新版才有的内置模块） | `npm install`/启动直接失败 |
| **（可选）ffmpeg** | 要视频抽帧/语音转写/HEIC 才需要 | 视频只能看时长与文件名，转写不可用 |
| **（可选）Python + faster-whisper** | 要语音转写才需要 | 视频没有字幕文本 |
| **（可选）ollama / 本地 TTS** | 本地兜底与 RVC 音色 | 无影响，主模型兜底降级 |
| **（可选）自己的 WorkBuddy 账号** | 只有想用 wb2api 中转才需要；AGPL 第三方，风险自负 | 用官方 DeepSeek 账号即可绕开 |

另需说明的三件事：

1. **人设卡是用户的私人资产**：默认只附 1 张示例卡；「大肥鱼小姐」等私人卡要不要给，必须用户本人决定（含 `roles/肉便器.md` 这类私密卡）。
2. **群聊内容绝不出包**：`state/` 里是真实群聊与群友 QQ；任何档位都剥离。
3. **对方要自己承担 QQ 风控与第三方条款**：SnowLuma 是非官方协议实现，wb2api 涉及腾讯账号条款，这两项不在我们的责任范围。

---

## 8. 一页速查（给打包含的人）

- 交付 = 桥接（MIT）+ 人设四件套 + `config.template.json` + 本文 + `DSH_SETUP.md` / `EXTERNAL-DEPENDENCIES.md`；**不带** DSH、SnowLuma、wb2api、key、state。包内必须能看到 `dsh/agent-presets/qq-chat-v2/`、`plugins/qq-agent-presets/`、`assets/`、`config.template.json`；`roles/`（私人角色卡）默认**不**带，要带由用户点名。
- 出包三步：`pack-project.ps1 -DryRun` → `pack-egress-scan --stage`（exit 0）→ `privacy-scan`（exit 0）。
- 三档口径：A 30 分钟（对方已有 DSH+key）、B 1–2 小时（全新机器，DSH/SnowLuma 对方自装）、C 只读参考。
- 一句话原则：**能随包的只有我们自己的代码与人设；别人的软件与账号，指路不代装。**
