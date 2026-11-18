# 上游对照：`Derpyu520/qq-bridge` vs 本地（M5-B / D22）

> 只读 clone 于 `<本机路径>\_upstream-qq-bridge`，HEAD `a49877f`
> （`chore: probe-tools 跑完自清理工作区与临时目录`，156 文件）。
> **不提交进任何仓库、不进包**；本文件只写结论与复现命令。
> 数据取自 2026-10-26 23:5x 的本地 `config.json` 与 `state/current-role.json` 快照。
> 配套规格：`M5-why-silly-spec.md` §3 的「D20 上游对照」；本地量化由 D21（w3）负责，本文件不重复。

## 0. 一句话结论

**上游靠「思考强度 max + 15.6KB 小鲸鱼人设 + 明确允许装傻/已读乱回 + 28 个工具」显得不傻；
本地把这四项分别改成了 high、3.7KB 大肥鱼小姐、禁止对正常提问反骨、37 个工具。**
另外本地**没有任何一项触发/上下文/发送阈值比上游更保守**——H3/H4 里「本地改保守了」这一半不成立。

## 1. ① config 逐项对照

比对源：上游 `config.example.json`（7,728 B）与本地 `<本机路径>\qq-bridge-src\config.json`。

### 1.1 完全一致的项（27 项，全部是「人味/触发」相关的阈值）

| 项 | 值（两侧相同） |
|---|---|
| `social.triggerProbability` / `contextWindow` / `proactiveProbability` / `maxReplyChars` / `mustReplyKeywords`(6) | 0.1 / 20 / 0.2 / 500 / 同 |
| `socialV2.context.recentLimit` / `unreadLimit` / `contextWindow` / `wakeMessageLimit` / `wakeRecentLimit` / `wakeMaxChars` | 100 / 30 / 20 / 12 / 4 / 6000 |
| `socialV2.wake.defaultMode` / `preSleepWaitMs` / `recommendedProbability` / `maxWakePerHour` / `batchWindowMs` / `sleepMinMs` / `staleChatMinutes` | diving / 300000 / 0.05 / 12 / 8000 / 60000 / 10 |
| `socialV2.send.burstEnabled` / `maxSendPerMinute` / `maxSendPerHour` / `maxMessageChars` / `maxGapMs` / `gapBaseMs` | true / 8 / 60 / 500 / 10000 / 800 |
| `socialV2.initialPromptMaxChars` / `role.maxInjectChars` | 2000 / 6000 |

**判定：零项「本地更保守」。** H3（触发太保守）与 H4（上下文太窄）描述的现象如果存在，那是**上游默认就这样**，
不是本地改坏的；要动它们属于「改上游默认值」，属于用户拍板范围，不是「回滚本地改动」。

### 1.2 有差异的项（9 项）

| 项 | 上游 | 本地 | 判定 |
|---|---|---|---|
| `dsh.provider` | **`deepseek-official`** | **`workbuddy2api`** | **本地更弱**：官方池 → 中转池（README/交接记为「已知会 503/挂起」的那条链） |
| `dsh.model` | `deepseek-flash` | `deepseek-v4.1-flash` | **本地更弱/更抖**：走中转池，且见 A/B 证据（30/40 轮跑该档） |
| `dsh.reasoningEffort` | **`max`** | **`high`** | **本地更弱（唯一直接降智项）**：README L83 明说默认 `max`，可选 high/low |
| `dsh.modelFallbacks` | （无此键） | 5 条，前两位 `workbuddy2api` | 本地多一条「死模型兜底链」，兜底先落到同款中转池 |
| `socialV2.modelRouting` | （无） | `idle = workbuddy2api/deepseek-v4.1-flash` | 本地新增：**空闲档强制走中转** |
| `socialV2.modelForMedia` | （无） | `deepseek-account/deepseek-flash` | 本地新增（看图档），与「笨」无直接关系 |
| `socialV2.sessionRecycle` | （无） | `maxMessages 600` / `maxAgeHours 48` | **本地新增：到点换会话 → 表现为「刚说过就忘」** |
| `socialV2.tools` 开启数 | **28**（共 30 键） | **37**（共 38 键） | **本地多 9 个工具 schema**：`draw` `memoryEvent` `recall` `searchHistory` `sendImage` `setPersona` `stickerAutoDescribe` `tts`（上游缺键）+ `sendVoice`（上游 `false`） |
| `socialV2.peakPause.enabled` / `localFallback.enabled` | （无） | true / true | 本地新增，与「笨」无直接关系 |
| `fileArchive.*` / `observe.enabled` | （无） | true | 本地新增功能，与「笨」无直接关系 |

工具面 +9 的代价不是功能，而是**每一次唤醒都要把这些工具的 schema 塞进上下文**（H4 的「有效对话占比被挤掉」多半来自这里，而不是 `contextWindow`）。

