# 跨会话记忆：无数据时的降级自证 + 真机验证

目标：**没有「两个群各 20 条消息」这种数据，也能判断跨会话记忆链路是通的**；有数据时能说清
「为什么没注入」。全程只读，不碰 `state/`、不改 `config.json`、不触发摘要生成。

对应任务：T3。脚本：`scripts/probe-cross-session.mjs`。单测：`scripts/test-cross-session-memory.mjs`（已有，7 项纯函数断言）。

---

## 0. 链路事实（读码结论，改代码前先对一遍）

| 项 | 事实 | 位置 |
|---|---|---|
| 摘要结构 | `{ key, at, summary, topics, people }`，`summary` ≤ `maxChars`(200) | `src/cross-session-memory.js:12` |
| 触发阈值 | **每 N 条入站消息**刷一次（默认 20，最小 5），每会话独立计数 | `src/bridge.js:3636`（`maybeRefreshDigest`） |
| 触发点 | 每条入站消息收尾时调一次 | `src/bridge.js:13745` |
| 计数存放 | 进程内 `Map`（`digestCounters`）——**重启清零** | `src/bridge.js:3635` |
| 内存存放 | `socialV2.digests[key]` | `src/bridge.js:3647` |
| 存储文件 | `state/social-v2.json`（`loadMemoryLayers` 会读 `raw.digests`） | `src/bridge.js:12221` |
| **落盘** | `saveSocialV2State()` 用 `digestSnapshot()` 落盘 `digests`（T12 修复；此前漏写，摘要重启即丢） | `src/bridge.js:12378`、`src/cross-session-memory.js:50` |
| 注入条件 | 开关非 `false` · 排除当前会话 · 必须在白名单（`allow.groups/allow.private`）· `now - at ≤ 24h` · 按 `at` 倒序取前 3 | `src/bridge.js:14230` |
| 注入裁剪 | 每会话 120 字、整块 600 字，带隐私边界句 | `src/cross-session-memory.js:51` |
| 注入位置 | 唤醒 prompt（`buildWakePromptV2`）——只在被唤醒的那一轮出现 | `src/bridge.js:14230` |

两个必须知道的后果：

1. **观察群不注入**：不在 `allow` 里的群，摘要**不会**进 prompt（隐私边界，故意如此）。
2. **计数重启清零**：`digestCounters` 在内存里，重启后要重新攒 20 条才会再刷一次摘要。
   摘要本身自 T12 起会落盘，重载后 24h 内仍可注入；但「刚重启、之前只攒了 19 条」仍然刷不出来。

---

## 1. 无数据时的降级自证（30 秒，随时可跑）

### 1.1 一条命令自证脚本本身没问题

```powershell
cd <本机路径>\qq-bot-worktrees\w3
node scripts/probe-cross-session.mjs --selftest
```

它在**系统临时目录**里造六种情形并断言（跑完自动删）：

| 情形 | 断言 |
|---|---|
| 没有 `state/social-v2.json` | 跑通、不抛错、不注入、给出「当前无可用摘要」 |
| 有 state、`digests` 为空、某群 7 条消息 | 结论可读；进度里能看到「7 条 / 无摘要」；点明摘要不落盘 |
| 有摘要（白名单内 / 过期 / 非白名单 / 当前会话自身） | 只注入白名单内 24h 内的**其它**会话；过期与非白名单被标出；块带隐私边界、≤600 字 |
| 磁盘带 `digests` | 不误报「不落盘」 |
| `crossSession.enabled = false` | 不注入并说明开关关着 |
| 没有 `config.json` / state 是坏 JSON | 不炸，白名单按空处理并说明 |

另外在情形三断言**跑完 state 文件 sha256 不变、state 目录没多文件**——「只读」不是口头承诺。

期望输出：每个 ✅，末尾 `🎉 跨会话探针自测通过（六种情形…）`，退出码 0。

### 1.2 看真实环境现在会注入什么

```powershell
# 本工作树（没有 state/config 也能跑，会明确说「读不到、白名单为空」）
node scripts/probe-cross-session.mjs

# 线上主仓库（只读），并假设「现在在某个群说话」
node scripts/probe-cross-session.mjs `
  --state <本机路径>\deepseek-harness\qq-bridge-src\state `
  --config <本机路径>\deepseek-harness\qq-bridge-src\config.json `
  --current group:100000003
