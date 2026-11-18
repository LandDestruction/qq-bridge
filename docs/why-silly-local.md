# 为什么显得笨：本地机制量化（D21 / M5-A）

> 只读报告。**没有改 config、没有改 src、没有重启桥接、没有往群里发任何实验消息。**
> 数据来源三类：① 桥接控制台只读接口 `GET /api/debug/prompt-parts`；② DSH 会话日志
> `<本机路径>\.dsh\sessions\--E-deepseek-harness-qq-bridge-src-state-agents--\session-1ec4adc6-…\session.v4.jsonl.zstd`
> （多帧 zstd，逐帧解开后 470 条记录）；③ `state/social-v2.json`、`state/token-usage.jsonl`。
> 每条结论后面都带 `文件:行号` 或「命令 + 输出片段」。

样本：`group:100000001` 的当前 DSH 会话（session-1ec4adc6，preset `qq-chat-v2`），7 个 turn / 81 个 step / 77 次工具调用 / 27 次真实发送。

---

## 一、一次真实唤醒进入模型的东西各有多少字符

### 1.1 唤醒提示本身：3,898 字符（实测接口）

```
$ GET http://127.0.0.1:3100/api/debug/prompt-parts   （只读，带 x-console-token）
{"ok":true,"total":3898,"parts":[{"name":"sticker","chars":1216},{"name":"memory","chars":831},
 {"name":"ttsHint","chars":330},{"name":"timeSense","chars":292},{"name":"preSleep","chars":214},
 {"name":"reply","chars":194},{"name":"mediaAware","chars":192},{"name":"identity","chars":128},
 {"name":"antiAi","chars":120},{"name":"memoryEventHint","chars":119},{"name":"token","chars":77},
 {"name":"proactive","chars":75},{"name":"participation","chars":70},{"name":"role","chars":40}]}
```

这段数字不是估的：装配点在 `src/bridge.js:14466`（`const promptParts = [...]`）把每段
塞进数组，`src/bridge.js:14475` 立刻把 `{name, chars}` 存进 `globalThis.__dshPromptParts`，
接口就是读它（`src/bridge.js:4944`，`GET /api/debug/prompt-parts`）。

注意两点：
- `sticker` 一段就 1,216 字符，占唤醒提示的 **31%**；`memory`(831) + `ttsHint`(330) 再占 30%。
- `role` 只有 **40 字符**——它是 `【当前角色】大肥鱼小姐（完整角色卡请调用 qq_get_prompt 查看）`（`src/bridge.js:14295`）。人格正文**不在**提示里。

### 1.2 但真正的固定开销在提示之外：系统 13.5k + 工具 schema 33k

从会话日志的 `system/message` / `request/header` 直接读：

| 块 | 字符数 | 证据 |
|---|---|---|
| system prompt（DSH 底座 + preset prefix） | **13,522** | session 日志 `system/message`，preset 段起点偏移 115 |
| 工具 schema（47 个工具，JSON） | **32,918** | session 日志 `request/header.data.header.tools`，47 项 |
| 用户消息（黑话表 + 唤醒提示） | **7,445** | 同会话 turn 1（20:51）`user/message`；黑话表约 3,547，唤醒提示占其余（23:52 那次的唤醒提示实测 3,898，见 1.1 —— 两轮不是同一条，量级一致） |
| 工具结果（每 turn 累计） | 1,175 ~ 19,906，全会话 **46,217** | 同会话 `tool/result` 汇总 |

也就是说：**一句话进模型之前，先有 13,522 + 32,918 = 46,440 字符的固定开销**，
而这次唤醒真正跟"聊天"有关的提示只有 3,898 字符 ≈ 固定开销的 **8.4%**。

### 1.3 preset prefix 才是人格/规则的主战场

`dsh/agent-presets/qq-chat-v2/agent.cordis.yml`（29,126 字节 / 221 行）里 `prefix:` 段（第 20–174 行）实测：

```
prefix block lines 20 .. 174 chars 11463
  prefix 不要 = 61     prefix 别 = 31     prefix 必须 = 6     prefix 禁止 = 0
段落标题 38 个，含：【安全规则（最高优先级，不可违反）】【工具协议（最高优先级）】
【等、回与沉睡前观察】【发送与汇报禁令（违反即严重违规）】【别用问号/问好开场】…
```

对比：**规则正文 11,463 字符 / 61 个「不要」/ 31 个「别」**，而人格卡全文 1,379 字符
（`roles/大肥鱼小姐.md` 3,731 字节）。规则:人格 ≈ **8.3 : 1**。

