# 项目总览 / Project Overview

> 这份文档面向「第一次拿到这个项目的人（或 AI）」：它是什么、由哪些系统组成、依赖什么、有什么文件可以看。
> 维护方式：随代码一起提交；与 `docs/CHANGELOG.md`（改动史）、`docs/FOLDER_MAP.md`（目录职责）、`AGENTS.md` 一起作为入口文档。

---

## 1. 它是什么

一个**跑在本机的 QQ 机器人桥接**：把 QQ（通过 SnowLuma/OneBot 网关）接到 **DeepSeek Harness (DSH)** 的 agent 运行时上，让 AI 能以「群友」的身份在群里收发消息、看图、看视频、发语音/表情、管理文件、学习黑话，并带一个控制台与运维面板。

一句话数据流：

```
QQ ←→ SnowLuma(OneBot WebSocket/HTTP, ws://127.0.0.1:3001)
      ↕
   src/bridge.js（桥接主进程：白名单/会话/媒体/工具/仿真社交/转存/账本）
      ↕  HTTP/WS (127.0.0.1:DSH 端口)
   DeepSeek Harness（agent 会话 + preset + 模型调用 + 工具）
      ↕
   模型供应商（deepseek-account / workbuddy2api / scnet / ollama 本地兜底）
```

- 桥接自身是一个 Node 进程（`node src/bridge.js`），控制台默认 `127.0.0.1:3100`。
- DSH 的 MCP 工具由桥接提供（`src/mcp-snowluma-safe.js`、`src/mcp-host-server.js`、`src/mcp-web-search-safe.js`），AI 通过 `qq_*` 工具操作 QQ。

---

## 2. 依赖组件（外部）

> **本压缩包只含 QQ Bridge 本体，不含下面这些外部软件/服务。**
> 每个组件是什么、怎么装、对应哪个配置项、不装会怎样，见 [`docs/EXTERNAL-DEPENDENCIES.md`](EXTERNAL-DEPENDENCIES.md)。


| 组件 | 作用 | 本机事实 |
|---|---|---|
| **Node.js** | 运行桥接/脚本 | v24.16.0（`engines: >=22.13.0`；`node:sqlite` 需 22.5+） |
| **DeepSeek Harness (DSH)** | agent 运行时：会话、preset、模型选择、工具执行 | 0.1.7+；本机端口随重启变化，桥接通过 `config.dsh.baseUrl` 或自动发现连接 |
| **SnowLuma** | QQ 协议网关（OneBot 11 兼容，WS 3001 / HTTP 3000） | `C:\SnowLuma`，账号 `100000007`（大肥鱼小姐） |
| **WorkBuddy2API** | OpenAI 兼容模型网关（`127.0.0.1:7863`） | 位于 `default-workspace\_wb`；整池可能受限（503 no_healthy_account） |
| **ollama** | 本地兜底模型 | `E:\ollama`，`qwen3:8b`（`socialV2.localFallback`）；不自启，需手动 `ollama serve` |
| **ffmpeg / ffprobe** | 抽帧、转码、缩略图、HEIC、音频抽取 | winget Gyan.FFmpeg 9.0.2，路径写在 `socialV2.voice.ffmpegPath` |
| **Python 3 + faster-whisper** | 视频/语音转写 | `tools/stt_cli.py`（CLI）与 `tools/stt_server.py`（常驻服务 8791）；模型缓存 `~/.cache/huggingface/hub/models--Systran--faster-whisper-*` |
| **SQLite** | 消息库与文件台账 | Node 内置 `node:sqlite`；`state/messages.db` |

npm 依赖（`package.json`）：
```
@deepseek-ai/dsh-host-apiproxy  @deepseek-ai/schemastery
@modelcontextprotocol/sdk        @snowluma/sdk  @snowluma/mcp
js-yaml  zod
```

---

## 3. 系统清单（按职责）

