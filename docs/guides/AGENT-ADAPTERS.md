# 把别的 Agent 接到 QQ 上（接入设计文档）

> 面向：想把自己的 agent / 模型接到这个 QQ 桥接上的人。
> 读之前请先看 [DSH_SETUP.md](./DSH_SETUP.md) 了解本项目默认怎么跑。
> 本文分三部分：「今天就能做的」「已落盘的契约（P0，`src/agent/`）」「路线图（P1~P4）」。
> **没实现的接口都会明确标注**，照抄不会踩空。

---

## 1. 为什么现在只能接 DSH

一句话：**桥接把「推理 + 工具循环 + 会话」这三块整个外包给了 DSH，自己只做 QQ 侧。**

具体分工：

| 能力 | 归属 | 代码位置 |
| --- | --- | --- |
| 模型推理、工具调用循环、上下文压缩、会话生命周期 | DSH（DeepSeek Harness） | 通过 `src/dsh-client*.js` 走 DSH Web API |
| QQ 收发消息、表情、图片/语音、群管理、唤醒/潜水、黑名单、记忆、黑话 | 桥接 | `src/bridge/**` |
| 工具（40 个 `qq_*`） | 桥接实现、注册给 agent | `src/mcp-snowluma-safe/*.js` 与 `src/mcp-snowluma-safe.js` |
| 人格 / 唤醒策略 | DSH 的 agent preset + 桥接的唤醒提示词 | `dsh/agent-presets/qq-chat-v2/`、`src/bridge/wake-prompts.js` |

所以「换 agent」= 换掉上表第一行和第三行的宿主关系。桥接与 QQ 之间的那层（OneBot）不需要动，换 agent 不影响消息收发、表情库、记忆库、文件库这些已有能力。

DSH 这一侧的协议事实（写文档时逐条核对过，见文末附录）：

- 客户端是**纯 HTTP RPC + 事件流**：RPC 方法名带斜杠（`session/create`、`session/prompt`），参数包成 `{ args: { ... } }`，见 `src/dsh-client-transport.js:39-45`。
- 事件流走 `GET /api/remote.mux`，按 session `follow`，见 `src/dsh-client-session.js:304`。
- 回合事件名是 `turn/start`、`assistant/message`、`turn/end`，见 `src/dsh-client-turn.js:20-40`。
- 鉴权：`config.json` 的 `dsh.authToken`（`x-console-token` 是另一套，给人用的控制台用）。

---

## 2. 两种接入姿势

### 姿势 A：桥接当宿主（推荐）

桥接保持「谁说话、什么时候该说话、发什么」这些 QQ 侧决策，只把「这一轮怎么想」交给外部 agent。

| 子形态 | 状态 | 说明 |
| --- | --- | --- |
| `agent.type = "dsh"` | **已在用**（现行唯一实现） | 桥接用 `NodeApiClient` 建 workspace/session，`sessions/prompt` 投喂，从 mux 收 `assistant/message`。见 `src/bridge/session-runtime.js:90-96`、`src/bridge/prompt-delivery.js:73` |
| `agent.type = "openai"` | **已支持 transport（P1）**（默认仍 dsh；工具由桥接执行） | 任何 OpenAI 兼容 `/chat/completions`：DeepSeek、OpenAI、OpenRouter、vLLM、Ollama、LM Studio |
| `agent.type = "http"` | **只有契约（P2 待实现）** | 自研 agent 实现 `POST /turn` + SSE 事件流，桥接只认事件、不管内部框架 |

> P0 的抽象层**已经落盘**：`src/agent/contract.js`（163 行，纯函数契约）、`src/agent/registry.js`（46 行，`type → 工厂` 注册表）、
> `src/agent/transport-dsh.js`（58 行，把现有 `dsh-client*` 用法原样包一层）。
> `cfg.agent.type` 由 `normalizeAgentConfig()` 归一（缺省 `dsh`；未知值告警后回落 `dsh`），
> transport 由注册表按 type 取（`registerAgentTransport()` / `getAgentTransportFactory()`）。
> 注册表里目前只注册了 DSH（`src/bridge.js` 的装配处）；`openai` 的 transport 工厂已落盘（P1，见 5.2），`http` **还没落盘**，
> 运行期仍走 DSH 旧路径（`src/bridge/mux-runtime.js:33` 的 `agentTransportOf(deps)` 有回退）。