## 2. ② roles/ 角色卡对照

| | 上游 | 本地 |
|---|---|---|
| 卡片数 | **2 张** + README | **4 张** + README |
| 主打卡 | `小鲸鱼.md` **15,640 B / 182 行** | `小鲸鱼.md` 15,458 B / **69 行**（同体量、行长得多） |
| 当前**激活**卡 | — | **`大肥鱼小姐.md` 3,731 B / 13 行**（`state/current-role.json` = `{"role":"大肥鱼小姐","mode":"active"}`） |
| 其它 | `傲娇助手.md` 504 B | `绫.md` 9,490 B / 11 行、`肉便器.md` 9,489 B / 10 行、`傲娇助手.md` 497 B |

`qq-chat-v2` 的对应物是 `dsh/agent-presets/qq-chat-v2/`（不是 roles/）：

| 文件 | 上游 | 本地 |
|---|---|---|
| `preset.yml` | 199 B | 199 B |
| `agent.cordis.yml` | 24,675 B / 194 行 | **29,126 B / 78 行** |
| `qq-tool-restrict.mjs` | 538 B | 538 B |

**判定：本地激活的人设只有上游主打卡的 1/4.2（3,731 B vs 15,640 B）。**
本地其实也放着与上游同体量的小鲸鱼卡，但**没在用**——这是本次对照里体量差最大的单点。

注意：`role.maxInjectChars` 两侧都是 6000（`src/bridge.js:465` 的注释说代码默认其实是 8000，
理由是「小鲸鱼卡补了形象/圈层/白饭-token/开发事件梗，6000 会把…」）。
激活的 3,731 B 卡远低于上限、不会被截；但**一旦切回小鲸鱼卡（15,458 B ≈ 5.9k 字符），就会贴着 6000 上限**——
是否真的被腰斩由 D21 的截断实测回答，这里不下结论。

## 3. ③ preset/prefix 对照

| 指标 | 上游 | 本地 | 差 |
|---|---|---|---|
| `presets/qq-chat-v2.patch.yml` | 23,361 B / 67 行 | 27,846 B / 44 行 | +4,485 B（+19.2%），**行数更少＝单行更长** |
| prefix 正文字符数 | 10,327 | 12,064 | +1,737（+16.8%） |
| 规则词（不要/禁止/必须/严禁/不许/务必/不得） | 61 | 67 | +6 |
| `【】` 小标题数 | 40 | 45 | +5 |

### 3.1 被本地**改写**的段落（上游有、语义被反转）

- 上游 `【反 AI 味：拒绝有求必应】`（410 字符）→ 本地换成
  `【反 AI 味：保留个性，但别把正常提问当挑衅】`（483 字符）+ 新增
  `【什么时候不反骨（照这个优先级）】`（294 字符，带正例/反例，明确写「别把正常请求当调戏，抬杠」）。

上游原文（摘）：*「你不是客服…别人要推荐、要答案、要帮忙时，你不一定马上给；可以先装傻、打岔、阴阳、拒绝，
或者给一个离谱/没用的答案」「允许『装唐装傻』和『已读乱回』：把『来点推荐』理解成『退钱吗』…都比立刻认真推荐更像真人」。*

本地改后要求：*「只有对方在玩梗、调戏、挑衅、逗你时，才可以反骨…普通提问、求助、认真问事、要推荐、情绪低落时，
正常回答…不要为了『反 AI 味』抬杠、阴阳、拒绝或故意给错答案。」*

**这是方向性反转，不是措辞微调**：上游把「装傻/乱回」当人格底色，本地把它降级为「只在被逗时许可」的行为。

### 3.2 本地**独有**的段落（上游没有）

| 段落 | 字符数 | 内容一句话 |
|---|---|---|
| `【绫（自带角色卡 · 健康版，仅当对方选「自带绫」时按此扮演）】` | 1,608 | 一张完整的角色扮演卡，塞在 prefix 里 |
| `【你自己输入一个角色】` | 627 | 自定义人设的收集与落库规则 |
| `【私聊角色扮演（仅 private 会话，二选一）】` | 98 | 私聊 RP 的流程入口（问对方用自带绫还是自定义） |
| `【自带的绫】` | 8 | 分支说明 |
| `【反 AI 味：保留个性，但别把正常提问当挑衅】` | 483 | 见 3.1 |
| `【什么时候不反骨（照这个优先级）】` | 294 | 见 3.1 |

合计 **3,118 字符（占本地 prefix 的 25.8%）**是「角色扮演 + 反骨收紧」新增的
（RP 四个子段连续成一块 2,341 字符，占 prefix 19.4%；反品味两段 777 字符），
它们和人格正文、工具协议在同一个 prefix 里竞争注意力。

