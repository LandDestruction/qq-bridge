# 交接｜高峰期 agent 模式四条链路真机验证（识图 / 摸头 / 语音 / 画画）

分支 `feat/audio`（已 `git merge main` 到 `0e083ba`）。
验证时间：2026-10-26 11:38–11:50（高峰时段 09:00–12:00，agent + `xiaomi-mimo/mimo-v2.6-pro`）。
线上未改代码、未改 `config.json`、未重启桥接；本文件只记录验证结论。

## 一、结论先行：四条链路全部失败，且是**同一个闸门 bug**

> 高峰期放行后，`handleIncoming` 在 `scheduleWakeV2(key, 'peak')` 之后**直接 `return`**，
> 还没走到 `appendSocialV2Message`。消息从未进入 `unread/recentMessages`，8 秒后唤醒时
> `buildWakeSnapshotV2` 读到的快照里没有这条消息（图片也没有），agent 只能回空。
>
> 所以不是工具没了、也不是 MiMo 不支持工具；是**消息根本没交给 agent**。

| 链路 | 测试原文（管理员 100000006 发送） | 期望 | 实际（真机） | 判定 | 归类 |
|---|---|---|---|---|---|
| 1 识图 | 一张图 +「@大肥鱼小姐 这图里是什么？」 | 日志 `[视觉] … 已切到 deepseek-account/deepseek-flash` + 描述图片 | 只看到 `[峰值] 放行 → 已设置会话模型 … -> xiaomi-mimo/mimo-v2.6-pro`，**无** `[视觉]`、无回复；11:45 那条消息在 DB/状态里查不到 | ❌ | (a) 闸门/唤醒前丢消息 |
| 2 摸头/安慰 | 「@大肥鱼小姐 去摸摸 1396911685 的头」 | `qq_send_poke` 或 `qq_send_message` 调用成功 | 11:36 之后 `tool-calls.jsonl` 里 `qq_send_poke` **0 次**；agent 回合「无文本」 | ❌ | (a) |
| 3 发语音 | 「@大肥鱼小姐 用语音说晚安」 | `qq_send_tts` 调用成功 + 发送记录 | 11:36 之后 `qq_send_tts` **0 次**；无语音发送日志 | ❌ | (a) |
| 4 画画 | 「@大肥鱼小姐 画一只猫」 | 先问 free/high → `qq_draw` → `/api/socialV2/draw` → 图片 | 11:36 之后 `qq_draw` **0 次**；`/api/socialV2/draw` 无调用 | ❌ | (a) |

> 由于消息没有入库，无法把每条原文与某一行日志一一对应；但四条都在同一处被丢，
> 上面的「实际」是按 11:36 之后全局证据（DB / 工具调用 / 日志）判定的。

**不是 (b)（模型没切）**：日志明确有
`已设置会话模型 session-2eefae01… (group:100000001) -> xiaomi-mimo/mimo-v2.6-pro (high)`。
**不是 (c)（工具不可用）**：工具都在、且历史调用成功（见 §三）。
**不是 (d)（模型不支持该能力）**：摸头/语音/画画都是文本+工具调用，MiMo 能做；
识图是唯一的能力限制（MiMo 不收图），需要视觉模型兜底，代码本来就有这条兜底（见 §四）。

## 二、真机证据（2026-10-26）

测试消息由管理员号 `100000006` 在群里发送。需要说明：消息没有入库，**无法逐条把原文和日志对上**；
日志里能看到的峰值放行是 `11:45:04`（`group:100000001`）与 `11:46:48 / 11:48:13 / 11:48:44`（`group:100000003`），
无论落在哪个群 / 哪一条，都在同一个 `return` 处被跳过，所以四条能力都无法真正执行。
`state/bridge.log`：

