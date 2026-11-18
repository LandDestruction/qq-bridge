# 新系统设计（v1 草案）

> 目标一句话：**让机器人不依赖 DSH 桌面端自己跑，能力不降级；把现有功能做成可热开关的插件；数据全部迁过去。**
>
> 状态：草案，待确认后从阶段 0 动工。作者：Lead，2026-11-08。

---

## 0. 目标与非目标

### 目标

1. **脱 DSH**：不启动 Electron、不连 8998，机器人进程自身完成「读消息 → 思考 → 调工具 → 回话」。
2. **能力不降级**：吸收 DSH 里我们真正用到的组件（agent loop / tools / session / system prompt / MCP / LLM provider），不是自己重写一个简陋版。
3. **插件化**：现有功能拆成可热开关的插件，控制台里能开/关/配。
4. **数据迁移**：`messages.db`（133MB / 3 万条向量）、138 人档案、表情库、黑话库、印象、图像记忆全部迁过去。
5. **可平滑切换**：新旧两套并行跑，一个开关决定谁收消息，出问题 10 秒切回。

### 非目标（本期明确不做）

- 不重写控制台前端（复用现有 `public/` 资产，改造成「面板宿主」）。
- 不做第二家 IM 平台（保留 `channels/` 抽象，只实现 OneBot）。
- 不做无人值守的特权轨（先「只能人点」）。
- 不做桌面形象窗（先只在控制台预览）。

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ 接入层  channels/onebot  ← SnowLuma（OneBot v11 WS/HTTP）      │
│         事件规范化：群消息 / 私聊 / 拍一拍 / 戳一戳 / 撤回       │
├──────────────────────────────────────────────────────────────┤
│ 会话总线 bus/                                                  │
│   Thread（一条话题线）→ Turn（一轮）→ 事件流                   │
│   begin → surface_chunk → surface_done → deep_chunk →          │
│   deep_done → end        全部携带 turn_id                      │
│   打断：my_partial（说到哪被打断）+ protect（TTS 开播即锁）     │
├──────────────────────────────────────────────────────────────┤
│ 认知层 tracks/                                                 │
│   triage（分诊，快）→ duty（值班，中）→ privileged（特权，慢）  │
├──────────────────────────────────────────────────────────────┤
│ 能力层 plugins/（自有插件，热开关）                             │
│   memory / voice / vision / avatar / slang / affinity /        │
│   sticker / imagegen / tools-extra …                           │
├──────────────────────────────────────────────────────────────┤
│ 内核 kernel/（吸收的 DSH 组件，纯 Node，无 Electron）           │
│   Cordis 容器 + AgentLoop + ToolRuntime + SessionStore + LLM    │
├──────────────────────────────────────────────────────────────┤
│ 控制台 panels/ + console/（HTTP API，现有路由表搬过来）          │
└──────────────────────────────────────────────────────────────┘
```

关键变化对比：

| 维度 | 现在 | 新系统 |
|---|---|---|
| 大脑 | DSH Electron（8998），5 进程 1.45GB | 进程内 AgentLoop，单进程 |
| 一轮对话 | 唤醒 → HTTP 调 DSH → 等回复 | 进程内函数调用，无 HTTP 往返 |
| 会话存储 | DSH 的 `~/.dsh/sessions`（我们不掌控） | 自己的 `state/sessions/`，v4 事件溯源 |
| 功能开关 | 改 config.json + 重启 | 控制台点一下，插件热挂载 |
| 形象 | CDP + WebGL 截图（5–15s） | player 播放器，实时口型 |

---

## 2. 从 DSH 吸收哪些组件（已核实包名与导出符号）

DSH 已全局安装为 `@deepseek-ai/dsh@0.2.1-rc.3`，其 `node_modules/@deepseek-ai/` 下有 **305 个可独立依赖的包**。我们只取需要的：

> **已实测（`scripts/_poc-kernel.mjs`）**：**普通 node 直接 import 这些包、`new Context()`、`ctx.plugin(AgentLoop)` 全部成功，完全不需要 Electron。** 这消除了一整类风险。

这些包不是 `apply/inject/name` 形态的插件函数，而是 **Cordis Service 类**——装配方式是 `ctx.plugin(Class, config)`，依赖通过 `static inject` 声明。`AgentLoop` 的真实声明是：

```js
static inject = ["agents", "sessions", "llm", "tools", "systemPrompt", "sessionProjections"]
```

也就是说**这六个服务必须先装好**：`dsh-agent`→`agents`、`dsh-session-persistence-jsonl`→`sessions`、`dsh-llm-deepseek`/`dsh-llm-pi-ai`→`llm`、`dsh-tools`→`tools`、`dsh-system-prompt`→`systemPrompt`、`dsh-session-projection`→`sessionProjections`。少一个，`AgentLoop` 会一直 pending 不报错（Cordis 的注入语义），这是阶段 0 最容易卡住的地方。

| 用途 | 包 | 关键导出（已核实） |
|---|---|---|
| 容器/装配 | `cordis`、`cordis-plugin-group`、`cordis-plugin-include`、`cordis-plugin-timer` | `Context`、`ctx.plugin()` |
| Agent 主循环 | `dsh-agent-loop` | `AgentLoop`（Cordis 插件，`apply/inject/name`） |
| Agent 注册与上下文 | `dsh-agent` | `AgentRegistry`、`installModelSelection`、`assembleContextFor`、`agentEvents` |
| 会话存储 | `dsh-session` + `dsh-session-persistence-jsonl` + `dsh-session-projection` + `dsh-session-query-sqlite` | `SessionStore`、`Session`、`SessionId`、`adoptSessionEvent`、`foldSurface` |
| 模型层 | `dsh-llm` + `dsh-llm-deepseek` + `dsh-llm-pi-ai` + `dsh-llm-retry` | provider 中立接口（`dsh-llm` 是 `interface`） |
| 工具 | `dsh-tools` | `ToolRuntime`、`defineTool`、`validateArgs` |
| 现成工具 | `dsh-tool-bash`、`-fs`、`-fs-search`、`-todo`、`-jobs`、`-subagent`、`-schedule`、`-skill`、`-ralph`、`-ask-user`、`-present` | 每个都是 Cordis 插件，装上即注册 |
| 系统提示词 | `dsh-system-prompt` + `dsh-agent-instructions` | 提示词片段注册表 |
| 技能 | `dsh-skill` + `dsh-skill-filesystem` | 技能发现与加载 |
| MCP | `dsh-mcp-client` + `dsh-mcp-resources` | 现在 41 个 `qq_*` 工具就走这条 |
| 执行环境 | `dsh-bash-local`、`dsh-subprocess-local`、`dsh-sandbox-local`、`dsh-sandbox-policy`、`dsh-authorization` | 沙箱与授权 |
| 附件/工作区 | `dsh-attachment(-local)`、`dsh-workspace*` | 文件读写 |

### 装配方式：自己写 profile，不用 YAML 展开器

之前 POC 卡在「`lib/main.js` 里 webpack 混淆的 profile patch 展开器」。走独立包路线后这个坑消失——**我们自己写装配清单**，顺序严格按 `static inject` 的依赖拓扑：

```js
// profile.js —— 顺序即拓扑序，被依赖的在前
import { Context } from '@deepseek-ai/cordis'
import * as agents from '@deepseek-ai/dsh-agent'                       // → agents
import * as sessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl' // → sessions
import * as sessionProjection from '@deepseek-ai/dsh-session-projection'         // → sessionProjections
import * as systemPrompt from '@deepseek-ai/dsh-system-prompt'          // → systemPrompt
import * as llmDeepseek from '@deepseek-ai/dsh-llm-deepseek'            // → llm
import * as toolRuntime from '@deepseek-ai/dsh-tools'                   // → tools
import * as toolBash from '@deepseek-ai/dsh-tool-bash'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import * as agentLoop from '@deepseek-ai/dsh-agent-loop'                // 消费者，最后装