选 A 的理由：你只需要实现「一轮对话」，唤醒规则、静默判断、潜水、表情、记忆、白名单、防注入、token 记账全部由桥接继续负责。

### 姿势 B：agent 当宿主

已经有自己的 agent 框架（Claude Code、OpenClaw、LangChain、Cursor……），不想让桥接管循环：让 agent 自己驱动，桥接只暴露**工具面**和 QQ 网关。

| 方式 | 状态 | 说明 |
| --- | --- | --- |
| 直接跑 stdio MCP server | **今天可用** | `src/mcp-snowluma-safe.js` 是标准 MCP server（stdio，`@modelcontextprotocol/sdk`），注册方式见 `scripts/setup-dsh.mjs:131`；任何支持 MCP 的宿主都能挂它 |
| `GET /agent/tools` + `POST /agent/tool-call`（HTTP 工具面） | **计划中（P4）** | 给不支持 stdio MCP 的宿主用；目前**没有**这两个接口（`grep -rn "agent/tool-call" src/ scripts/` 无结果） |

姿势 B 下**桥接不发请求给 agent**，所以唤醒、主动发言、防刷屏这些桥接侧能力会失效或需要你自己实现；适合「你只想让 agent 在群里被 @ 时干活」的场景。

---

## 3. 协议契约（A 口径）

> 契约的**权威定义已经在代码里**：`src/agent/contract.js`（P0 纯函数，无 import）。
> 下面是给人读的摘要；字段以该文件为准，`http` 的**实现**还没落盘（P2）；`openai` 已实现（见 5.2，字段形状与本节一致）。

### 3.1 一轮请求的最小形状（`validateTurnRequest`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | 会话 key，形如 `group:123456` / `private:789`（桥接侧的会话标识） |
| `sessionId` | string | 是 | agent 侧会话标识（DSH 下是 DSH 的 session） |
| `messages` | array | 是 | 非空；每项 `{role, text}`，`role ∈ system\|user\|assistant\|tool`，`text` 必须是字符串 |
| `system` | string | 否 | 桥接拼好的系统提示词（人格、唤醒规则摘要） |
| `tools` | array | 否 | 本轮可用工具 `[{name, description?, parameters?}]`，与 §4 工具面同构 |
| `persona` | string \| object | 否 | 人格文本（来自 DSH preset 或 `qq_set_persona` 的会话级覆盖） |

`validateTurnRequest()` 非法时返回 `{ok:false, error:'中文一句'}`，**不抛错**——transport 实现可以直接把这句话写进日志或回给调用方。

> 尚未进入契约、但 P2 需要补的：`turnId` 幂等键、`DELETE /turn/{id}` 取消、`history` 摘要字段。
> 现在写 transport 的话，建议自己先加 `turnId`（幂等：同 id 返回同一 `turn_end`）。

### 3.2 事件流（`AGENT_EVENT_TYPES` 只认这 6 种）

外部 transport 可以用自己的事件名，桥接用别名表归一到内部 6 种（`projectTurnEvents()`）：

| 内部事件 | 可接受的别名 | data 载荷（建议） |
| --- | --- | --- |
| `text_delta` | `text` / `text-chunk` / `text_chunk` / `delta` | `{text}` |
| `tool_call` | `tool-call` / `tool_use` | `{id, name, arguments}` |
| `tool_result` | `tool-result` / `tool_output` | `{id, ok, content}` |
| `turn_end` | `turn-end` / `done` / `end` | `{finishReason, usage:{prompt,completion}}` |
| `usage` | — | `{prompt, completion, cached?}`，供 token 记账（`src/token-ledger/**`） |
| `error` | `failure` | `{code, message, retryable}` |

未知事件**不会让整轮失败**：`projectTurnEvents()` 丢弃并计数，返回 `{events, dropped, unknownTypes}`。

### 3.3 能力声明（`describeAgentTransport`）