> 每个系统：干什么 / 入口文件 / 配置段 / 数据文件 / 对外接口。

### 3.1 渠道接入与白名单
- **职责**：连 SnowLuma，收 QQ 事件；私聊/群聊白名单；未授权会话忽略或礼貌拒绝；私聊配额。
- **入口**：`src/bridge.js`（`bot.onGroupMessage/onPrivateMessage/onNotice`）、`src/snowluma-conn.js`、`src/safe-fetch.js`
- **配置**：`allow.private/groups`、`privateOpen`、`deny`、`socialV2.privateQuota`
- **数据**：`state/sessions.json`（会话映射）、`state/private-quota.json`

### 3.2 DSH Agent 会话与模型
- **职责**：把 QQ 会话映射到 DSH session；挂 preset（`qq-chat-v2`）；选模型、降级链、坏模型黑名单、malformed 重试、含图轮切视觉模型。
- **入口**：`src/dsh-client.js`、`src/dsh-endpoint.js`、`src/model-fallback.js`、`src/malformed-retry.js`、`src/preset-prompt.js`
- **配置**：`dsh.{baseUrl,provider,model,modelFallbacks,reasoningEffort,visionModels}`、`socialV2.modelByKind/modelForMedia`
- **数据**：`state/sessions.json`、`state/social-v2.json`

### 3.3 仿真社交（reserved2 模式）
- **职责**：AI 自主决定「看不看、回不回、何时潜水」；WakeConfig（@/名字/关键词/提问/拍一拍/概率/speakerIds）；diving、proactive 主动机会、burst 连发、no-action 重置。
- **入口**：`src/bridge.js`（reserved2 段）、`src/v2-wait.js`
- **配置**：`socialV2.wake/proactive/send/wait`

### 3.4 消息与媒体
- **职责**：文本/图片/视频/语音/名片/合并转发解析；媒体归一化（长边 1280、≤1MB、GIF 抽帧）；消息入库与检索。
- **入口**：`src/media-normalize.js`、`src/media-queue.js`、`src/attachment-classify.js`、`src/message-db.js`、`src/forward.js`、`src/md-to-plain.js`
- **配置**：`socialV2.media.{maxBytes,maxDownloadBytes,maxPixels,maxCount,maxModelBytes,maxLongEdge,gifFrames,gifTile}`
- **数据**：`state/messages.db`、`state/video-frames/`

### 3.5 视频分析（抽帧 + 语音转写）
- **职责**：mp4 分流 → 抽 9 帧九宫格 + 抽音轨 + faster-whisper 转写；两段等待（帧≤8s、转写≤90s）；迟到转写主动补发；引用里的视频同样分析。
- **入口**：`src/video-analyze.js`、`src/stt-service.js`、`src/video-followup.js`、`tools/stt_cli.py`、`tools/stt_server.py`
- **配置**：`socialV2.video.{maxBytes,maxSeconds}`、`socialV2.stt.{model,videoModel,lang,waitMs,maxChars,inlineWaitMs,service,followUp}`
- **数据**：`state/video-frames/`、`state/social-v2.json`（`videoFollowUps.sent`）

### 3.6 语音合成与发送
- **职责**：`qq`（官方 AI 语音）/`edge`（edge-tts）/`local`（本地 TTS 服务）三通道；限额（时长/字节/每分钟）；发送后 `get_msg` 回读校验；去重。
- **入口**：`src/tts.js`、`src/edge-tts.js`、`src/voice-core.js`、`src/voice-dedupe.js`、`src/send-voice-lib.js`
- **配置**：`socialV2.tts.{provider,voice,style,edgeRate,edgePitch,byKey}`、`socialV2.voice.{enabled,dir,maxSeconds,maxBytes,maxPerMinute,maxPerHour}`