## 4. ④ 上游 README 的调参建议

上游 `README.md`（34,113 B）**没有**「怎样显得不像傻子」专章——这本身就是信息：
上游不是靠调阈值，而是靠人设与思考强度。能摘到的直接相关建议只有两处：

- `README.md:83` —「**DSH 思考强度**：默认 `max`，可选 `high` / `low`，档位从 DSH 实际公布的能力读取，
  保存后下一条消息生效；控制台会明示该设置同时写入 DSH 全局默认（`~/.dsh/settings.yaml`）」
- `README.md:120` —「`dsh.provider` / `dsh.model` / `dsh.reasoningEffort`：DSH 会话使用的模型/推理强度；
  若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动）」

上游把「像人」写在**人设/prefix** 里（`反 AI 味：拒绝有求必应`、`群聊不是客服队列`、
`像真人一样漏看/迟到/离场`、`分条与节奏`、`不要当群管家/主持人` 等 40 个标题），而不是 config 阈值里。

## 5. ⑤ 结论：上游靠什么显得不傻（按证据强度）

1. **思考强度 `max`**（上游默认）→ 本地 `high`。唯一一项「本地明确低于上游」的推理参数，且 README 把 max 当推荐值。
2. **人设卡体量 4.2 倍差距**：上游主打 `小鲸鱼.md` 15,640 B vs 本地**当前激活** `大肥鱼小姐.md` 3,731 B。
   人格越薄，模型越只能回落到「通用助手腔」——这正好对应「木、短、机械」的体感。
3. **「反骨」被本地反向收紧**：上游允许对普通请求装傻/乱回/给离谱答案，本地新增「什么时候不反骨」正反例把它压住。
   上游认为「最像人」的行为，在本地是被明令禁止的。
4. **工具面 28 → 37**（+9 个 schema）：每次唤醒的固定开销变大，对话内容占比变小。
5. **模型路径更抖**：上游 `provider=deepseek-official` + `model=deepseek-flash`（直连），
   本地 `provider=workbuddy2api` + `model=deepseek-v4.1-flash` + 空闲档强制中转 + 5 条兜底
   （与主窗口证据 A/B 一致：40 轮里 30 轮跑该档）。**provider 这一层比 model 名称更关键**：
   上游走官方池，本地走中转池，后者质量问题不在模型本身而在链路。
6. **本地独有 `sessionRecycle`（600 条 / 48h）**：上游没有这个机制 → 上游不会「到点失忆」。

### 对 M5 假设的裁决（本文件能判的部分）

| 假设 | 裁决 | 依据 |
|---|---|---|
| H1 模型档位 | **支持** | `reasoningEffort` max→high；模型与路由见 1.2 |
| H2 规则淹没 | **支持但需修正说法** | 规则词只 +6（61→67）；真正的变化是**人设口径反转**（3.1）与 +9 工具，不是「堆了更多禁令」 |
| H3 触发太保守 | **反对（不是本地改的）** | 5 项触发阈值与上游完全一致（1.1） |
| H4 上下文太窄 | **部分反对** | 上下文参数与上游一致；但工具面 +9 确实挤占有效占比 |
| H5 记忆与摘要 | **支持** | 上游无 `sessionRecycle`，本地 600/48h |
| H6 人格注入被截 | **待 D21 实测** | 激活卡 3.7KB 不会截；切回小鲸鱼（15.5KB≈5.9k 字符）才贴 6000 上限 |

## 6. 限制

- 上游是 `--depth 1` 的 `a49877f` 快照，之后可能变；本地 config 是 2026-10-26 23:5x 的快照。
- 「当前激活角色」取 `state/current-role.json`，用户随时可改，结论 2 只对该快照成立。
- 本文件不做模型能力对比（要看 `state/token-usage.jsonl`，属 D21）。
- 只读：未改 `config.json`、未改 `src/`、未重启桥接、未发群消息。

## 7. 复现

```powershell
# 1) 只读 clone（已存在就别重复拉）
git clone --depth 1 https://github.com/Derpyu520/qq-bridge <本机路径>\_upstream-qq-bridge
git -C <本机路径>\_upstream-qq-bridge log --oneline -1

# 2) config 逐项对照：用 node 读两份 JSON，按点路径取值打印（见本文 1.1/1.2 的表）
#    本地路径：<本机路径>\qq-bridge-src\config.json
#    上游路径：<本机路径>\_upstream-qq-bridge\config.example.json

# 3) prefix 体量：取 patch.yml 里 `prefix:` 起、缩进 2+ 的块，数字符数 / 规则词 / 【】标题
#    两侧文件：plugins\qq-agent-presets\presets\qq-chat-v2.patch.yml

# 4) 激活角色
Get-Content <本机路径>\qq-bridge-src\state\current-role.json
```