| transport | stream | toolLoop | sessions | multimodal |
| --- | --- | --- | --- | --- |
| `dsh`（现状） | ✅ | ✅ | ✅ | ✅ |
| `openai`（P1） | ✅ | ✅ | ✅ | ❌ |
| `http`（P2） | 默认 ❌ | 默认 ❌ | 默认 ❌ | 默认 ❌ |

`http` 的能力由**对端声明**：`describeAgentTransport('http', {stream:true, toolLoop:true})`，只认布尔字段，没声明保持 false。

### 3.4 超时 / 鉴权

- 超时：`cfg.agent.timeoutMs` 默认 **120000**，夹在 `[5000, 600000]`（`normalizeAgentConfig`）。
- 鉴权：计划用请求头 `x-qdb-token`（**该头当前不存在**，`grep -rn "x-qdb-token" src/ docs/` 为空）；
  今天的 MCP 侧是 `x-console-token` + `x-agent-token` 双头，见 `src/bridge/console-server.js:319`。

---

## 4. 工具面（B 口径）

### 4.1 今天就能用：stdio MCP

`src/mcp-snowluma-safe.js`（103 行）就是一个 MCP server：

```text
McpServer({ name: 'snowluma-safe', version: '0.2.1-r1' })
  ├─ registerCoreTools()     src/mcp-snowluma-safe/tools-core.js     (151 行)
  ├─ registerSocialTools()   src/mcp-snowluma-safe/tools-social.js   (402 行)
  ├─ registerContextTools()  同上
  ├─ registerMemoryTools()   src/mcp-snowluma-safe/tools-memory.js   (173 行)
  ├─ registerMediaTools()    src/mcp-snowluma-safe/tools-media.js    (462 行)
  └─ registerAssetTools()    同上
```

你在自己宿主里把它当普通 stdio MCP server 挂上即可（DSH 就是这么挂的，见 `scripts/setup-dsh.mjs:131`，`toolCallTimeoutMs: 725000`）。工具实现全部走桥接的 HTTP 控制台 API（`src/mcp-snowluma-safe/http.js:138` 的 `agentApi()`），所以**桥接必须先在跑**。

### 4.2 工具清单（40 个，`grep -ho "'qq_[a-z_]*'" src/mcp-snowluma-safe/tools-*.js | sort -u | wc -l`）

注册是**按模式收敛**的：`tools-core.js` 里 `qq_get_group_members` / `qq_get_group_history` 只在 `closed-agent` 模式注册（读 `state/mode.json`），其余模式不注册以省 schema token —— 所以不同模式下工具数量不同。

- **身份与状态**：`qq_status`、`qq_self_model`
- **群与成员**：`qq_list_groups`、`qq_get_group_members`、`qq_get_group_history`、`qq_get_active_members`、`qq_get_prompt`、`qq_social_state`
- **消息读取**：`qq_get_unread_messages`、`qq_get_recent_messages`、`qq_get_my_recent_messages`、`qq_get_message_detail`、`qq_get_forward_msg`、`qq_search_history`、`qq_recall`、`qq_get_message_images`
- **发言与节奏**：`qq_send_message`、`qq_send_poke`、`qq_wait_for_messages`、`qq_mark_read`、`qq_set_wake_config`、`qq_report_feedback`
- **媒体**：`qq_send_image`、`qq_send_sticker`、`qq_send_tts`、`qq_send_voice`、`qq_draw`、`qq_list_stickers`、`qq_get_sticker_image`、`qq_collect_sticker`、`qq_sticker_note`、`qq_set_sticker_remark`、`qq_list_voices`、`qq_get_self_image`
- **记忆与黑话**：`qq_memory`、`qq_memory_event`、`qq_slang_query`、`qq_slang_submit`
- **好感度与人设**：`qq_affinity_shift`、`qq_set_persona`

完整参数 schema 不用抄文档：MCP 宿主连上后会拿到（也就 8.8k token 左右，见 `src/mcp-snowluma-safe.js` 顶部注释）。

### 4.3 计划中的 HTTP 工具面（P4，未实现）

| 接口 | 说明 |
| --- | --- |
| `GET /agent/tools` | 返回 JSON Schema 数组（与 4.2 同名同参数），供不支持 MCP 的宿主拉取 |
| `POST /agent/tool-call` | body `{name, arguments}` → `{ok, content}`，执行同一个工具实现 |