### 3.7 文件转存（含 BOOTH / simpleMode）
- **职责**：白名单群的文件/图片转存；命令触发（`/转存` 或 @机器人+意图词）；类型白名单（图片+压缩包）；2.5GB 上限与流式落盘；台账、保留期、清理；BOOTH 号解析、元数据/封面抓取、分类目录；**simpleMode** 兜底（只收 7 位 BOOTH 号开头的压缩包/图片，按群/时间或按商品号归档，不自动清理）。
- **入口**：`src/file-archive.js`、`src/booth-meta.js`、`src/booth-classify.js`、`src/booth-cover.js`、`src/booth-thumb.js`、`src/library-items.js`、`src/disk-guard.js`
- **配置**：`fileArchive.{enabled,groups,dir,maxFileMb,retention,category,cleanupHour,simpleMode,booth}`
- **数据**：台账表 `file_archive`（`state/messages.db`）、归档根（当前 `E:/booth-inbox`）、`state/booth-cache/`
- **接口**：`/api/files*`、`/api/library/*`

### 3.8 表情库
- **职责**：QQ 收藏表情同步、群友表情收集（观察群）、注释（desc/localNote/tags/policy）、md5 去重、缩略图本地缓存、AI 发用策略（只读/可发）。
- **入口**：`src/sticker-lib.js`、`src/image-hash.js`、`src/image-thumb.js`
- **配置**：`socialV2.sticker.{autoCollect,promptMaxStickers,syncTtlMs,collect,maxListCount}`
- **数据**：`state/stickers.json`、`state/sticker-files/<md5>.img`

### 3.9 黑话学习（slang）
- **职责**：从群聊提取高频陌生词 → 候选库 → AI/联网研究 → 人工确认 → 状态升级（听懂/可用）→ 每轮注入上下文。
- **入口**：`src/slang-learner.js`、`src/bridge.js`（`feedSlangWindow`/注入）
- **配置**：`slang.{enabled,extractMinMessages,extractCooldownMs,injectMax,autoResearch,researchChunkSize,...}`
- **数据**：`state/slang.json`、`state/slang-session.json`

### 3.10 观察学习
- **职责**：白名单群「只看不说」：不唤醒、不回复、不扣额度；后台收集词汇与表情包。
- **入口**：`src/observe-learn.js`
- **配置**：`observe.{enabled,groups,learnSlang,learnStickers}`
- **接口**：`GET /api/observe/config`

### 3.11 记忆与人格
- **职责**：人格卡（角色设定/口癖/边界）、记忆分层（短期/长期/事件/印象）、会话退役时交接摘要（handoff digest）。
- **入口**：`src/persona.js`、`src/role-card.js`、`src/memory-layers.js`、`src/local-fallback-persona.js`
- **数据**：`state/memory.json`（按实现）、`state/social-v2.json`

### 3.12 账本与成本
- **职责**：按事件记账（turn/step/retry）、价格表、基线投影、系列/汇总口径、未定价与空 model 采样（0 成本）、按会话/时间查询。
- **入口**：`src/token-ledger.js`、`src/model-prices.js`
- **配置**：`pricing.models`、`dsh` 模型
- **数据**：`state/token-usage.jsonl`
- **接口**：`/api/tokens/summary|series|turns|recent`

### 3.13 出图（imagegen）
- **职责**：`/api/socialV2/draw`，两档 `tier=free|high`（免费档带 AI生成 标注、高质量档每日 30 次）；首单预热；提示词翻译（本地优先）；配额与 429 处理；观察群禁画。
- **入口**：`src/imagegen.js`、`src/imagegen-quota.js`
- **配置**：`imagegen.{enabled,provider,apiKey,baseUrl,models,sizes,cooldownMs,maxPerHour,promptTranslate}`
- **数据**：`state/imagegen-quota.json`

### 3.14 联网搜索
- **职责**：给 AI 的 `web_search` / `web_fetch` 安全封装（SSRF 限制、内容截断）。
- **入口**：`src/web-search.js`、`src/mcp-web-search-safe.js`

