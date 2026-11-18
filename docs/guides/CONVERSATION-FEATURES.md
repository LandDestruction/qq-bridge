# 会话功能：私聊加好友提示 / 纯净模式 / @ 命令

> 状态：✅ 2026-10-30 已上线（三节都按「现在就能用」的口径写）。
> 行号按当日工作树核对；改了代码后行号可能整体位移，**以函数名为准**，别只认数字。
> 素材库相关功能见 [BOOTH-LIBRARY-GUIDE.md](../BOOTH-LIBRARY-GUIDE.md)；安装与配置速查见 [系统介绍.md](../系统介绍.md)。

---

## 1. 私聊攒句数提示加好友

### 现象

对方**不是你 QQ 好友**时，QQ 只有「临时会话」：机器人能发**文字**，但发**表情/图片**会被服务端直接拒掉（错误码 `OIDB 170019003`）。
表现就是：群里聊得好好的，一进私聊机器人突然只会打纯文字，表情和图片全不见——不是桥接坏了，是 QQ 侧的临时会话限制。

### 机制

- 计数对象：**机器人发出的私聊文本条数**，按会话 key（`private:<QQ号>`）分别计。
- 到达阈值（默认第 **15** 条）时，**在该条消息末尾追加一句**提示，不单独多发一条，避免刷屏；提示后计数归零，要再攒够 15 句才有下一次。冷却（默认 **24 小时**）从上次提示时间算起，冷却没过的期间只是不提示，条数照常累加。
- 群聊不参与；重启后计数清零（只存在内存里，不影响正常聊天）。
- 提示文案只提「加好友之后能发表情和图片」，不暴露任何内部信息。

代码位置：

- 计数与追加：`src/bridge.js:1888-1907` —— `sendToQQWithPrivateHint` 包住发送函数：1890 `const privateHintState = new Map();`（内存表）、1896-1900 计数与冷却判定、1902 `out = \`${original}\n${privateHintText()}\``（**同一条消息末尾**追加）、1903 日志 `[私聊提示] 已提示加好友 … 第 N 条`、1906 兜底 catch（判定失败只记日志，绝不阻塞发送）。
- 纯规则：`src/private-hint.js` —— 默认值 8-12（`afterMessages: 15`、`cooldownMs: 24h`、`enabled: true`）、文案 14、`shouldAddFriendHint` 38-49（未攒够 / 冷却中 → 不提示）、`nextHintState` 53-58（提示后归零、记录本次时间）。

### 配置项与范围

| 配置 | 默认 | 范围（越界会被夹紧） | 说明 |
|---|---|---|---|
| `socialV2.private.addFriendHint.enabled` | `true` | 布尔 | 总开关 |
| `socialV2.private.addFriendHint.afterMessages` | `15` | **5 ~ 200** 条 | 攒够多少条私聊文本后提示 |
| `socialV2.private.addFriendHint.cooldownMs` | `86400000`（24h） | **1h ~ 30d**（毫秒） | 两次提示的最小间隔 |

夹紧在加载配置时做：`src/bridge/config-load.js:86-93`（`normalizePrivateHint`，`clampInt` 到 5~200 / 3600000~2592000000）。
设置页：**设置 → 对话白名单 → 私聊**（`client/05-settings.js:2892-2910`，渲染 `攒够句数后提示加好友`、条数输入框（范围 5~200）、冷却输入框（范围 1~720 **小时**，保存时换算成毫秒）），保存走 `POST /api/config`（patch 键名同上表；绑定见 `client/05-settings.js:2963-2985`）。

### 怎么验证

1. 看配置是否生效：
   ```bash
   curl -s -H "x-console-token: $(cat state/console-token)" http://127.0.0.1:3100/api/config | grep -A3 addFriendHint
   ```
2. 用**非好友** QQ 私聊机器人，连发 15 条短文本；第 15 条（且冷却已过）的回复末尾应多出一句加好友提示。
3. 翻日志确认：
   ```bash
   grep "\[私聊提示\]" state/bridge.log | tail -3
   # [私聊提示] 已提示加好友 private:100000000 第 15 条
   ```