export default [
  [sessionPersistence, { dir: 'state/sessions' }],
  [sessionProjection,  {}],
  [agents,             {}],
  [systemPrompt,       {}],
  [llmDeepseek,        { apiKey: process.env.DEEPSEEK_API_KEY }],
  [toolRuntime,        { mode: 'native' }],
  [toolBash,           { sandbox: 'local' }],
  [mcpClient,          { servers: { snowluma: { command: 'node', args: ['mcp/snowluma.js'] } } }],
  [agentLoop,          { maxParallelToolCalls: 2 }],
]
```

启动器只有一句循环：`for (const [pkg, cfg] of profile) ctx.plugin(pkg.default ?? pkg, cfg)`。

**排错口诀**：某个服务「看起来装了但下游一直不启动」→ 就是它的 `inject` 名没对上。Cordis 不会报错，只会静默 pending。

---

## 3. 插件体系（自有契约）

### 3.1 包结构

```
plugins/voice/
  plugin.json      # 元数据 + 配置 schema + 贡献点声明
  index.js         # 生命周期
  panel/           # 可选：前端面板（esbuild 打成 dist/panel.js）
  README.md        # 为什么存在、开关影响什么
```

```json
{
  "id": "voice",
  "kind": "capability",
  "api": 1,
  "name": "语音",
  "requires": ["llm"],
  "provides": { "tools": ["send_voice", "list_voices"], "events": ["voice.synthesized"] },
  "panels": [{ "id": "voice", "title": "语音", "mount": "features", "entry": "dist/panel.js" }],
  "config": {
    "type": "object",
    "properties": {
      "ttsUrl": { "type": "string", "title": "TTS 服务地址" },
      "brightness": { "type": "number", "title": "提亮 dB", "minimum": 0, "maximum": 12, "default": 8 },
      "autoVoiceRatio": { "type": "number", "title": "自动语音占比" }
    }
  }
}
```

### 3.2 代码契约

```ts
export interface PluginContext {
  log: (msg: string, extra?: unknown) => void
  config: Record<string, unknown>          // 已按 configSchema 校验并填默认值
  paths: { root: string; state: string; data: string }
  bus: { on(evt: string, fn: (e: any) => void): () => void; emit(evt: string, e: any): void }
  tools: { register(def: ToolDef): void; unregister(name: string): void }
  llm: { complete(req: LlmRequest): Promise<LlmResult> }
  store: { get<T>(key: string): T | undefined; set(key: string, v: unknown): void }
  signal: AbortSignal                      // disable 时全部 abort
}