当前**没有**这两个接口；如果你现在要 HTTP 工具面，只能自己 fork `src/mcp-snowluma-safe.js` 接一层。

---

## 5. 配置样例

### 5.1 今天唯一可用的：DSH

```jsonc
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:1076",
    "provider": "workbuddy2api",
    "model": "deepseek-v4.1-flash",
    "reasoningEffort": "high",
    "authToken": "",
    "authHeader": "authorization",
    "authPrefix": "Bearer",
    "allowRemote": false,
    "modelFallbacks": [
      { "provider": "workbuddy2api", "model": "deepseek-v4-pro" }
    ]
  },
  "agentPreset": "qq-chat-v2"
}
```

`agentPreset` 指向 `dsh/agent-presets/qq-chat-v2/`（`preset.yml` + `agent.cordis.yml` + `qq-tool-restrict.mjs` 壳；权威工具收敛实现在 `plugins/qq-agent-presets/qq-tool-restrict.mjs`）。

### 5.2 OpenAI 兼容（P1 已支持：`agent.type=openai`）

```jsonc
{
  "agent": {
    "type": "openai",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "apiKey": "",
    "model": "qwen2.5:14b",
    "timeoutMs": 120000
  }
}
```

云侧同理，只换 `baseUrl`/`apiKey`（DeepSeek 用 `https://api.deepseek.com/v1`）。
`temperature` / `maxSteps` / `tools` 这类**尚未进契约**，写了不会被 `normalizeAgentConfig()` 读取（P1 再扩）。

#### 5.2.1 最小可跑配置（P1）

```json
{
  "agent": {
    "type": "openai",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-...",
    "model": "deepseek-chat",
    "timeoutMs": 120000,
    "maxToolRounds": 8
  }
}
```

- `baseUrl` 末尾带不带 `/` 都行（内部归一后拼 `/chat/completions`）。
- `apiKey` 只写不读：`GET /api/config` 不会回明文，只回 `agent.hasApiKey` 布尔。
- 工具不写在配置里：桥接会用 `src/mcp-snowluma-safe.js` 的 MCP `tools/list` 拿到现成
  JSON Schema，再转成 OpenAI 的 `tools` 格式；模型回的 `tool_calls` 由**桥接执行**，
  结果以 `tool_result` 事件回填后继续对话（`capabilities().toolLoop === 'host'`）。
- 超过 `maxToolRounds`（1~20，默认 8）会以 `error` 事件收尾，不会无限循环。

### 5.3 自研 HTTP agent（P2 待实现；字段形状已定）

```jsonc
{
  "agent": {
    "type": "http",
    "baseUrl": "http://127.0.0.1:8787",
    "apiKey": "",
    "timeoutMs": 120000
  }
}
```

> 以上两段放在 `config.json` 顶层（与 `dsh` 同级）。**字段形状由 `src/agent/contract.js` 的
> `normalizeAgentConfig()` 定义并会被读取**，只认 `{type, baseUrl, apiKey, model, timeoutMs}`（缺省 `dsh`）；
> `openai` 的工厂已在 `src/bridge.js` 装配处注册（P1，`registerAgentTransport('openai', …)`）；默认配置仍是 dsh，切过去只需在 `config.json` 写 `agent.type="openai"` + 端点信息并重启。`http` 仍是 P2。
> `timeoutMs` 默认 120000、夹 5000~600000；DSH 自己的 token 仍走 `dsh.authToken`。

---

## 6. 最小示例代码

### 6.1 Python：OpenAI 兼容 + 一次工具调用（P1 生效后可用）

```python
import json, os, requests

BASE = os.environ.get("AGENT_BASE", "https://api.deepseek.com/v1")
KEY = os.environ["AGENT_KEY"]
TOOLS = [{"type": "function", "function": {
    "name": "qq_send_message",
    "description": "在指定会话发一条消息",
    "parameters": {"type": "object", "required": ["key", "messages"],
                   "properties": {"key": {"type": "string"},
                                  "messages": {"type": "array", "items": {"type": "string"}}}}}}]

def turn(system, user, tool_result=None):
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    if tool_result:
        msgs.append({"role": "tool", "name": "qq_send_message", "content": tool_result})
    r = requests.post(f"{BASE}/chat/completions", timeout=120,
                      headers={"Authorization": f"Bearer {KEY}"},
                      json={"model": "deepseek-chat", "messages": msgs, "tools": TOOLS})
    msg = r.json()["choices"][0]["message"]
    calls = msg.get("tool_calls") or []
    return {"text": msg.get("content") or "", "calls": calls}
```

