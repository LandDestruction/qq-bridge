# 静默观战（quiet-watch）：偶尔才看一眼群

群友反馈「太吵」时改这里。目标行为：**潜水期只认被点名，被点名后进入在场态正常聊，聊完自然退回潜水。**

## 为什么以前吵

群里每条消息都会过一次触发判定（`src/bridge/wake-admission.js` 的 `evaluateWakeTriggerV2`）：
`@ / 引用自己 / 叫名字 / 关键词 / 提问 / 指定成员 / 概率`。命中就唤醒一次模型。
除它之外还有两条「自己凑上去」的路径：

- `replyCheck`：说完话 30 秒后回看（`scheduleReplyCheckV2`，`socialV2.autoReplyCheckMs`）；
- `proactiveCheck`：定时主动开话题（`scheduleProactiveCheckV2`，`socialV2.proactive`）。

三条叠加起来，热闹的群里表现就是一直在接话。

## 两态模型

| | 触发源 | 是否唤醒 |
|---|---|---|
| **sleeping**（默认，重启即此态） | `atMention` / 引用自己 / `nameMention` / `speaker` / `poke` / `private` / `admin` / `bootstrap` | 放行，并**进入 engaged** |
| sleeping | `keyword` / `question` / `probability` | **吞掉**（只计数） |
| sleeping | `replyCheck` / `proactiveCheck` | **不排**（`allowsTimerWake` 返回 false） |
| engaged（被点名后 6 分钟） | 全部照常 | 放行 |
| 两态都没有 | 每 8–20 分钟一次的「抬眼」 | 有未读时按概率唤醒一次 `glance` |

`engaged` 的续期依据是**自己最后一次发言**（`st.lastAiReplyAt`）：6 分钟没再说话、没人再点名 → 退回 sleeping。
用「最后一条群消息」续期会让热闹群里永远在场，那正是要修的行为。

「抬眼」（`glance`）是给潜水期的一点存在感：看一眼有未读的群，按 `glanceProbability` 决定这次要不要开口；
没决定开口就记一行日志、继续潜水、重排。

## 配置

`config.json` → `socialV2.quiet`（不写就用下面的默认值，写在 `src/bridge/config-load.js:301`）：

```json
{
  "enabled": true,
  "groupsOnly": true,
  "engagedMs": 360000,
  "glanceMinMs": 480000,
  "glanceMaxMs": 1200000,
  "glanceProbability": 0.5
}
```

| 键 | 含义 | 想更安静时 |
|---|---|---|
| `enabled` | 总开关，`false` 完全回到旧行为 | — |
| `groupsOnly` | 只管群；私聊不参与（对方发消息本来就是叫你） | — |
| `engagedMs` | 被点名后在场多久 | 调小到 180000（3 分钟） |
| `glanceMinMs` / `glanceMaxMs` | 抬眼间隔随机区间 | 调到 1800000 / 3600000（半小时到一小时） |
| `glanceProbability` | 抬眼时真开口的概率 | 调到 0.2 |

`hardTriggers` 可以在配置里覆盖（默认见 `QUIET_DEFAULTS.hardTriggers`），一般不用动。

## 日志

```
[静默] group:100000009 被点名（atMention@seq194）→ 在场 6 分钟
[静默] group:100000009 潜水期吞掉一次唤醒（keyword:小鲸鱼），累计 12 次
[静默] group:100000009 在场时间到，退回偶尔看一眼
[抬眼] group:100000009 偶尔看一眼群聊（未读 7 条），唤醒一次模型
[抬眼] group:100000009 看了一眼（未读 3 条），没决定开口，继续潜水
```

吞掉与跳过的日志按会话 60 秒一条限流，避免和「太吵」反过来把日志刷爆。

## 边界

- **bootstrap 仍然每个会话只发一次**（新会话首条消息的引导问候），这是既有行为，不在潜水控制范围内。
- `admin`（控制台手动唤醒）永远放行，运维不受影响。
- 状态只在内存里（`Map`），不进 `state/social-v2.json`；重启回 sleeping。
- 排队中的 `glance` 在繁忙期间会过期，补发阶段按「定时机会已过期」跳过。
- 定时唤醒有两道闸：排的时候（`quietBlocksTimerWake`）和真正发送前（`wake-dispatch` 里再问一次 `allowsTimerWake`）。

## 验证

```bash
node --test scripts/test-quiet-watch.mjs   # 15 例：两态、抬眼、续期、脏配置
node scripts/test-bridge-modules.mjs       # manifest 顺序 + 惰性依赖
node scripts/test-code-size.mjs            # 单文件 ≤800 行 / 单函数 ≤300 行
```

代码：`src/bridge/quiet-watch.js`（唯一实现），接线在 `src/bridge.js` 的 `wireRuntimeModules`、
`src/bridge/incoming-runtime.js` 的唤醒判定、`src/bridge/wake-scheduler.js` 的两处早退、
`src/bridge/wake-dispatch.js` 的发送前复核。