### 3.15 控制台 / 运维面板 / 库页
- **职责**：控制台（`/`）看状态、配置、用量、唤醒、表情注释；运维面板（`/ops`）黑话/表情/服务状态；库页（`/library`）BOOTH 商品卡片与未分类。
- **入口**：`public/client.html`（+ 拆出的 `public/client.css` / `public/client.js`）、`public/ops.html`、`public/library.html`；控制台 API 由 bridge 提供，全局 `x-console-token` 闸门 + Host 校验。
- **数据**：只读为主；写操作限定（分类、策略、清理、重启等）。

### 3.16 安全与审计
- **职责**：敏感词/PII 审计与遮蔽；出站消息敏感信息拦截；SSRF 防护（safe-fetch 逐跳校验）；本地路径限制（归档根、语音库）；MCP agent token 与会话绑定；控制台 token 定长比较、Host/Origin 校验。
- **入口**：`src/sensitive.js`、`src/safe-fetch.js`、`src/lock-guard.js`、`src/bridge.js`（闸门）
- **测试**：`test-audit-bridge`、`test-mcp-safe`、`test-safe-fetch-bounded`

### 3.17 运维与自检
- **职责**：启动器（`start.bat`/`restart.bat`/`start-bridge-forever.bat`）、Windows 计划任务（`QQBridge-Bridge`/`QQBridge-SnowLuma`）、日志（`state/bridge.log`、`logs/bridge-stdout.log`）、状态文件、配置备份、单实例锁、自检脚本与一键回归。
- **入口**：`src/lock-guard.js`、`src/self-test.js`、`scripts/regression-all.mjs`、`scripts/verify-after-restart.mjs`、`scripts/check-acceptance.mjs`

---

## 4. 更新统计（截至 2026-10-26 09:00）

| 指标 | 数值 |
|---|---|
| 提交总数（仓库历史） | **327**（`git rev-list --count HEAD`） |
| 时间跨度 | 2026-10-25 13:39 ~ 2026-10-26 07:06 |
| 分日提交 | 10-25：311；10-26：16 |
| 源码 | `src/` **60** 个文件、**27,858** 行 |
| 脚本 | `scripts/` **189** 个（含 45+ 套测试与全部验收/迁移工具） |
| 文档 | `docs/` **37** 个文件（含指南 8 篇） |
| 工具 | `tools/` 2 个（STT CLI + 常驻服务） |
| 回归 | `regression-all` **46/46** 通过（跳过需活 DSH 的 1 套） |

主要改动按模块（按提交标题关键词统计，含重叠）：模型/降级 72、控制台/面板 88、视觉/图片 62、安全/审计 66、观察学习 37、文件转存/BOOTH 36、视频/语音 33、账本 21、表情 13、测试/回归 179。

---

## 5. 内置文件：给人看 vs 给 AI 看

### 5.1 给人看（人类入口）
| 文件 | 用途 |
|---|---|
| `README.md` / `README.en.md` | 项目说明、功能、部署 |
| `README-COMMANDS.md` | 常用命令速查 |
| `RULES.md` | 项目铁律（安全边界、不可回退项） |
| `docs/OPERATING.md` | 运行/运维手册 |
| `docs/FOLDER_MAP.md` | 目录与文件职责地图 |
| `docs/DEGRADATION.md` | 降级策略与优先级 |
| `docs/CHANGELOG.md` / `docs/CHANGELOG-COMMITS.md` | 改动史（叙事 + 全量提交） |
| `docs/FIXES.md` | 逐条修复记录（含证据） |
| `docs/audit-p2-status.md` | 历史审计项结论 |
| `docs/guides/*` | DSH 适配、安装、安全基线、隐私、控制台 UI 测试、token 控制台 |
| `docs/handoff-*.md` | 各批次交接卡（施工窗口产出） |
| `docs/api-contract-files.md` | 文件台账/观察学习接口契约 |
| `docs/booth-item.schema.json` | BOOTH 商品元数据 schema |
| `docs/booth-library-manager-reverse.md` | BOOTH Library Manager 逆向笔记 |
| `docs/research-booth-konoasset.md` | konoasset 元数据研究 |