### 1.4 人格卡走的是工具结果，不是提示词

`qq_get_prompt` 的工具结果 9,397 字符，其中 `role.hint` 1,378 字符（≈ 角色卡全文 1,379）。
即：**人格只有在她主动调用 `qq_get_prompt` 的那一轮才进上下文**；不调用就只有 40 字符的
「角色名」提示（`src/bridge.js:14295`）。

---

## 二、最近 50 条机器人发言的质量指标

样本：`state/social-v2.json` 里所有 `isSelf` 消息，按时间倒序取 50 条（跨 5 个会话，时间跨度 119 分钟；
分布：group:100000001 24 条、group:100000003 13 条、group:100000004 9 条、私聊各 2 条）。

| 指标 | 值 | 判读 |
|---|---|---|
| 字数中位数 | **20**（p90 32，均值 20.5） | 一句话的长度 |
| 字数分布 | ≤4 字 1 条 / 5–10 字 4 条 / 11–20 字 22 条 / 21–40 字 23 条 / **>40 字 0 条** | 上限 39 字，从没超过 40 |
| 条数分布 | 单会话 24 / 13 / 9 / 2 / 2 | 集中于两个群 |
| 相邻发言间隔（同会话） | 中位 **30s**，p90 **318s** | 有时一口气几条、有时 5 分钟一句 |
| 近重复率 | 完全相同 **0**；改一字（编辑距离 ≤1）**0** | 不复读，这条可以放心 |
| 问句占比 | **0%** | 全都不提问 |
| 纯表情/纯占位占比 | **0** | 没有拿表情糊弄 |

「短」不是分条切出来的：发送工具参数里的真实文本（27 条）中位 **15** 字、p90 24、max 36、min 6。
而分条规则是「按空格分条」（`src/bridge.js:927`、`:692-694`），并没有 40 字硬切。所以
**是模型自己写得短**，不是被切开。

内部输出 vs 真实发言（同一会话日志）：

```
7 个 turn：reasoning 合计 28,649 字符；真正 output 的 text 合计 1,010 字符 → 28.4 : 1
```

**她想了很多，说出来的不到 1/28。** 这既解释"看着不聪明"（信息没出口），也解释"话短"
（思考全留在 reasoning 里）。

---

## 三、模型与延迟

模型延迟（`assistant/message.time − step/start.time`，**不含工具执行与等待**）：

| 维度 | n | p50 | p90 | max |
|---|---|---|---|---|
| 全部 | 81 | **2,618ms** | **4,036ms** | 6,002ms |
| workbuddy2api/deepseek-v4.1-flash | 72 | 2,664ms | 4,036ms | 6,002ms |
| deepseek-account/deepseek-flash | 9 | 1,748ms | 3,382ms | 3,600ms |
| 20 点 | 11 | 2,933ms | 4,145ms | 6,002ms |
| 22 点 | 47 | 2,618ms | 3,961ms | — |
| 23 点 | 21 | 2,543ms | 3,720ms | 4,111ms |

`state/token-usage.jsonl` 最近 200 条 turn 采样：**workbuddy2api/deepseek-v4.1-flash 181 条、
deepseek-account/deepseek-flash 19 条（90.5% 跑在中转池模型上）**；`retry>0` 只有 2 条。
每 turn 首末采样跨度 p50 5.7s、**p90 320.9s**、max 1,577s。

结论分两半：
- **模型本身不慢**（p90 4 秒，没有超时重试堆积）；
- **用户感到"半天才回"来自设计内的等待**：单个 step 里 `qq_wait_for_messages` 就吃掉 302.7s
  （turn 1 的 stepMs 序列里有 `302726`、turn 3 有 `229142`/`302200`）。这不是模型卡住，是
  「沉睡前观察 5 分钟」这条规则在跑。

---

## 四、截断实证：两个上限都没有真的截断

### 4.1 `initialPromptMaxChars`(2000)：没有可截的东西

实现：`src/bridge.js:1163-1166` 把配置收敛到 [100, 8000]；真正截断在 `src/bridge.js:12639`：

```js
const body = entry.text.length > max ? `${truncateText(entry.text, max)}…（已按上限截断，完整内容见控制台）` : entry.text;
```

但 **`state/initial-prompts.json` 不存在**（`initial-prompts.json 不存在`），即操作者没配任何
初始提示词；而且它只在 `reason === 'bootstrap'` 时注入一次（`src/bridge.js:14417`）。
→ 这条路径对本轮对话的"人格腰斩"没有贡献。