4. 临时想快速看到效果，可把 `afterMessages` 调到 5、冷却调到 1 小时（设置页或 `POST /api/config`），验完再调回。

### 已知限制

- 只统计**文本**发送路径；图片/语音/表情走别的发送接口，不计入这 15 条。
- 计数在内存，重启桥接后从 0 开始（冷却时间也从 0 重算）——这是有意为之，不写 `state/`。
- 提示只在「临时会话」场景有用；对方已经是好友时它也会按条数触发（文案仍成立，但没实际必要），想彻底关掉就把 `enabled` 设为 `false`。
- 提示是**追加在正文末尾**，如果那条消息本身很长，提示会被挤到最末一段，不会被单独强调。

---

## 2. 纯净模式（极致省 token）

### 现象

正常一轮的唤醒提示词里，除了人设和规则，还会塞记忆摘要、群友印象、黑话、表情库、交接摘要、长历史引用、媒体感知等段落——信息全，但**每轮都贵**。想压成本时，需要一个「只留必要内容」的开关。

### 机制

打开 `socialV2.pureMode.enabled` 后：

- **取数阶段就短路**（不是先算出来再丢掉）：记忆上下文、跨会话记忆、表情库与表情策略、交接/开场白、长历史引用、媒体感知、记忆事件提示，这些数据源直接不查询、不拼装（`src/bridge/wake-prompts.js:252` 起，`pureOn ? '' : …` 的分支：267 记忆事件、275 跨会话、298 记忆正文、342 表情、398 开场白、402 交接、412 媒体感知）。
- 拼装完成后再按段落名统一过滤一遍，并在提示词第一行加 `【纯净模式】` 说明（`src/bridge/wake-prompts.js:461-468`，`pureApplied = pureOn && deps.applyPureMode(...)`）。
- **每轮步数上限生效值降为 6**（只改内存里的 `cfg.socialV2.turnMaxSteps`，**不改 `config.json`**；`src/bridge/config-load.js:481-486`）。控制台 `GET /api/config` 展示的也是 6，落盘值仍是配置值（`src/bridge/console/config-admin.js:486-492`）。
- 热加载：开关走普通配置热重载，不需要重启桥接。

保留 / 省掉（`src/pure-mode.js:7-24`）：

| 保留 | 省掉 |
|---|---|
| 人设与角色卡、安全与必要规则、画图能力、发送节奏、token 与 hostTool 段 | 记忆上下文、跨会话记忆、表情库与表情策略、交接/开场白、长历史引用、媒体感知、记忆事件提示 |

### 配置项与范围

| 配置 | 默认 | 说明 |
|---|---|---|
| `socialV2.pureMode.enabled` | `false` | 只认严格布尔 `true`（写字符串 `"true"` 不生效，`src/bridge/config-load.js:96-99`） |
| `socialV2.turnMaxSteps` | 配置值 | 纯净模式开着时**运行期**被压到 6（`src/pure-mode.js:26` `PURE_MODE_TURN_MAX_STEPS`；实际取步数在 `src/bridge/mux-runtime.js:16`） |

设置页：**设置 → 模型与思考 → 纯净模式**（`client/05-settings.js:2911-2933`），开关 + 三行说明（省掉什么 / 保留什么 / 步数上限 6）+ 一行「当前提示词约 N 字（比上次少 N 字）」（`client/05-settings.js:2934-2962` 拉 `/api/debug/prompt-parts`；保存开关在 2985）。

### 怎么验证

1. 拿一个真实会话 key（`group:<群号>` 或 `private:<QQ号>`），量开启前后的提示词体积：
   ```bash
   TOKEN=$(cat state/console-token)
   curl -s -H "x-console-token: $TOKEN" \
     "http://127.0.0.1:3100/api/debug/prompt-parts?key=group:100000002"
   ```
   返回 `{ok,key,mode:"live",total,parts:[{name,chars}…],excluded:["initialPrompt","handoff"],hint:{…}}`；`parts` 已按字符数从大到小排序、只列非空段（`src/bridge/console/operations.js:237-301`）。纯净模式开着时 `parts` 里会多一段 `pureMode`。