```

读四个东西并分别报：摘要条数 / 每条的年龄与白名单状态 / 各会话消息进度 / 当前会话最终会注入哪几条。
`--json` 给机器读（`digestsPersistedOnDisk`、`injections[].keys`、`conclusions`）。

### 1.3 手工造数据（不用真群 20 条）

想验证 24h 衰减、白名单过滤这类逻辑，不用等真消息——把 `--state` 指向临时目录，
自己写一份 `social-v2.json`（**只写临时目录**）：

```powershell
$tmp = Join-Path $env:TEMP 'w3-cross-session-manual'
New-Item -ItemType Directory -Force -Path (Join-Path $tmp 'state') | Out-Null
@{
  conversations = @{ 'group:111' = @{ recentMessages = @(@{plain='x'}) } }
  digests = @{
    'group:222' = @{ key='group:222'; at=(Get-Date).ToUniversalTime().ToUnixTimeMilliseconds() - 3600000; summary='丙：新显卡到了' }
    'group:444' = @{ key='group:444'; at=(Get-Date).ToUniversalTime().ToUnixTimeMilliseconds() - 90000000; summary='旧摘要' }
  }
} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $tmp 'state\social-v2.json') -Encoding utf8
@{
  allow = @{ groups = @(111,222); private = @() }
} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $tmp 'config.json') -Encoding utf8
node scripts/probe-cross-session.mjs --state $tmp\state --config $tmp\config.json --current group:111
```

期望：`group:222`（白名单、1 小时内）出现在「注入判定」；`group:444`（25 小时）标「已过期」且不注入。

> `--now <ISO 时间>` 可以把「现在」固定住，方便复现 24h 边界。

---

## 2. 真机验证（有数据时，A 群问 B 群）

前提（缺一不可，先跑 1.2 确认）：

- 两个**都在白名单**的群，各自**连续收到 ≥20 条入站消息**（中途没重启桥接）；
- 最后一次刷新在 **24 小时内**；
- 桥接进程从攒够消息之后**没有重启过**。

步骤：

1. 在 A 群（例如 100000003）聊出 20+ 条，最后一条有明显话题锚点（如「我们约了周五打 R6」）。
2. 在 B 群（例如 100000001）发：`你记不记得隔壁群那帮人约了什么时候打 R6？`
3. 看她是否答得出「周五 / 打 R6」。

**通过**：答出 A 群的话题锚点，且不主动抖 A 群里的人名细节（隐私边界）。
**不通过**：先跑 1.2 看是「没摘要」「摘要过期」还是「A 群不在白名单」，再动别的。

反向验证（隐私边界）：在 A 群说一句只有 A 群该知道的具体人名，然后去 B 群问「隔壁群那个谁叫什么」，
她应当知道有这回事但不主动报名字。

---

## 3. 现象 → 原因 对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| 探针「摘要 0 条」+「磁盘没有 digests 字段」 | 这份 state 是旧版写的（旧版不落盘摘要），或桥接还没刷过摘要 | 跑够 20 条触发一次刷新；T12 之后的新保存会带上 `digests` |
| 探针有摘要、但「已过期」 | 超过 24h | 群里聊几句触发新刷新 |
| 探针「非白名单」 | 该群不在 `allow.groups` | 要服务就加白名单（改配置属主窗口，不在施工位职权内） |
| 有摘要但都「非白名单」→ 不注入 | 观察群本来就只读不注入 | 预期行为 |
| 探针显示会注入，真机却不提 | 那一轮没被唤醒 / prompt 被截断 | 看 `state/bridge.log` 该轮唤醒原因 |
| 刚启动就测 | 计数清零，需重新攒 20 条 | 等消息，或直接看探针（1.2） |

---

## 4. 已知限制（写给将来改代码的人）

1. ~~`saveSocialV2State()` 不写 `digests`~~：**T12 已修**（`digestSnapshot()` 落盘、`normalizeDigests()` 重载归一）。
   落盘时会把 >24h 的旧摘要丢掉（它们本来就进不了 prompt），最多留 50 个会话，避免 state 文件被历史会话撑大。
2. `digestCounters` 在内存里，重启归零；「20 条」是**入站消息条数**，不是「会话参与轮次」。
3. 注入只在唤醒 prompt 里发生，**不是每轮都注入**；沉睡期间不更新。
4. 摘要只存「谁：说了什么」的短句（最近 10 条），**不存原文**；细节要靠 `qq_search_history` 查。
5. 白名单里的私聊也会作为「其它会话近况」被注入到群里（`renderDigestBlock` 只写「私聊」不写 QQ 号），
   这是现设计；觉得太松需要改 `pickDigests` 的 allow 粒度。

---

## 5. 验收清单

- [ ] `node scripts/probe-cross-session.mjs --selftest` 全 ✅、退出码 0（13 项断言）
- [ ] `node scripts/probe-cross-session.mjs` 在**没有** state/config 的工作树里跑通，结论含「当前无可用摘要，需要两群各 >=20 条消息」
- [ ] 指向线上 `--state/--config` 只读跑通，且 `state/social-v2.json` 的 mtime/sha256 未变
- [ ] `node scripts/test-cross-session-memory.mjs` 15/15（含「写盘→重载→摘要仍在」往返与 bridge 接线断言）
- [ ] 真机：A 群 20+ 条后，B 群能问出 A 群话题锚点（可选，需要用户配合）