要点：模型输出里的 `tool_calls` 由**桥接**执行，你的实现只需要把工具结果注回下一轮；不要自己发 QQ。

### 6.2 Node：HTTP transport 实现（P2 生效后可用）

```js
import http from 'node:http';

// 请求体形状以 src/agent/contract.js 的 validateTurnRequest 为准：
// { key, sessionId, messages:[{role,text}], system?, tools?, persona? }
http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/turn')) return res.writeHead(404).end();
  const body = JSON.parse(await readBody(req));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // 真实现请替换成你自己的 agent 循环；这里只演示事件形状
  const last = body.messages?.at(-1)?.text ?? '';
  send('text_delta', { text: `收到 ${last.slice(0, 40)}` });
  send('usage', { prompt: 100, completion: 20 });
  send('turn_end', { finishReason: 'stop', usage: { prompt: 100, completion: 20 } });
  res.end();
}).listen(8787, '127.0.0.1');
```

关键：`turn_end` 必须发（`done`/`end` 这两个别名也认）；`tool_call` 事件发出后桥接执行并回 `tool_result`。

---

## 7. 接入检查清单

接之前逐条确认，能省掉一半调试时间：

1. **人格从哪来**：DSH 路线人格在 preset（`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`）；换 agent 后不会自动继承，见 §8。
2. **唤醒规则谁决定**：桥接侧（`src/bridge/wake-prompts.js` + `qq_set_wake_config`）；B 路线自己驱动就没有这套。
3. **记忆/黑话/表情是否由桥接提供**：是。工具 `qq_memory`、`qq_slang_query`、`qq_send_sticker` 已封装，不要绕过去直接读写 `state/`。
4. **token 记账**：桥接按 `usage` 事件记账（`src/token-ledger/**`）；不报 usage 就记 0，成本面板会失真。
5. **黑名单**：`qq_affinity_shift` 等写操作的硬限速在桥接侧；自研 agent 请走工具而不是直接改 state。
6. **并发**：一轮一个会话；P2 契约里会补 `turnId` 幂等键，接入时自己先做去重（见 §3.1 末注）。
7. **失败重试**：`error.retryable` 才重试，且用同一个 `turnId`。
8. **日志位置**：桥接日志在 `logs/` 与 `state/bridge.log*`，报错先看这里再怀疑 agent。
9. **白名单**：发送目标必须在 `config.json` 的 `allow.groups` / `allow.private` 里，否则发送工具直接拒。
10. **鉴权**：stdout MCP 走 `x-agent-token` + `x-console-token`（见 `src/bridge/console-server.js:319`）；HTTP transport 的 `x-qdb-token` 尚不存在（P2 才落地）。

---

## 8. 路线图与已知限制

| 阶段 | 内容 | 影响 |
| --- | --- | --- |
| **P0 抽象（已完成）** | `src/agent/contract.js`（配置归一/请求校验/事件归一/能力表）+ `src/agent/registry.js`（type→工厂）+ `src/agent/transport-dsh.js`（DSH 包装，零行为变化） | 桥接内部重构，外部无感；`cfg.agent` 已可被读 |
| **P1 openai** | `agent.type=openai`，任何 OpenAI 兼容端点 | 已实现：桥接自己跑工具循环（本地 MCP），模型只回 tool_calls |
| **P2 http** | `agent.type=http`，`POST /turn` + SSE | 自研 agent 的正式入口；契约见 §3 |
| **P3 人格与唤醒上移** | 人格、唤醒策略从 DSH preset 移到桥接配置 | 换 agent 也能保留「像群里那个人」的说话方式 |
| **P4 MCP 宿主** | `GET /agent/tools` + `POST /agent/tool-call` | agent 框架自己驱动循环，桥接只做 QQ 网关与状态 |