```
11:45:04 [bridge] [峰值] 放行一条到 agent（xiaomi-mimo/mimo-v2.6-pro）
11:45:04 [bridge] [reserved2] 计划唤醒 group:100000001（peak），8s 后发送
11:45:12 [bridge] [reserved2] 唤醒 group:100000001（peak）
11:45:12 [bridge] 已设置会话模型 session-2eefae01-95e4-4267-a21a-809dd9b056e2 (group:100000001) -> xiaomi-mimo/mimo-v2.6-pro (high)
11:45:36 [bridge] [reserved2] group:100000001 未设置唤醒条件，发送提醒 (1/2)
11:45:36 [bridge] 回合完成但无文本 (group:100000001)
11:45:45 [bridge] [reserved2] group:100000001 连续未设置唤醒条件，已重置为默认唤醒配置
11:45:45 [bridge] 回合完成但无文本 (group:100000001)
```

同一时段另外 3 条峰值放行落在 `group:100000003`，但会话正被 11:41 的
`content_filter` + 本地兜底回合占着，唤醒被排队后按「已被当前回合处理」跳过：

```
11:46:48 [峰值] 放行一条到 agent … → 会话繁忙，暂存唤醒原因 group:100000003（peak@seq446）
11:48:13 同上
11:48:44 同上
11:50:24 [reserved2] group:100000003 繁忙期间唤醒 peak@seq446 已被当前回合处理，跳过补发
```

关键反证：**这条消息没有入库**。

```sql
-- state/messages.db：11:45 的测试消息完全不存在（最后一条仍是 11:34:59）
SELECT ts, sender, text FROM messages
WHERE key='group:100000001' ORDER BY ts DESC LIMIT 10;
```

`state/social-v2.json` 的 `recentMessages` 同样停在 11:34:59；但 `lastWakeReason` 已是
`"peak"` —— 说明「唤醒排了、消息没进来」。

## 三、根因（代码位置）

`src/bridge.js`（`feat/audio` @ `0e083ba`）：

```js
15167: if (kind === 'group' && peakPauseActive()) {
15168:   const pa = peakAgentCfg();
15169:   if (pa.enabled) {
...
15174:     log(`[峰值] 放行一条到 agent（${pa.provider}/${pa.model}）`);
15175:     // 正常社交逻辑可能因为「没 @、不是提问、概率没中」而根本不唤醒，
15176:     // 所以这里必须显式排一次唤醒；reason=peak 允许穿过上面的高峰拦截。
15177:     scheduleWakeV2(key, 'peak');
15178:     return;                       // ← 问题在这里：还没 append 就返回
...
15500: appendSocialV2Message(key, sender, textContent, plainContent, ...);  // 永远走不到
```

唤醒 8 秒后由 `buildWakeSnapshotV2()`（`src/bridge.js:13831`）读取 `st.unread/recentMessages`；
因为消息没 append，快照为空 → agent 没有可回应的内容 → `回合完成但无文本`。
图片同理没有进入 `mediaList`，`keyHasRecentMedia()` 为假，`ensureChatModel` 不会走
`[视觉] … 已切到 …` 分支（`src/bridge.js:11451`），所以识图也不会触发视觉模型。

`0e083ba` 的提交说明是「此前放行但不唤醒，等于什么都不做」，这次补了唤醒，但
**用 return 跳过了原来的入库路径**；上线后表现为「高峰期机器人完全不接话 / 工具全消失」。

## 四、修复建议（未直接改线上代码）

推荐（稳妥，避免空消息也排唤醒）：峰值放行时只打标记，不 return；到正常 reserved2 流程
`appendSocialV2Message` **之后**再排唤醒：

```diff
   if (pa.enabled) {
     ...
-    scheduleWakeV2(key, 'peak');
-    return;
+    peakAgentPassed = true;
   } else { ... }
...
   if (currentMode === 'reserved2') {
     appendSocialV2Message(key, sender, textContent, ...);
+    if (peakAgentPassed) {
+      scheduleWakeV2(key, 'peak');
+      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
+      return;
+    }
```

最小改法（一行）：删掉 `15178` 的 `return;`。唤醒已经排好，正常流程会补
`appendSocialV2Message`；8 秒后定时器读快照时就能拿到消息与图片。重复的
`scheduleWakeV2` 会被 `pendingWakeTimer` 合并，不会多叫一次。

