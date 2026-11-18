# 交接｜上下文连续性真机验收（100000001）

分支 `feat/audio`（已 `git merge main` 到 `5e56089`）。
验收时间：2026-10-26 19:50–20:26。测试群「扣1复活牢大」`100000001`，管理员 `100000006` 发送。
未改线上 `config.json`；只重启过一次桥接做「重启后连续性」测试。

## 一、结论

**它不是没上下文，而是上下文只覆盖 `recentMessages` 最近 100 条（外加当前未读最多 12 条 + 最近 4 条）。**

- 同一轮 3 条普通消息 → 能完整复述；
- 隔 8 分钟 → 能接上刚才的话题；
- 隔 35 分钟（仍在最近 100 条内）→ 仍能完整复述；
- 超过最近 100 条（本次是 4 小时前、已被挤出窗口）→ **不记得，也不会自动去搜历史**；
- 重启桥接后，最近 100 条仍在 `state/social-v2.json`，能复述；
- 高峰时段（09–12 / 14–18）本次窗口已过（20:26），这一项**未执行**。

## 二、验收表

| # | 测试 | 时间 / 原文 | 它的回答 | 判定 |
|---|---|---|---|---|
| 1 | 同轮多消息 | 19:50:57「我明天要去杭州出差，坐早上八点的高铁」<br>19:50:58「我养的那只橘猫叫布丁，最近特别挑食」<br>19:51:00「晚上准备吃番茄牛腩面」<br>19:51:01「@大肥鱼小姐 我刚才说的三件事是什么？」 | 19:51:20「记着呢：明天早八的高铁去杭州出差」<br>19:51:21「布丁那只橘猫最近挑食，晚上吃番茄牛腩面」 | ✅ 3/3 全对；19:51:13 调了 `qq_get_unread_messages` |
| 2 | 跨轮 5–10 分钟 | 20:12:55（距上轮 8 分钟）「@大肥鱼小姐 我们刚才聊的是啥？」 | 20:13:23「你问我认不认识另一个群的哦鲸鲸」<br>20:13:24「我说不认识，你说了句奇怪了，然后说要去拷打DSH」 | ✅ 接上了最近一轮（20:11 的哦鲸鲸/拷打DSH），不是背 A/B/C，但跨轮连续 |
| 3 | 35 分钟同话题 | 20:26:03「@大肥鱼小姐 我刚才说的三件事是什么？」 | 20:26:20「杭州出差早八高铁、布丁挑食、番茄牛腩面」<br>20:26:21「同一题第三遍了…」 | ✅ 距 19:50 已 35 分钟，仍完整复述 |
| 3b | 更长间隔（4 小时旧话题，额外） | 20:14:07「@大肥鱼小姐 还记不记得下午我们聊的 Claude 和贴贴？当时我说了什么？」 | 20:14:29「下午没聊过Claude，也没聊贴贴」<br>20:14:30「这题是设套的吧…」 | ❌ 不记得；且**没有**调 `qq_search_history` / `qq_memory_query`（见 §三） |
| 4 | 重启后 | 20:15:45 重启（PID 91552→94740）<br>20:16:29「@大肥鱼小姐 我刚才说的三件事是什么？」 | 20:16:51「还是那三件：杭州出差早八高铁、布丁挑食、番茄牛腩面」<br>20:16:52「要考新的就直说…」 | ✅ state 落盘，重启后仍能复述 |
| 5 | 高峰时段上下文 | 20:28 临时把 `peakPause.schedule=false` 让峰值立即生效；等到 20:29 没有收到新消息 | — | ⏸ 未完成（消息未到达；已恢复 schedule） |

## 三、3b 失败的原因判断

原始话题确实存在（`state/messages.db`）：

```
16:17:57 535581618  @大肥鱼小姐 可以扮演claude和我聊天吗
16:18:14 BOT        这个不行呀，扮别人我会露馅的，我就是这条鱼
16:18:35 1258389668 @大肥鱼小姐 抱一下
16:18:59 BOT        来抱，今天也辛苦啦
16:19:33 535581618  露馅也没关系
16:19:34 1258389668 贴贴
```

但当时 `state/social-v2.json` 的 `recentMessages` 只剩最近 100 条，最早是 **18:43–18:51**；16:17 的原始消息已被挤出窗口，
当前未读也只有最近 15 条，所以快照里没有。

- 不是 (a) 没入库：DB 里有原文；
- 不是 (d) 会话被重置：同一 session `session-76ea0641-…`，重启后仍能接 A/B/C；
- 是 **(b) 快照截断**（100 条之后）+ **(c) 模型没主动检索**：`tool-calls.jsonl` 里
  `qq_search_history` / `qq_memory_query` 历史总调用数为 **0**，本次也没有尝试查。

