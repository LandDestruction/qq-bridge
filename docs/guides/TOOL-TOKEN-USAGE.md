# 工具维度 token 消耗（用量页「工具消耗」卡）

> 面向使用者：控制台「用量」页多了一张「工具消耗」卡，回答一个问题——**这些 token 花在哪个工具上了**（发消息？等消息？画图？记忆？）。
> 归因是**按轮均摊的近似**，不是精确到每次工具调用；看趋势、找大头够用，别拿它做账。
> 相邻文档：[TOKEN_USAGE_CONSOLE.md](TOKEN_USAGE_CONSOLE.md)（总账本与花费看板）、[CONVERSATION-FEATURES.md](CONVERSATION-FEATURES.md)（纯净模式：为什么关掉一些能力会省 token）。

## 1. 这是什么

一轮模型调用里，模型可能调 0 个、1 个或好几个工具；工具清单、工具返回、被工具带出的额外轮次都要花 token。
但**账单只在「轮」这一级有数字**——所以这张卡做的是「把每轮的 token 按该轮的工具调用次数分摊到工具头上」，再按天汇总。

卡片可切：今天 / 近 7 天 / 近 30 天 / 全部，可按群筛，可看「工具 / 类别 / 纯对话 / 未归因」四块占比。数据只读本机 `state/` 台账，不联网、不上报。

## 2. 归因口径（先看这节，再看数字）

### 2.1 按「轮」均摊，不按步

- 每轮总 token（prompt / completion / cached）与总花费，取自 token 台账。
- 该轮调了哪些工具、各几次，取自 `state/tool-calls.jsonl` 的 `call` 行（`{"type":"call","turn":N,"step":null,"tool":"mcp__snowluma__qq_mark_read",...}`）。
- 分摊算法：`allocateTurnTokens()`（`src/token-tools.js:88-133`）；整数按调用次数占比切，**余数全给「调用次数降序、工具名升序」的第一个**（`splitInteger`，`src/token-tools.js:61-73`），保证同一份数据每次算出来一样。
- 花费按同比例切到 6 位小数，最后一项吸收舍入误差，保证各工具 cost 之和等于该轮 cost（`splitCost`，`src/token-tools.js:76-86`）。
- `cached` 是 prompt 的子集，单列给人看（`tokensFromBuckets`，`src/token-tools.js:27-33`）；`total` 只加 prompt+completion，不重复计。

**为什么不能按步？** 因为拿不到步号：`state/tool-calls.jsonl` 里 `step` 长期是 `null`（DSH 的 tool/call 帧不带步号），
一个工具调用属于模型第几步、消耗哪几段 token 无从还原。按步归因只能编，按轮均摊是唯一可复现的口径。

### 2.2 三个桶

| 桶 | 含义 | 来源 |
| --- | --- | --- |
| `tools[]` | 分摊到具体工具的 token | 该轮有工具调用 |
| `noTool` | **纯对话**：该轮没调任何工具，整轮 token 都进这里 | `allocateTurnTokens` 的 `!list.length` 分支，`src/token-tools.js:95` |
| `unattr` | **未归因**：分不掉的零头（工具名为空、或各桶相加与整轮对不上）。正常应接近 0；不为 0 会显式报出来（`mismatch`），不静默抹平 | `src/token-tools.js:100-107`、`:189-196`、`:257-262` |

工具名为空（网关没给 `tool` 字段）算「无法归属」，不硬塞给某个工具（`src/token-tools.js:99-100`）；
未登记的 MCP 工具落到 `other` 类别、label 保留原名（`normalizeToolName`，`src/token-tools.js:49-56`，登记表 `:12-21`）。

### 2.3 pureMode / 多模型 / 降级 / 失败

**纯净模式**只少拼上下文、少调工具，归因方式不变，省钱体现在 `total` 变小、`noTool` 占比变高；
**多模型/降级**以 token 台账那一行为准（降级重试算同一轮，调用次数照实累加）；
**失败的调用也算调用**（`failed` 单独计数，`src/token-tools.js:103`），token 照摊——工具跑了、上下文花了。

## 3. 数据落盘：`state/token-tools.json`

> 这是**聚合缓存**，可以删、可以重建；删了不丢原始台账（`state/token-usage.jsonl`、`state/tool-calls.jsonl` 才是源）。

结构（`normalizeToolToolsStore`，`src/token-tools.js:275-296`；落盘文件 `TT_FILE = 'token-tools.json'` 在 `src/bridge/console/token-tools.js:17`，路径 `path.join(STATE_DIR, TT_FILE)` 在 `:35`）：

```jsonc
{ "version": 1,
  "days": { "2026-10-30": {
    "total":  { "turns": 12, "calls": 31, "failed": 0, "tokens": { "prompt": 0, "completion": 0, "cached": 0, "total": 0 }, "cost": 0 },
    "rows":   { "qq_send_message": { "calls": 9, "turns": 9, "failed": 0, "tokens": {}, "cost": 0 } },
    "noTool": { "turns": 3, "tokens": {}, "cost": 0 }, "unattr": { "turns": 0, "tokens": {}, "cost": 0 },
    "byKey":  { "group:<群号>": { /* 同上结构，按会话拆的副本 */ } } } } }
```