export interface Plugin {
  id: string
  start?(ctx: PluginContext): Promise<void>
  stop?(ctx: PluginContext): Promise<void>
  onMessage?(ctx: PluginContext, env: MessageEnv): Promise<void> | void
  onConfigChange?(ctx: PluginContext, next: Record<string, unknown>): Promise<void>
}
```

### 3.3 热开关语义

- `pluginHost.enable(id)`：按 `requires` 拓扑序 **先启依赖**，再启自己；实例化 `PluginContext`（带独立 `AbortController`）。
- `pluginHost.disable(id)`：**先停被依赖者**（反向拓扑），`abort()` → `stop()` → 注销所有 `tools` → 从面板宿主移除。
- 状态写 `state/plugins.json`：`{ "voice": { "enabled": true, "config": {...}, "updatedAt": "..." } }`。
- 热开关**不需要重启进程**；只有 `kernel` 级（换 LLM provider）才重启。
- 关掉的插件，其 `tools` 从 ToolRuntime 消失 → 模型自己也会看到「这个能力不在」，不会乱调。

### 3.4 控制台「插件」页

列表卡片：图标 / 名称 / 一句话说明 / 开关 / 健康点（运行中/已停/报错+最近一条错误）/ 「配置」按钮。
配置弹窗由 `configSchema` 自动生成表单（现有控制台已有 JSON Schema 表单渲染，可复用）。
「重启此插件」按钮 = disable + enable。

---

## 4. 三轨大脑

### 4.1 分诊轨（triage）——照抄 OpenAmika 的四行格式

每轮先进分诊，输出严格 JSON：

```ts
type Triage = {
  status: 'ok' | 'unfinished' | 'not-for-me'
  tone: string                    // 如 casual_warm / serious_cold
  mode: 'say' | 'say+think' | 'think'
  reply?: string                  // say / say+think 时的垫场半句
}
```

规则（写进 triage 的 system prompt，硬约束）：

- 要表达真正立场、讲理由、演情绪、或超过一句 → **不准用 `say`**，一律 `say+think` / `think`。
- 拿不准 `mode` 时**默认不用 `say`**。
- `not-for-me` 时 `reply` 留空，**连「哦好的」都别应**。
- 超时 1.5s → 降级为「不接话但记账」（不抢话，也不当没看见）。

模型：直连官方 flash（用户已定，先试点一周按 p95 延迟决定是否换）。

### 4.2 值班轨（duty）

- 日常对话 + 轻工具（查记忆、发表情、发语音）。
- 上下文 = 人设 + `withMemoryContext`（迁过来）+ 黑话 + 最近 N 条。
- 输出流式，先 `surface_chunk` 再 `deep_chunk`。

### 4.3 特权轨（privileged）

- 触发：**只能人点**（控制台按钮 / 私聊指令），或持有 `Mandate` 的 Ticket。
- 输入只吃**结构化摘要**：任务描述、约束、可用工具白名单、预算（token/时间）。
- 执行器：`dsh --profile headless --json`（一次性）或 `dsh-sdk-app`（常驻 JSON-RPC）。
- 产出 `Report`：`progress | ready | waiting | blocked | failed`，主会话据此决定要不要打扰人。
- `Mandate` 不可变：范围/强度/匹配规则/请求者写死，只有人能撤销，扩大范围要新开 Ticket。
- **一次授权管一段对话**（Subscription 自动续，送达不授予新权限）。

### 4.4 打断

```ts
bus.emit('interrupt', { turnId, myPartial })   // myPartial：AI 被打断那一刻嘴上最后 4–10 字
bus.emit('protect',   { turnId })              // TTS 开播即保护，之后不再 prune
```

收到 `interrupt` → 该 turn 标 `interrupted`，把所有未 `protect` 的推测生成 `abort()`。
再发一次 message 自动作废未保护生成（OpenAmika 的取消语义）。

---

## 5. 目录结构

```
dshbox/                          # 新仓，与 qq-bridge-src 平级，演进式并行
  package.json                   # 依赖锁死 0.2.1-rc.3（exact）
  profile.js                     # 装配清单（§2）
  src/
    kernel/
      boot.js                    # new Context() + 按 profile 装包
      agent.js                   # AgentLoop 封装：runTurn(messages, opts)
      llm.js                     # provider 路由：deepseek / official / wb2api / local
      tools.js                   # ToolRuntime + 权限三档 + 工具白名单
      sessions.js                # SessionStore + jsonl 持久化 + sqlite 查询
      prompt.js                  # 系统提示词组装（人设/记忆/黑话/场景）
    bus/
      thread.js turn.js events.js interrupt.js
    tracks/
      triage.js duty.js privileged.js mandate.js report.js
    channels/onebot/
      index.js normalize.js send.js
    plugins/
      memory/ voice/ vision/ avatar/ slang/ affinity/ sticker/ imagegen/
    plugin-host/
      loader.js lifecycle.js registry.js config.js
    panels/
      host.js rail.js features.js advanced.js
    console/
      server.js routes/*.js   # 现有 console-server.js 的路由表搬过来
  data/                          # models/ live2d/ memewiki.db（沿用现有）
  state/                         # 迁移后的数据（sessions/ plugins.json …）
  scripts/
```

约束（沿用 AGENTS.md 红线）：单文件 ≤ 800 行、单函数 ≤ 100 行、`src/index.js` 只做装配。

---

## 6. 迁移顺序

> 每阶段都独立可上线、可回退。`channel.owner = 'legacy' | 'new'` 决定谁收消息，同一时刻只有一个 owner，避免双回复。

| 阶段 | 内容 | 交付判据 | 估算 |
|---|---|---|---|
| **0** | 骨架跑通：profile.js + AgentLoop + LLM + Session，CLI 里问一句「你好」拿到流式回复 | 无 Electron 进程，纯 node 跑通一轮 | 0.5 天 |
| **1** | 总线 + OneBot 通道：接 SnowLuma，单群收发自如（无记忆无工具） | 群里回话成功，日志有 turn_id 事件流 | 1 天 |
| **2** | 三轨骨架：triage 四行判定 + duty 回复 + 打断/protect | `not-for-me` 不接话、被打断能停 | 1 天 |
| **3** | 工具层：ToolRuntime + 权限三档 + MCP（snowluma 41 工具）+ bash/fs | 能自己发表情、查历史、跑命令 | 1.5 天 |
| **4** | 插件宿主 + 控制台插件页：manifest 加载、热开关、配置表单 | 控制台点开关，voice 插件真停/真起 | 1 天 |
| **5** | 能力插件搬迁：memory（迁 messages.db + 3 万向量）/ voice / vision / slang / affinity / sticker | 功能对齐现有，数据一条不少 | 1.5 天 |
| **6** | 特权轨：Mandate/Ticket + Report + DSH 执行器（headless/sdk-app） | 点一下能让它跑个真实任务并回报 | 1 天 |
| **7** | 形象：player 接进控制台面板 + 口型同步接 TTS | 面板里角色跟着语音动嘴 | 1 天 |

**合计约 7.5 个工作日**（不含意外调试）。

### 阶段 0 的三个已知风险（已想好对策）

0. **已排除**：普通 node 能 load 全部 DSH 包并建 Context（实测见 §2）。剩下的是「六个服务名要对上」。
1. **Cordis `inject` 依赖对不上** → 先只装最小集（session + llm + tools + systemPrompt + sessionProjections + agents + agent-loop），每加一个包单独验证；用 `ctx.inject` 回调打日志确认服务已就位，别靠猜。
2. **LLM provider 配置**：`dsh-llm-deepseek` 走官方 API key；wb2api 反代用 `dsh-llm-pi-ai`（OpenAI 兼容）指向 `http://127.0.0.1:7863/v1`。
3. **版本漂移**：`package.json` 写 exact `0.2.1-rc.3`，升级前跑一遍回归。

---

## 7. 风险登记

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| 1 | DSH 组件版本耦合 | 升级破坏装配 | exact 版本 + 升级回归脚本 |
| 2 | 双跑期双回复 | 群里刷屏 | `channel.owner` 单 owner 开关 |
| 3 | 内存增长（新系统 +300MB 级） | N100 8GB 吃紧 | 阶段 3 后实测；必要时 triage 轨走远程小模型 |
| 4 | 迁移丢数据 | 半年聊天资产 | 迁移前 `messages.db` 冷备份 + 逐表行数比对 |
| 5 | 特权轨失控 | 无人值守时乱动文件 | 先只人点 + 白名单 + 单次预算上限 |
| 6 | Cordis 学习曲线 | 阶段 0 超时 | 先照 README 最小样例抄，不并行开多个包 |

---

## 8. 待确认

1. 新仓名 `dshbox` 是否可接受（或你想叫别的）。
2. 阶段 0 是否现在就开工（我预计今晚能跑通「CLI 里问一句」）。
3. 迁移期的 `channel.owner` 默认值：建议先 `legacy`，阶段 2 验收后再切 `new`。