> 注意：这次旧话题的发言人是 535581618 / 1258389668，不是管理员本人；问题里「当时我说了什么」有歧义。
> 但「下午没聊过 Claude/贴贴」这个断言本身是错的，且没有查历史，所以仍记为失败；它至少应该先搜再回答。

## 四、参数与容量

线上 `config.socialV2.context`：

```json
{
  "recentLimit": 100,
  "unreadLimit": 30,
  "contextWindow": 20,
  "wakeMessageLimit": 12,
  "wakeRecentLimit": 4,
  "wakeMaxChars": 6000
}
```

实测边界：

- 20:26 时 100 条 recent 的最早时间是 **18:51**，即这个活跃群 **100 条约 1.5 小时**；
- 35 分钟前的 A/B/C 仍在窗口内 → 能记；
- 4 小时前的话题已被挤出 → 不记得；
- 唤醒快照最多 12 条未读 + 4 条 recent；但 agent 可以再调 `qq_get_unread_messages` 补读（本次 19:51 就调了）。

结论：**「能记多久」不是按时间，而是按最近 100 条消息**；群越活跃，记的时长越短。

## 五、峰值时段测试（未执行，给下次的命令）

本次 20:26 已过 14:00–18:00 窗口。20:28 按批准临时把 `socialV2.peakPause.schedule` 设为 `false`
（`/api/peak/status` 显示 `active:true`），准备做第 5 项；但直到 20:29 **群里没有收到任何新消息**
（`messages.db`/`bridge.log` 均无 20:28 后的入站），无法验证。20:29:08 已恢复 `schedule:true`，
`active:false`，PID 仍 `94740`，配置与测试前一致。下一个窗口（工作日 09:00–12:00）按下面做：

1. 确认 `socialV2.peakPause.enabled=true`、`schedule=true`，`/api/peak/status` 的 `inWindow=true`。
2. 在 100000001 连发 3 条普通消息（不 @），再发：
   `@大肥鱼小姐 我刚才说的三件事是什么？`
3. 检查：
   - `state/social-v2.json` 的 `recentMessages` 是否有这 3 条（应入库，峰值只切模型不拦入库）；
   - `state/bridge.log` 是否有 `[峰值]` 放行/模型选择；
   - 回复是否复述 3 条。
4. 若没入库 → 归类 (a)；若入库但没复述 → (b)/(c)。

历史旁证：17:17（高峰窗口内）的图片/普通消息在 `recentMessages` 里，17:17:28 仍能计划唤醒并回复；
说明当前版本「峰值不再拦唤醒」，但那次不是受控的 3 条文本，不能替代正式验收。

## 六、复现命令

```powershell
# 最近消息 / 水位
@'
import fs from "node:fs";
const s = JSON.parse(fs.readFileSync("state/social-v2.json","utf8"));
const st = s.conversations["group:100000001"];
console.log(st.recentMessages.slice(-15).map(m => [new Date(m.time).toLocaleTimeString(), m.isSelf, m.text]));
console.log("recent", st.recentMessages.length, "unread", st.unread.length);
'@ | node --input-type=module

# 工具调用（确认有没有查历史）
Select-String state\tool-calls.jsonl -Pattern 'qq_search_history|qq_memory_query' | Select-Object -Last 10

# 日志
Get-Content state\bridge.log -Encoding utf8 -Tail 80 |
  Select-String '唤醒|模型|工具|繁忙|上下文'

# PID
Get-Content state\bridge.lock
```

## 七、建议

1. **短期**：给唤醒提示加一条硬规则——
   「如果最近消息里找不到用户说的『刚才/之前/上次/下午』，先调 `qq_search_history` 或 `qq_memory_query`，再回答不知道。」
   目前它 0 次调用这两个工具，直接否认，体验最差。
2. **参数**：`recentLimit=100` 对活跃群只有 ~1.5 小时，可提到 200–300（注意 token）；
   `wakeRecentLimit` 4 可提到 6–8；`wakeMessageLimit` 12 保持，配合 `qq_get_unread_messages` 补读；
   `unreadLimit` 30 不要降。
3. **中期**：每日/每几小时把 `recentMessages` 摘要成 3–5 条 `sharedEvents`/记忆，避免只靠 100 条硬窗口；
   或对「上次/之前」类问题做检索增强，而不是让模型硬猜。
4. 峰值时段正式跑一次 §五，再补进本文件。

## 八、限制

- 本次只测了文本；图片上下文另有 `[视觉]` 链路，未在本题范围。
- 跨群不可见：20:11 它明确说「另一个群的我看不见」，上下文按 `group:key` 隔离。
- 重启测试只重启桥接，不重装 DSH；`state/social-v2.json` 保留最近 100 条是这次能复述的原因。