### 5.2 给 AI 看（AI 入口/上下文）
| 文件 | 用途 |
|---|---|
| `AGENTS.md`（如存在） | 给 AI 的项目约定与操作边界 |
| `docs/COLLAB.md` | 多窗口协作约定（工作树/派活/交接格式） |
| `docs/api-contract-files.md` | 接口字段契约（前端/AI 都据此实现） |
| `docs/FOLDER_MAP.md` | 目录地图，避免 AI 乱翻 |
| `config.example.json` | 全部配置段与注释（AI 修改配置的依据） |
| `src/mcp-snowluma-safe.js` | MCP 工具定义（`qq_*` 的 schema 与描述就是 AI 的工具说明） |
| `src/mcp-host-server.js` / `src/mcp-web-search-safe.js` | DSH 宿主与搜索工具定义 |
| `src/preset-prompt.js` + `~/.dsh/plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml` | 群聊 preset（人格/工具面/协议），AI 行为的最终来源 |
| `_snowluma-catalog.json` | SnowLuma 动作目录（工具映射参考） |
| `docs/handoff-*.md` | 给下一位（人或 AI）的交接说明 |

---

## 6. 数据与状态文件（`state/`）

| 文件 | 内容 |
|---|---|
| `messages.db` | 消息库（含 `file_archive` 文件台账） |
| `sessions.json` | QQ 会话 ↔ DSH session 映射、会话策略 |
| `social-v2.json` | 仿真社交状态：WakeConfig、bootstrap、待发/已发、视频补发记录 |
| `token-usage.jsonl` | 账本明细（按事件） |
| `slang.json` / `slang-session.json` | 黑话库与学习会话 |
| `stickers.json` / `sticker-files/` | 表情库与本地缩略图缓存 |
| `group-names.json` | 群号 → 群名缓存 |
| `booth-cache/` | BOOTH 元数据与封面缓存 |
| `video-frames/` | 视频抽帧拼图（临时） |
| `console-token` | 控制台令牌（自动生成） |
| `bridge.lock` / `bridge.log` | 单实例锁与运行日志 |

---

## 7. 打包给别人参考（怎么导出一份干净副本）

仓库自带 `scripts/pack-project.ps1`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/pack-project.ps1
# 产物：dist\qq-bridge-<日期>.zip + 同名 .sha256
```

**默认排除**（避免泄露运行时数据与体积）：
`node_modules/`、`.git/`、`state/`（含消息库/令牌/日志）、`config.json`（真实配置，改用 `config.example.json`）、`*.bak*`、`dist/`、`logs/`。
**保留**：`src/`、`scripts/`、`docs/`、`tools/`、`public/`、`config.example.json`、README/RULES 等。

收到 zip 的人按 **`docs/QUICKSTART.md`（干净机器 30~60 分钟跑起来）** → `README.md` → `docs/OPERATING.md` → `docs/guides/DSH_SETUP.md` 顺序读；
一键引导：`powershell -File scripts\bootstrap.ps1`，环境体检：`node scripts\setup-doctor.mjs`。
AI 先读本文件 + `docs/COLLAB.md` + `docs/FOLDER_MAP.md`。

---

## 8. 已知限制（当前）

1. 依赖本机安装的 DSH / SnowLuma / WorkBuddy2API / ffmpeg / Python；不是开箱即用的 SaaS。
2. `simpleMode` 与「完整 BOOTH 商品库」二选一：前者只有基本归档（封面不自动抓），后者需要 `simpleMode=false`。
3. 观察群/BOOTH 的年龄限制内容只标 `gated`，未做专门展示策略。
4. `state/` 里的消息库、日志、令牌**绝不能**打包外发。
