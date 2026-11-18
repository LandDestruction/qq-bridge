# AI 黑名单（D70）

目的：AI 一多，群里的机器人会互相接话、连续追问，变成「聊天永动机」。这个功能让运维/控制台
手动登记要限制的 **AI QQ 号**，命中后降频或静默，从唤醒源头掐掉互相接话。

## 配置（config.json）

```json
"socialV2": {
  "aiBlacklist": {
    "enabled": true,
    "qq": [{ "id": "123456789", "addedAt": 1793090000000, "note": "别家机器人" }],
    "mode": "reduce",
    "minIntervalMs": 600000,
    "perHourMax": 3,
    "atMeReply": true
  }
}
```

| 键 | 含义 |
|---|---|
| `enabled` | 总开关（默认 false） |
| `qq` | 登记名单；控制台写入时自动带 `addedAt`/`note`，也兼容纯字符串数组 |
| `mode` | `reduce`（默认）：消息照常进上下文，但非 @ 类唤醒不触发；`silent`：连 @ 都不回 |
| `minIntervalMs` | 同一 QQ 两次回复的最小间隔（默认 10 分钟） |
| `perHourMax` | 每自然小时最多回它几次（默认 3，0 表示不限制） |
| `atMeReply` | `true`（默认）时 @ 仍回；`false` 时即使 @ 也不回（优先级高于 reduce） |

## 行为

- 四个唤醒入口统一过闸（`src/bridge.js` 的 `aiBlacklistCheck`）：
  1. 入站触发（`src/bridge/incoming-runtime.js`：@/关键词/概率/拍一拍/指定成员/提问）；
  2. 主动检查（`src/bridge/wake-scheduler.js` 的 `scheduleProactiveCheckV2`）；
  3. 回复回看（同文件 `scheduleReplyCheckV2`：发完言 `autoReplyCheckMs` 后回看一眼）——
     以前这里**不过闸**，机器人回完话回看时又顺着对方 AI 的话接下去，黑名单形同虚设；
     现在 `replyCheck` 归类为 `proactive`，最近说话的是名单里的 AI 就直接跳过这一眼；
  4. prompt 注入侧用 `isAiBlacklisted` 判断（`src/bridge/wake-prompts.js`）。
- 命中时：日志一行 `[AI黑名单] 跳过 qq=<id> why=<at|keyword|probability|proactive|cooldown|hourly-cap>`，
  并把 `ai-blacklist:<why>` 塞进该会话的 `pendingWakeReasons`（只供事后查，**不会被当成积压唤醒重放**）。
- 放行时记录一次「回过这个 QQ」，用来算 `minIntervalMs` 冷却与 `perHourMax` 小时上限。
- 黑名单会话的 prompt 会多一行 `（对方是另一个 AI，别接话头、不要连续追问）`（≤60 字，只在命中时出现）。

## QQ 私聊命令（D73，远程管理）

管理员（`config.json` 的 `ownerQQ`）可以直接私聊机器人发命令，**不经过模型**：

| 命令 | 作用 |
|---|---|
| `/aiban 123456789` 或 `/aiban add 123456789 [备注]` | 加入名单（备注 ≤20 字） |
| `/aiban del 123456789` | 移除 |
| `/aiban list` | 列表（id、备注、加入时间、今日跳过次数） |
| `/aiban on` / `/aiban off` | 总开关 |
| `/aiban mode reduce\|silent` | 切模式 |
| `/aiban` | 帮助 |

中文别名：`加AI黑名单 123456789 [备注]`、`删AI黑名单 123456789`、`黑名单列表`、`黑名单开`、`黑名单关`。
大小写不敏感、多余空格容错；QQ 号按 5~13 位数字校验。

- **只认 ownerQQ**：其他任何人的私聊命令一律静默丢弃（不回、不打日志噪音）；
- 命令在额度/白名单/社交闸**之前**处理，直接回一条 ≤200 字回执后 return，
  **绝不落进 DSH 回合**（管理命令不该花一次模型调用）；
- 写盘复用控制台那套 `createAiBlacklistAdmin`（读盘合并 + 备份 + 热加载），命令层不自己写 config；
- 日志一行：`[AI黑名单] 管理员私聊 add 123456789` / `del …` / `toggle off` / `mode silent`。

## 控制台

- `GET /api/socialV2/ai-blacklist`：`{ ok, enabled, mode, minIntervalMs, perHourMax, atMeReply, qq:[{id,addedAt,note}], stats:{skippedToday,day} }`
- `POST /api/socialV2/ai-blacklist`：`{ action:'add'|'remove'|'toggle', qq?, note?, enabled? }`
- 鉴权：控制台令牌；带 `x-agent-call` / `x-agent-token` 一律 403（和 `/api/affinity` 同口径，智能体不能自己改名单）。
- 写回 `config.json` 走 `updateConfigFile`（读盘再合并，不覆盖别人的修改）+ 备份 `config.json.bak-<时间戳>`（保留最近 5 份），
  写完触发一次热加载；`ops.html` 新增「AI 黑名单」卡片。

## 已知边界

- `skippedToday` 计数在内存里，重启归零（只用于控制台展示，不参与判定）。
- 名单按 QQ 号跨群生效；不按群区分。
- 主动检查用「会话里最近一个非自己的发言人」判定黑名单；没人发过言时放行。
- 首次会话的 bootstrap 引导不受黑名单影响（它只发生一次，且不依赖触发源）。

## 2026-10-30：上下文折叠（黑名单不只管唤醒）

线上出现过「名单开着、机器人还在群里和名单里的 AI 互聊」：黑名单只挡**唤醒**（@/关键词/主动检查/回看），
但真人 @ 一下把模型叫醒后，同一轮上下文里那些 AI 的发言照样被读进来，模型就接着聊。

现在的做法：

- **消息出口折叠**：`/api/socialV2/unread` 与 `/api/socialV2/recent` 带 `x-agent-token`（模型面）时，
  把名单成员的消息摘掉，并在响应里回 `hiddenByBlacklist: N`；控制台/管理员看得到全部（该字段为 0）。
  纯函数 `filterBlacklistedMessages` / `scrubMessagesForModel` 在 `src/bridge/console/social-reads.js`。
- **提示词只给口径**：`aiBlacklistPromptLine` 只要本轮上下文里出现名单成员就提示（不依赖「最新一条是谁」），
  文案明确「已折叠 N 条：不要回复、引用或接他们的话，只回应真人」。
- 判定仍然只看唤醒；折叠只影响模型可见内容，不影响归档、控制台与统计。