### 4.2 `role.maxInjectChars`(6000)：也没截

- 角色卡 `roles/大肥鱼小姐.md` = **3,731 字节 / 1,379 字符**，远小于 6,000；
- 提示里注入的只有 40 字符角色名（`src/bridge.js:14295`）；
- 完整卡经 `qq_get_prompt` 工具结果进来 = 9,397 字符（`role.hint` 1,378 ≈ 全文）；
- `roleInjectMaxChars` 在代码里只用于控制台告警与统计（`src/bridge.js:502-503`、`:534-539`），
  不是提示词裁剪点。

**被截文本：无。** 想看的「头尾 30 字」不存在，因为一次都没触发。

### 4.3 真正被削的不是人格，是聊天内容

`wakeMaxChars` 6,000（`src/bridge.js:14210`，`bounded('wakeMaxChars', 6000, 500, 20000)`）、
`wakeMessageLimit` 12、`wakeRecentLimit` 4、`contextWindow` 20——这些才是把"聊天现场"
压到 3,898 字符的原因，而固定的系统+工具开销是 46,440 字符（见 1.2）。

---

## 五、逐条假设：支持 / 反对

| 假设 | 结论 | 证据 |
|---|---|---|
| **H1 模型档位**（flash + 中转池、reasoningEffort 比上游低一档） | **部分支持** | 90.5% 采样在 `workbuddy2api/deepseek-v4.1-flash`（token-usage 200 条 181:19）；`config.dsh.reasoningEffort="high"`，而代码默认是 `'max'`（`src/bridge.js:847`）。但延迟 p50 2.6s/p90 4.0s 正常、retry 只 2 条 → **问题在"答得浅"，不在"答得慢/掉线"**；"浅"要等 D20 的上游对照才能定量 |
| **H2 规则淹没** | **强支持** | preset prefix 11,463 字符 / 61 个「不要」/ 31 个「别」 vs 人格正文 1,379 字符（8.3:1）；发言中位 20 字、上限 39 字、问句 0%、且"想 28 字才说 1 字" |
| **H3 触发策略保守** | **部分支持** | 配置：`recommendedProbability 0.05`、`defaultMode diving`、`preSleepWaitMs 300000`、`maxWakePerHour 12`、`batchWindowMs 8000`（`src/bridge.js:973-988`）；7 个 turn 里 2 个完全没有发送（潜水）。但"半天才回"的主因是 `qq_wait_for_messages` 单步 302.7s 的**故意等待**，不是触发概率——两者要分开改 |
| **H4 上下文太窄 / 被工具挤占** | **支持** | 固定开销 13,522(系统) + 32,918(47 个工具 schema) = **46,440 字符**；唤醒提示只有 3,898（8.4%）；每 turn 工具结果 1,175–19,906 字符，全会话 46,217 |
| **H5 记忆与摘要质量** | **部分支持** | 摘要走 `buildDigest` 启发式不调模型（`src/cross-session-memory.js:12`）；`sessionRecycle.maxMessages=600` 到点换会话；实测 `digests` 0 条（重启后未攒够 20 条）→「刚说过就忘」可复现 |
| **H6 人格注入被截** | **反对（实测）** | 没有 initial prompt 文件（`state/initial-prompts.json` 不存在）；角色卡 1,379 字符 << 6,000；提示里只有 40 字符角色名。人格没被腰斩，**而是根本不在提示里**（要走 `qq_get_prompt` 工具结果才进来） |

---

## 六、给下一步的排序建议（不改，只提）

按「影响大 / 改起来便宜 / 可回退」：

1. **先量"短"**——已可量化：中位 20 字、上限 39 字、28:1 的想/说比。改法属于人格与 preset 文案（H2），
   动的是 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`，不碰 src，可回退。
2. **再砍固定开销**——47 个工具 schema 33k 字符是 H4 的大头；按 preset 的 tool-restrict 关掉本轮不用的工具，
   比改 `contextWindow` 更直接。
3. **把"故意等待"和"模型慢"分开看**——302.7s 的 wait 是设计选择（H3），不是故障；要让用户少等，
   动 `preSleepWaitMs`/`recommendedProbability`，别换模型。
4. **H1 留到最后**（换模型加钱、需要用户拍板），而且它解释不了"0 问句、20 字"这种形态。
5. **H6 划掉**，别再花时间查人格截断。

> 待 D20（上游对照）回来后再核对：上游 `config.example.json` 的 `reasoningEffort=max`、默认触发概率、
> 工具面大小，才是"本地越改越笨"那部分的定量证据。