**明确写在这里的限制：**

- 换 agent 后**不会自动获得** DSH 预设里的人格与唤醒策略，需要桥接侧 P3 完成，或走 B 路线自己实现。
- 姿势 B 下桥接不主动唤醒 agent，**主动发言、潜水、静默判断、防刷屏都不生效**。
- `agent.type=http` 与 `GET /agent/tools` **当前未实现**；`agent.type=openai` 的 transport 已实现（P1），但默认配置仍是 dsh。
- 工具面依赖桥接 HTTP 控制台在跑；桥接停了工具全废。
- 40 个工具≠每种模式都注册（见 §4.2），按模式收敛是刻意的省 token 设计。

---

## 附录：本文引用核对清单

写文档时逐条 grep/读过，均为真实存在（行号以当前 HEAD 为准，代码改动后可能漂移）：

| 引用 | 核对方式 |
| --- | --- |
| `src/dsh-client.js`（38 行，桶） | `cat`，导出 `NodeApiClient` / `unwrap` / `createTurnCollector` / `blocksToText` 等 |
| `src/dsh-client-session.js:304` → `/api/remote.mux` | `grep -n "remote\.mux" src/dsh-client-session.js` |
| `src/dsh-client-transport.js:39-45` → `wrapArgs` / `requestId` | `grep -n "wrapArgs\|requestId"` |
| `src/dsh-client-turn.js:20-40` → `turn/start`、`assistant/message`、`turn/end` | `grep -n "turn/end\|assistant/message"` |
| `src/bridge/session-runtime.js:90-96` → `workspace.create` + `sessions.create` | `grep -n "workspace.create\|sessions.create"` |
| `src/bridge/prompt-delivery.js:73` → `sessions.prompt` | 同上 |
| `src/bridge/model-selection.js:335` → `sessions.selectModel` | 同上 |
| `src/agent/contract.js`（163 行）→ `AGENT_TRANSPORTS` / `AGENT_EVENT_TYPES` / `normalizeAgentConfig` / `validateTurnRequest` / `projectTurnEvents` / `describeAgentTransport` | `wc -l` + `grep -n "^export"` + 逐行读过 |
| `src/agent/registry.js`（46 行）→ `registerAgentTransport` / `getAgentTransportFactory` | `wc -l` + `grep -n "^export"` |
| `src/agent/transport-dsh.js`（58 行）→ `createDshTransport` | `wc -l` + `grep -n "^export"` |
| `src/bridge/mux-runtime.js:33` → `agentTransportOf(deps)`（拿不到工厂就回退旧路径） | `grep -n "agentTransportOf"` |
| `src/bridge.js` 装配处注册 DSH transport（`createDshTransport` / `registerAgentTransport`） | `grep -n "createDshTransport\|registerAgentTransport" src/bridge.js` |
| `src/mcp-snowluma-safe.js`（103 行，stdio MCP） | `wc -l` + 读头部 |
| `src/mcp-snowluma-safe/{http,tools-core,tools-media,tools-memory,tools-social}.js`（291/151/462/173/402 行） | `wc -l` |
| `scripts/setup-dsh.mjs:131` → MCP server 注册（`snowluma`, `toolCallTimeoutMs: 725000`） | `grep -n "mcp-snowluma"` |
| `dsh/agent-presets/qq-chat-v2/{preset.yml,agent.cordis.yml,qq-tool-restrict.mjs}` 与权威实现 `plugins/qq-agent-presets/qq-tool-restrict.mjs` | `ls` + 读首行 |
| `src/bridge/wake-prompts.js`、`src/token-ledger/`、`logs/` | `ls` |
| `config.json` 的 `dsh` 段与 `agentPreset: "qq-chat-v2"` | `node -e "console.log(JSON.stringify(require('./config.json').dsh))"` |
| 40 个 `qq_*` 工具 | `grep -ho "'qq_[a-z_]*'" src/mcp-snowluma-safe/tools-*.js \| sort -u \| wc -l` = 40 |
| `/agent/tools`、`/agent/tool-call`、`x-qdb-token` | `grep -rn` 均**无结果** → 文中标为「计划中」 |