| 保证 | 说明 |
| --- | --- |
| 60 天裁剪 | `TOKEN_DAY_LIMIT = 60`（`src/token-tools.js:5`）；只留最近 60 个日期键，且按 `now - 60 天` 再裁一刀防脏键（`:278-288`） |
| `seen` 幂等 | 每轮记 `sessionId:turn` 到 `seen`（`src/bridge/console/token-tools.js:10`、`:217`），DSH 重连 / `turn/end` 重放都不会重复计入；`seen` 同样只留 60 天（`:19`） |
| 重启不丢 | 每天一个桶落盘；启动后接着累加 |
| 历史不回填 | 上线前的工具调用**不会**被追溯算进去，只有上线后的新轮次进卡 |
| 按群副本 | `byKey[key]` 是同一轮按会话拆的副本（`addTurnIntoDay`，`src/token-tools.js:201-212`），切「按群」时读它 |

> 落盘与查询都由 `src/bridge/console/token-tools.js`（`createTokenTools`，`:300-307`）负责，路由在 `src/bridge/console-server.js:499` 分派；行号以当前工作树为准。

## 4. 接口与字段

### 4.1 读：`GET /api/tokens/tools?range=today|7d|30d|all&key=<会话key>|all`

```jsonc
{
  "ok": true, "range": { "from": 0, "to": 0, "days": 3 }, "key": "all",
  "total": { "turns": 0, "calls": 0, "failed": 0, "tokens": { "prompt": 0, "completion": 0, "cached": 0, "total": 0 }, "cost": 0 },
  "noTool": { "turns": 0, "tokens": {}, "cost": 0, "share": 0 },
  "unattr": { "turns": 0, "tokens": {}, "cost": 0, "share": 0 },
  "tools": [ { "id": "qq_send_message", "label": "发消息", "group": "message", "calls": 0, "turns": 0, "failed": 0,
               "tokens": {}, "cost": 0, "share": 0, "avgTokensPerTurn": 0 } ],
  "groups": [ { "group": "message", "groupLabel": "消息", "tokens": {}, "cost": 0, "share": 0 } ],
  "mismatch": null, "note": "…"
}
```

- `tools[]` 按 token 总量降序、同样多按调用数降序（`src/token-tools.js:246`）；`share` 是占总 token 比例（4 位小数，`:235`）。
- `range` 默认 `today`（`src/bridge/console/token-tools.js:205`），非法值回 400（`:266-268`）；`range` 的 `from` 用本地零点算，避免 UTC 把「今天」切成两半（`:44`、`:120-125`）。
- 权限：管理员/控制台令牌可读；**只读访客也可读**（纯聚合数字，无逐轮明细、无本机路径）；agent 令牌 403（`:259-261`）。

### 4.2 写：`POST /api/tokens/tools/rebuild`

`{ "days": 1 }`（重算最近 N 天，默认 1，只接受 1~60，越界 400；`src/bridge/console/token-tools.js:282-286`）。
重建会**清掉该天的桶再用台账+工具日志重算**，`seen` 里属于这些天的标记一并重建（`:160-191`），所以可反复跑、不会翻倍。
只有控制台令牌可用；访客与 agent 一律 403。用途：怀疑缓存与台账对不上时手动重算，正常不用点。

## 5. 怎么验证

```bash
TOKEN=$(cat state/console-token)
# 1) 重建最近 1 天，再取合计（Σ 工具 + noTool + unattr ≈ total）
curl -s -X POST -H "x-console-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"days":1}' http://127.0.0.1:3100/api/tokens/tools/rebuild
curl -s -H "x-console-token: $TOKEN" 'http://127.0.0.1:3100/api/tokens/tools?range=today&key=all'
# 2) 切 7 天：total.turns 单调不减、mismatch 为 null
curl -s -H "x-console-token: $TOKEN" 'http://127.0.0.1:3100/api/tokens/tools?range=7d&key=all'
# 3) 切一个群：该群 turns ≤ 全部，且 tools 里没有别的群的数据
curl -s -H "x-console-token: $TOKEN" 'http://127.0.0.1:3100/api/tokens/tools?range=7d&key=group:<群号>'
```

对账口径：`Σ tools[].tokens.total + noTool.tokens.total + unattr.tokens.total == total.tokens.total`；
不等时 `mismatch` 不为 null —— 先跑 rebuild，再查 `state/tool-calls.jsonl` 有没有缺 `turn` 的旧行。

## 6. 已知限制

1. **均摊是近似**：一轮调 3 个工具各摊 1/3，但真实可能是第一个工具花了 90% 的上下文。看占比趋势可靠，看单工具精确成本不可靠。
2. **轮内多工具无法再拆**：没有步号，任何「第几步调了谁」的还原都是编的。
3. **失败工具也算调用**：`failed` 单独计数，但仍分走 token。
4. **上线前历史不回填**：老会话的工具消耗不会凭空出现。
5. **只统计有台账的轮**：token 台账被清理、或某轮没记 token（异常中断），该轮不进本卡。
6. **按群筛依赖 turn 记账**：极老的 `tool-calls.jsonl` 行没有 `turn` 字段，归不进任何一轮（`scripts/tool-calls-by-turn.mjs` 同样记成 `?`）。

## 7. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 卡片全是 0 | 刚上线还没新轮次；或 `state/token-tools.json` 没生成 | 正常聊几轮再刷新；必要时 `POST /rebuild {days:1}` |
| `unattr` 占比高 | 工具名为空（网关没给 `tool`）、或台账与流水对不上 | 看 `state/tool-calls.jsonl` 有没有 `"tool":""` 的行；跑 rebuild |
| `mismatch` 不为 null | 各桶相加 ≠ 整轮合计 | 跑 rebuild；仍不对以 `total` 为准并报 bug（附 mismatch 数字） |