修完后预期：
- 识图：`[视觉] 本轮含图，当前模型 xiaomi-mimo/mimo-v2.6-pro 不支持图片，已切到 deepseek-account/deepseek-flash`，然后回答图片内容；
- 摸头：`tool-calls.jsonl` 出现 `qq_send_poke` / `qq_send_message`，群里收到拍一拍/消息；
- 语音：出现 `qq_send_tts`，群里收到语音（QQ 官方 AI 语音只支持群聊，私聊会失败）；
- 画画：先问 free/high，再出现 `qq_draw` 和 `/api/socialV2/draw`，图片发送成功。

## 五、独立能力核查（证明问题不在工具/模型本身）

### 5.1 MiMo 是否支持图片输入：**不支持**

```
node scripts/probe-vision.mjs mimo-v2.6-pro
❌ xiaomi-mimo/mimo-v2.6-pro  115ms
   session/prompt failed: session/attachment-invalid:
   Model "mimo-v2.6-pro" does not support image input.
```

所以高峰识图必须依赖 `dsh.visionModels` 兜底；代码里已有这条兜底，只是这次消息没进 state
所以没触发。兜底模型实测可用：

```
node scripts/probe-vision.mjs deepseek-flash
✅ deepseek-account/deepseek-flash  1689ms  红色
```

### 5.2 三个工具都在、且历史调用成功

`state/tool-calls.jsonl(.1)` 历史计数：

| 工具 | 历史成功调用 |
|---|---|
| `qq_send_poke` | 2 次 |
| `qq_send_tts` | 12 次 |
| `qq_draw` | 26 次 |
| `qq_get_message_images` | 112 次 |

11:36 之后这四类调用都是 **0 次**（`tool-calls.jsonl` 按时间过滤），与「agent 没收到消息」
一致，而不是工具被禁用（`config.socialV2.tools` 里 `sendPoke/sendVoice/getImages/draw` 都是开）。

### 5.3 高峰模型切换正常

`11:45:12` 日志已确认会话被切到 `xiaomi-mimo/mimo-v2.6-pro (high)`，`peakAgentCfg` 生效。

## 六、其它观察（不是本次四条链路的根因）

- `11:41:51 group:100000003`：MiMo 返回 `Provider finish_reason: content_filter`，桥接按设计
  切本地 qwen3:8b 兜底，直到 `11:50:24` 才恢复；期间该群的峰值唤醒全部排队/跳过。
  如果测试在该群进行，会叠加这层干扰。建议测试用 `100000001`（本次 11:45 那条就在这个群）。
- 本地兜底只发文本、没有工具，且人格仍是旧的「有情绪」版本；高峰期 agent 模式下它不应被触发，
  但 content_filter 会把它拉起来。可考虑给 MiMo 的内容过滤失败单独降级到视觉/主模型，而不是本地兜底。

## 七、复现命令

```powershell
# 1) 看峰值放行/唤醒/无文本
Get-Content state\bridge.log -Encoding utf8 -Tail 80 |
  Select-String '峰值|视觉|工具|回合完成|已设置会话模型'

# 2) 证明消息没入库（把时间窗改成测试时间）
@'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("state/messages.db", { readOnly: true });
console.log(db.prepare("SELECT ts,sender,is_self,substr(text,1,80) t FROM messages WHERE key='group:100000001' ORDER BY ts DESC LIMIT 10").all());
'@ | node --input-type=module

# 3) 工具调用（11:36 之后应为 0）
Select-String state\tool-calls.jsonl -Pattern 'qq_send_poke|qq_send_tts|qq_draw|qq_get_message_images' |
  Select-Object -Last 20

# 4) MiMo/视觉能力
node scripts/probe-vision.mjs mimo-v2.6-pro
node scripts/probe-vision.mjs deepseek-flash
```

## 八、需要操作者做的

1. 按 §四 修 `src/bridge.js`（推荐「append 后再 schedule」，或最小删 `return`）。
2. 重启桥接（修复才会生效；当前没有改线上代码）。
3. 重启后按原 4 条重新发一遍（每条间隔 ≥20s，用 `group:100000001`，避开 `100000003` 的遗留繁忙/兜底）。
4. 把新的 `state/bridge.log` + `tool-calls.jsonl` 发我，我按本文件表格补最终 PASS 证据。