2. 实测参考（同一会话，开关前后各一次）：**开 5721 字符 → 关 1955 字符，省 66%**；`parts` 从 18 段降到 14 段，多出的 `pureMode` 段约 35 字符。（数字随会话内容浮动，以你自己量到的为准。）
3. 设置页的「当前提示词约 N 字 / 比上次少 N 字」同源，就是上面这个接口。
4. 验证步数上限：开纯净模式后 `GET /api/config` 里 `socialV2.turnMaxSteps` 返回 6；`config.json` 文件内容不变。

### 已知限制

- 省的是**上下文与本轮附加查询**，不改模型、不改人设、不改安全规则；关掉后立即恢复，不需要重启。
- 记忆类功能仍会照常写入 `state/`（只是不注入提示词），不会因为开纯净模式丢数据。
- `prompt-parts` 只回**段落名 + 字符数**，不回正文（正文含会话令牌/人设，接口有意不外带）。
- 只有真实收过消息的会话才有 `parts`；`mode:"none"` 表示这个 key 没有会话状态（key 写错或从没消息）。

---

## 3. `@机器人 /persona …` 命令

### 现象

换人设以前要进控制台操作。现在在群里/私聊里说一句就能换：既支持普通命令 `/persona 猫娘`，也支持带上 @ 的写法 `@机器人 /persona 猫娘`（很多人习惯先 @ 再说）。

### 机制

- 入站消息**第一步**就解析（在唤醒评估之前，`src/bridge/incoming-runtime.js:47-66`）：只有当消息**@ 到了机器人自己**、且 @ 之后第一个 token 就是 `/persona` 时才算命中。
- 命中后：剥掉 @ 与 @ 那段文本，把 `/persona …` **原样**转交给模型运行时（`src/bridge/incoming-runtime.js:62-63` 用 `strippedText` 替换消息正文），由 DSH 的命令处理改人设。
- **只给命令、不带参数** → 回一句用法提示，**不发给模型、不唤醒**（`src/bridge/incoming-runtime.js:58-60` 调 `personaUsageHint()`）。
- 以下都不触发：@ 的是别人、正文里顺口提到 `/persona`、`/personasync` 这类前缀不同的词（正则 `PERSONA_RE = /^\/(persona)(?=$|\s)/i` 要求命令后是行尾或空格）。
- 日志：`[命令] 群/私聊 @ 触发的 persona 命令已转交：arg=…`。

代码位置：纯规则 `src/mention-command.js`（正则 8-10、`parseMentionCommand` 63-95、用法提示 97-99 = 「换人设直接发 `/persona 你是一只猫娘`（不用 @ 我）；恢复发 `/persona off`。」）；接线 `src/bridge/incoming-runtime.js:47-66`；依赖注入 `src/bridge.js:1863-1868`。

### 配置项与范围

不需要配置——解析是入站固定逻辑，没有开关，也不会改 `config.json`。
（人设本身由 DSH 的 `/persona` 命令处理：`src/bridge/incoming-runtime.js:62-63` 把命令透传，桥接不解析人设内容。）

### 怎么验证

1. 群里发：`@机器人 /persona 你是一只猫娘` → 机器人下一次回复应带猫娘口吻；日志出现：
   ```bash
   grep "\[命令\].*persona" state/bridge.log | tail -3
   # [命令] 群 @ 触发的 persona 命令已转交：arg=你是一只猫娘
   ```
2. 只发 `@机器人 /persona`（不带参数）→ 立刻回一句用法提示，且**没有**模型调用（令牌看板里本轮不增加）。
3. 反例：`@别人 /persona …`、正文里写「/persona 是啥」→ 不触发，消息按普通聊天处理。
4. 恢复默认：`/persona off`。

### 已知限制

- 回复开头**不会自动 @ 对方**：桥接发送层没有 at 能力，命令的回复是普通文本。
- 必须 @ 到机器人（或 @ 它的显示名）才触发；纯文本 `/persona xxx` 不带 @ 时按普通消息交给模型（DSH 侧仍可能识别为命令，取决于运行时）。
- 命令只转交，不改桥接侧的任何配置；人设是否真正切换以 DSH 侧为准。
