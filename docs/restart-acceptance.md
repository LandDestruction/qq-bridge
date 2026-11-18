# 重启后真机验收清单（今晚这批改动一次生效）

> **2026-10-27 16:3x 更新（D57）**：main 又进了 **D55（bridge.js 模块化重构，入口 18922→3011 行）**
> 与 **D56（代码规模闸，`test-code-size` 进 GUARD）**，已补进 §一、§三-11（重构后冒烟，**重启后第一件做**）与 §四。
> 累计待验 9 组：D19 / M2 / T12+M7（早批）、D39v2 / D34+D36 / D42 / D45 / D47 / D48（13:4x 批）、D53 / D55（本批）。
> 核对时 main = `2056bd3`；基线 **81 套**（60 + ARCHIVE 11 + GUARD 7 + BUDGET 3）。
> `socialV2.memory.people` 已确认开启（16:2x 实读 `{"enabled":true}`）→ §三-7 可直接验。
> 重启只能做一次，重启前**必须**先问用户（别在有人正跟机器人聊天时动手）。
> 逐条验收都给了「预期证据 / 失败长什么样 / 回滚动作」；对不上就按回滚列处理。

## 一、这轮待生效的改动

| 任务 | 改了什么 | 不重启会怎样 |
|---|---|---|
| T12（w3，`0b56981`） | `saveSocialV2State` 落盘会话摘要 `digests`；新增 `digestSnapshot/normalizeDigests` | 摘要只存在内存，**重启即清空**——「刚重启问不出来」照旧 |
| M2（w6，`4cc0a0d`） | 表情 dHash 视觉去重（汉明距离 1）、`stickerUrlKey` 以 `fileid` 为身份、`collectSticker` 落 dhash | 面板仍按 QQ 重编码后的 md5 分成 11 对双卡 |
| **D19（w2，`5a95ce2`）—— M1 的最终版，取代 M1-v1** | 含图标记 `lastMediaAt` **落盘**（`socialV2.conversations[key].lastMediaAt`，load/save/默认对象三处）；`markMediaTurn` 统一三个入口（含**取图成功回写**）；`keyHasRecentMedia` 判定改为「内存 → `isFreshMediaAt(lastMediaAt)` → 窗口扫描(6+6)」 | **群友发图机器人看不见**；且「回合中途才取图」永远等不到视觉模型重选 |
| **D27（w2，`c34f0e2`）—— M7 好感度接线** | `src/bridge.js` 三处：入站结算（`affinityNoteInbound`）、被问注入（`deliverPromptNow` 前置，≤300 字 + 隐私行）、`POST /api/affinity/shift` + MCP 工具 `qq_affinity_shift`；`pack-exclude.json` 补 `state/affinity.json` | 问好感度没有分数可报（工具不存在）；`state/affinity.json` 不会生成 |
| **D39v2（w1，`aa1f26b`）** | `src/persona-request.js`：扮演/换人设识别**前移到入站**（`appendSocialV2Message`，pending 30 分钟）、分 `persona/jailbreak` 两路、**出站前强制补一句 `/persona` 用法**（模型已提则不重复）、同会话 10 分钟冷却 + 同人 30 分钟去重 | 「从现在起你演我妹妹」这类话仍靠模型自觉，多半被当普通闲聊糊过去；越狱话术也没有统一口径 |
| **D34 + D36（w3，`083985e` / `2201609`）** | ①摘要生成修复（纯占位符消息跳过、不留半截尾、topics 只取重复短语）②刷新改「条数 **或** 摘要超 2h」双条件 ③注入块每条带「N 小时前」④披露口径 `disclosure`：`open`（B 档，被问起可以说）默认 / `strict` 旧禁令 | 摘要继续是 `[图片]`、`杜十娘：你` 这种半句；有人问「你还记得隔壁群那事吗」继续装傻（旧禁令） |
| **D42（w4，`c8d4588` + `8cdd3ad`）** | `src/people.js` + `state/people.json`：按 userId 跨群统一的人物档案、别名索引（群名片/台账/历史 sender，含 ≥3 字后缀匹配）、按需召回注入（≤200 字符，未命中 0 开销） | 问「你认识隔壁的哦鲸鲸吗」仍答「不认识，换个群就断片」。**注意：`socialV2.memory.people.enabled` 默认 `false`，当前 config 里没有这段 → 功能现在是关的**（见 §三-7 前提） |
| **D45（w5，`6a35dc4`）** | `src/context-budget.js` + 轮末 `budgetTickForTurn`：pressure 超线且轮次够就 retire+重建（含 digest 交接、`sessionResets.reason=budget`），回收前核对 `state.sessions[key]===sessionId` | 每步重发整段历史，输入随会话线性涨（p99 693k、max 755k）；`[预算]` 日志永不出现 |
| **D47（w5，`57a6306`）** | `src/session-resets.js` + save/load 接线：`socialV2.sessionResets` 落盘（脏数据归一、封顶 500） | 重启后「距上次重建多少条/小时」归零 → sessionRecycle 按「本次进程启动以来」算，长会话不再被回收；D45 的 turns 兜底一起失效 |
| **D48（w4，`cfff9a7` + `70b6889`）** | digest 改 `entries:[{at,text,from}]`（每条记忆带**说出时间**与说话人），全链路保留；渲染成「· 群 X（N 小时前更新）：　N 小时前｜说话人：内容」，最多 3 条、缺时间写「时间不详」 | 记忆没有时间轴：问「你多久以前听我说过」答不出；跨天也分不清今天还是昨天 |
| **D53（w1，`9678400`，合并 `8ce297a`）** | 视频/语音转写质量：①`tools/stt_server.py` 语言锁定 `--language zh` + 中文 `initial_prompt` + `beam_size=5` + `vad` + `condition_on_previous_text=false`，`--device` 走 `cuda:int8_float16 → cpu:int8` 降级链，并回传 `avg_logprob / no_speech_prob`；②新增 `src/stt-quality.js`（`buildSttRequest` / `assessTranscript` / `planFramePlan` / `sttFallbackChain`）；③`src/video-analyze.js` 抽帧 9→**12 帧（4×3，≈1 fps）**、音频去静音 + loudnorm；④`src/bridge.js` 低置信**只写「【视频声音】听不清（原因）」不喂乱码**、画面与声音分两行 | 16s 视频仍转成 24 字乱码（9.2s）、模型答「声音糊得很」；抽帧还是 1.8s/帧，画面细节照样漏 |
| **D55（待领，`7b59aa0` + `08ff036` + `d98d947`）** | `src/bridge.js` 模块化拆分：拆成 77+ 个模块，入口 **18922 → 3011 行**（现 `src/*.js` 78 个文件），行为应完全等价、只搬代码。证据见 `docs/BRIDGE-REFACTOR-INTEGRATION.md` | 线上跑的仍是旧的单文件进程（代码在 main 但没生效）；**重构引入的错只会在重启后首次加载/调用时暴露**，所以重启后第一件事是 §三-11 冒烟 |
| **D56（待领，`2056bd3`）** | 代码规模闸 `scripts/test-code-size.mjs` + `scripts/code-size-baseline.json`：文件 ≤800 行 / 入口 ≤4500 / 单函数 ≤300，基线只许变小（防 5900 行函数复发）。已进 `GUARD_CORE` | **不需要重启**（只加测试与基线，不改运行时）；但它现在算进基线 81，重启后第一次跑回归会连带跑它 |

> M1-v1 的记录已被 D19 取代，**不要**再按旧说法验收（旧版标记只在内存，重启即空）。
> D26（w3，`96ebde1`）是纯逻辑 `src/affinity.js` + `scripts/test-affinity.mjs`，本身不需要重启，
> 它的规则随 D27 的接线生效。

## 二、重启（只做一次）

```powershell
$tok = Get-Content <本机路径>\deepseek-harness\qq-bridge-src\state\console-token -Raw
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3100/api/restart `
  -Headers @{ 'x-console-token' = $tok.Trim(); 'content-type' = 'application/json' } -Body '{}'
```

- 桥接由计划任务 `QQBridge-Bridge` 守护，退出 5 秒自动拉起；
- 重启后确认新 pid：`state/bridge.lock` 与 `state/boot-log.jsonl` 最后一行 `start` 的 pid 一致，
  且与重启前**不同**（一条命令看全：`node scripts/collect-restart-evidence.mjs` 的 ① 段）；
- **别在用户正跟机器人对话时重启**，等一句「可以重启」再动。

## 三、逐条验收（重启后 10 分钟内可完成；第 1~4 条是早批，5~9 条是 13:4x 批，第 10 条是 D53）

### 1. 看得见图（D19 / M1-v2）

**操作**：在白名单群发一张图并 `@大肥鱼小姐 这图里是什么`。
（再补一条更难的：只问「你刚才看到的那张图里是什么？」——让图是机器人**回合中途**自己用
`qq_get_message_images` 取的，这正是 D19 修的那条路径。）

**预期证据**（两条都要有）：
1. `node scripts/collect-restart-evidence.mjs` 的一键取证里，③ 段「取图之后」出现
   `deepseek-account/deepseek-flash`（在 `dsh.visionModels` 里），而不是 `workbuddy2api/deepseek-v4.1-flash`；
   > **D33 判读教训**：手工查 `state/token-usage.jsonl` 时只看 `"k":"turn"` 的行。同一会话还有一行
   > `"k":"base"`，那是**会话创建时**记录的配置默认值（永远是 `workbuddy2api/deepseek-v4.1-flash`），
   > 拿它当证据会误判成「没修复」。`collect-restart-evidence.mjs` 已按 `k==='turn'` 过滤。
2. 日志里出现**重选记录**（这是 D19 的核心判据，工具调用成功还不够）：
   ```powershell
   Select-String -Path <本机路径>\deepseek-harness\qq-bridge-src\logs\bridge-stdout.log -Pattern 'source=media' |
     Select-Object -Last 3
   ```
   期望能看到 `[模型] 选择 source=media deepseek-account/deepseek-flash（带图强制）`；
3. 回复本身描述得出图里的内容（颜色/物体/文字），不是「图我还是看不见」。

**失败长什么样**：取图 `ok:true` 但 ③ 段「取图之后」仍是 `workbuddy2api/deepseek-v4.1-flash`；
`source=media` 一条都没有；机器人又回「没恢复/还是读不出来」。这三条里任一条成立就算失败。

**回滚**：只 revert D19 那个 merge（`git -C <本机路径>\deepseek-harness\qq-bridge-src revert <D19 的 merge-sha>`）
再重启一次，保留 T12/M2/D27。

### 2. 表情不再双卡（M2）

**操作**：打开控制台 `/ops`（或 `/library`）的表情区，看「表情包注释」条数与卡片数。

**预期证据**：196 条 → 约 **186** 张卡（11 对视觉重复已合并）；
重启后 `persistMissingStickerThumbs` 每轮补 60 条 dHash，**两三轮自动收敛**；
`node scripts/collect-restart-evidence.mjs` ④ 段显示「按现有 dhash 去重」与库内条数的关系。

**失败长什么样**：同一张图仍铺两张卡，或条数没变、dHash 长期不补齐。

**回滚**：`git revert <M2 的 merge-sha>` 后重启；**若发现收藏少了**，立刻
`Copy-Item state\stickers.json.bak-* state\stickers.json -Force` 再重启。

### 3. 跨会话摘要不再丢（T12）

**操作**：让两个白名单群各有 ≥20 条消息（不够就先聊几句），在 A 群问「B 群最近聊了什么」；
**重启后再问一次**。

**预期证据**：`node scripts/probe-cross-session.mjs`（只读）能看到 `digests` 条数与更新时间；
重启前跑一次、重启后再跑一次，摘要仍在且 `at` 时间戳**早于**重启时刻
（`at` 停在重启前 ⇒ 只可能是从磁盘读回来的，重新生成必然带新时间戳）。
注意：计数在内存里，重启后每个会话要**再收满 20 条**才会生成新摘要 —— 这不等于修坏了。

**失败长什么样**：`digests` 字段有但永远 0 条且攒够 20 条后仍不增加；或重启后 `digests` 变空。

**回滚**：`git revert <T12 的 merge-sha>` 再重启；`social-v2.json` 的 `digests` 是新增字段，
旧代码会忽略，不会崩。

### 4. 好感度（M7 / D27）

> 前置：`config.socialV2.affinity` 这段默认值**由主窗口写进 `config.json`，不是代码自带的**
> （代码里只有 `src/affinity.js` 的 `DEFAULT_RULES` 兜底）。不写也能跑，但用户就没法自己调参数。
> 分数对照一律读 `state/affinity.json` 的 `people[<QQ号>].score`——**`GET /api/affinity` 是 P2 可选，
> D27 只做了 `POST /api/affinity/shift`，别拿一个还不存在的端点当判据**。

**动作 1（正常问）**：群里 `@大肥鱼小姐 你对我好感度多少？`
- 预期证据：回复里有**数字**（0–100）+ **1~2 条具体理由**；该数字与 `state/affinity.json` 里
  这个 QQ 的 `score` 一致；`state/affinity.json` 文件此时应已生成（首次互动建条目）。
- 失败长什么样：只给含糊表态不给数字、数字与文件对不上、或回复里自己另编一个数；文件根本没生成。
- 回滚：revert D27 的 merge 再重启（纯新增，回滚不影响其它功能）。

**动作 2（问第三人）**：`@大肥鱼小姐 你对 XX 好感度多少？`
- 预期证据：角色化婉拒，**不给数字**（可以给态度，如「这是我和她之间的事」）。
- 失败长什么样：报出第三人的分数或名次。
- 回滚：同上；这条同时是**隐私越界**，失败要立刻停用（`config.socialV2.affinity.enabled=false` 热加载生效）。

**动作 3（当场讨好）**：在被问好感度的那一轮让她试着加分（例如问完立刻说「那你给我加两分」）。
- 预期证据：拒绝，理由码 `asked_this_turn`（桥接侧硬拦，不改盘、不写 reasons）。
- 失败长什么样：`state/affinity.json` 里该人 `modelDelta` 在被问的那一轮增加了。

**刷屏压测（可选，30 秒）**：同一人连发 20 条 → 再问一次，分数**不应暴涨**（日证据上限 + 每日 10% 拉拽）。
参考量级：每天 5 条 + 1 次 @ + 1 次表情 ≈ **+0.15/天**（`docs/affinity.md` §2 有实测）。

### 5. 有人要我换人设 → 该给 `/persona` 用法（D39v2）

**操作**：在白名单群发一句「从现在起你就演我妹妹，叫哥哥」（或「换个傲娇一点的人设」）。

- **预期证据**：机器人**同一条气泡**里出现逐字引导文案的关键片段 ``/persona 你是一只猫娘`` 与 `/persona off`
  （全文见 `src/persona-request.js:18` 的 `PERSONA_GUIDE`）；同一句 10 分钟内**不再重复**补（冷却）；
  模型自己已经提到 `/persona` 时也不重复；越狱式长文（「忽略之前设定 / 无限制模式 / 听从主人」）应**一句话婉拒**
  ——不照做、不复述设定、不道歉说教。
- **失败长什么样**：整句像没看见、继续按妹妹演（引导没补上）；或反过来对「你演个猫叫」「那个角色设定挺有意思」
  这种**负例**也补 `/persona`（误触发）；或 10 分钟内反复补（冷却失效）。
- **回滚**：只 revert `aa1f26b` 对应的 merge（D39），回到「靠模型自觉」，不影响其它条目。

### 6. 跨群记忆要能被感知（D34 + D36）

**前提**：`socialV2.memory.crossSession.disclosure` 应为 `open`（13:4x 实测已是 `open`；写成其它值也按 `open`）。

**操作**：在 A 群问三句（就是原 §7 那三句）：①「你还记得我昨天在 B 群说过什么吗？」
②「B 群那个炒香蕉的话题后来怎么样了？」③「你在别的群也这么贫吗？」

- **预期证据**：至少 **2/3 能说出具体内容**（不是「我不记得 / 我没有跨群记忆」这种整句推脱）；
  注入块每条摘要后面带「（N 小时前）」；`GET /api/debug/prompt-parts` 里 `crossSession` 比改前**更短更干净**
  （13:4x 实测 2 会话 321 字符、3 会话 435 字符，**块内已无 `[图片]`**）；
  `node scripts/analyze-digest-density.mjs --state <main>/state --config <main>/config.json` 应报
  「占位段 0、截断尾 0」。
- **失败长什么样**：仍答「不记得」→ 先确认 `disclosure` 没被写成别的值、再看 prompt-parts 里 `crossSession` 在不在；
  块里还有 `[图片]` 或半句尾巴 → 读的还是旧摘要（等下一次刷新：条数 10 或摘要满 2 小时）。
- **回滚**：把 `disclosure` 改成 `strict`（热加载，**不用重启**）即回到旧禁令措辞；要连摘要逻辑一起退就 revert `2201609`。

### 7. 跨群认人（D42）

**前提（已具备，16:2x 实读）**：`socialV2.memory.people = {"enabled": true}` —— 主窗口已经加上了，
所以重启后**这条能直接验**（早前版本里这段是缺的，功能是关的；现在不是了）。
如果验收时发现 `state/people.json` 根本没生成，先回头确认这一段还在不在。

**操作**：在 A 群（如 `<群号>`）问「你认识隔壁群那个哦鲸鲸吗？」——选一个在别的白名单群发过言的人。

- **预期证据**：能说出「在别的群见过 / 她聊过什么」这一类，且**不带群号、不给第三人评分、不复述原话**；
  `state/people.json` 生成，条目按 userId 跨群统一、别名里有群名片（含 ≥3 字后缀匹配，如「聪明头哦鲸鲸」→「哦鲸鲸」）；
  没命中任何人时 prompt 里 people 段是**空串**（0 开销）。
- **失败长什么样**：仍答「不认识，换个群就断片」→ 先查开关有没有开、再查 `state/people.json` 是否生成；
  把同名不同人混成一个（该明确说分不清）。
- **回滚**：`socialV2.memory.people.enabled=false`（热加载即停记录/注入）；或 revert D42 的 merge。

### 8. 上下文预算回收 + sessionResets 落盘（D45 + D47）

**操作（只读，不用等长会话）**：① 看 `state/bridge.log` 有没有 `[预算]` 行（设计上很少：只在「真查了 DSH」或
「真回收了」时打一行）；② `node scripts/probe-budget-effect.mjs` 看「每步输入降了多少」；
③ 看 `state/social-v2.json` 里有没有 `sessionResets` 字段（`{key:{at,count,reason}}`）。

- **预期证据**：config 里 `socialV2.contextBudget = {enabled:true,maxPressurePct:15,minTurnsBeforeRecycle:20}`；
  pressure 超线且轮次够时，日志出现 retire 记录、`sessionResets[key].reason = "budget"`；
  **重启后再看一次 `sessionResets`：条数与时间不该归零**（这正是 D47 修的）。
- **失败长什么样**：重启后 `sessionResets` 变 `{}` → D47 没生效；`[预算]` 每轮刷一行把 `bridge.log` 冲爆
  → 是 `c681ba5` 之前的版本；回收后会话上下文丢失/重复 → 看 retire 前的 `state.sessions[key]===sessionId` 核对。
- **回滚**：`socialV2.contextBudget.enabled=false`（热加载即停回收）；D47 只管落盘，出问题 revert `57a6306`。

### 9. 记忆有时间线（D48）

**操作**：带时间地问——「你多久以前听我说过 X？」或「那事是今天还是昨天聊的？」

- **预期证据**：注入块是「· 群 X（N 小时前更新）：」+「　N 小时前｜说话人：内容」；
  时间取自**每条消息真正说出的时间**（`entries[].at`），不是整块生成时间；
  老数据（没有 `entries`）显示「时间不详」或整块「N 小时前更新」，**不许编造具体时刻**；
  超出预算按 3→2→1 砍**条数**、不砍时间。
- **失败长什么样**：每条都是「刚刚」（说明 `at` 被写成了生成时刻）；或对没有时间的旧摘要硬说「昨天」；
  或问「多久以前」答出一个具体到分钟的时间（本该只说粒度）。
- **回滚**：revert `70b6889`（退回 `cfff9a7` 那版）或整个 D48 merge。

### 10. 视频/语音别再听成乱码（D53）

**三个前提（不满足就别判失败）**：

1. **`socialV2.stt.model` 现在是 `medium`**（config 实读：`{model:"medium", lang:"zh"}`）。D53 的实测是：
   同一段 40s 中文，`small` 5.3s / 103 字 / 通顺 / `avg -0.154`；`medium` **46.6s** / 154 字 / **尾部复读 4 次** / `avg -0.361`。
   → **本机没有显卡时，`medium` 就是「更慢更差」那一档**。验之前请主窗口确认：要么 `socialV2.stt.model` 改回 `small`，
   要么确认真在 CUDA 上跑（服务端 `--device` 会自动优先 cuda）。
2. **常驻转写服务（端口 8791）现在没起**（14:1x/15:3x 两次实测都不在监听）→ 会回退 CLI 转写（每条多几秒，属预期），
   **不是 D53 失败**；想验「快」这条，先让主窗口把 `tools/stt_server.py` 起起来。
3. **>60s 视频的分段只做到 plan + 单测，bridge 还没接线**；QQ 官方转写回退没做。
   所以「长视频分多段转写」**不在这次验收范围**，别按它判红。

**操作**：在白名单群发一段 **10~30 秒、有人说话**的视频，问「这视频里说了什么/在讲什么」；再发一段**没人说话**的视频。

- **预期证据**：
  ① 有人声那段：转写出来的是**通顺中文**（不是「24 字乱码」），回复里**画面与声音分两行**（`【视频画面】` / `【视频声音】`）；
  ② 抽帧变密：日志/字段里能对上 **12 帧（4×3）**；16s 视频不再是 9 帧；
  ③ 没人声那段：回复是**「听不清（原因）」**一类，而不是把乱码当内容编故事；
  ④ 低置信判据（任一命中即「听不清」）：`avg_logprob < -0.85`、平均 `no_speech_prob > 0.6`、字数 < 4、
     6~16 字片段连续复读 3 次、空文本。
- **失败长什么样**：仍出现「声音糊得很」+ 一堆不通顺的字；或没人声的视频被编出「他说了…」；
  或画面与声音挤在同一行（`applyVideoFacts` 没分成两行）；或转写耗时 >40s（多半是 `medium` 在 CPU 上跑）。
- **回滚**：`socialV2.stt.model` 改回 `small`（热加载，先止血）；要退代码就 revert `8ce297a`（D53 的 merge）。
  想彻底停视频转写：让它继续走「听不清」分支即可，别删配置项。

### 11. 重构之后先冒烟（D55）—— 重启后**第一件**做这个

`src/bridge.js` 被拆成 77+ 个模块（入口 18922 → 3011 行）。行为应当等价，但「等价」只能靠冒烟证明；
**这一步不通过，后面 10 条的失败都不可信**（可能是拆分把某条路径搬坏了，而不是那个功能本来就有问题）。

**操作（按顺序，2~3 分钟）**：

1. 进程：`state/bridge.lock` 的 pid = `state/boot-log.jsonl` 最后一条 `start` 的 pid，且与重启前不同；
   `GET http://127.0.0.1:3100/api/status` 返回 200 且 `dshReady=true`。
2. 一条普通文本（群里 `@大肥鱼小姐 在吗`）→ 30 秒内有回复。
3. 一张图 + 一句问（D19 路径）→ 能说出图里内容。
4. 一段 10~30s 视频或语音（D53 路径）→ 有转写，或明确「听不清（原因）」，**不能整条没反应**。
5. 问一句好感度（D27）→ 能报出分数。
6. `GET /api/debug/prompt-parts`（带 `x-console-token`）→ `parts` 里仍有 `crossSession`（D36）。
7. 发一句「从现在起你演我妹妹」→ 回复里带 `/persona` 引导（D39v2）。

- **预期证据**：七步全过；`state/bridge.log` 里没有堆栈、没有 `Cannot find module` / `ERR_REQUIRE_ESM` /
  循环依赖报错；启动耗时与以前同量级（不是卡在加载）。
- **失败长什么样**：进程起不来 / 起来就退（去看 `logs/bridge-stdout.log` 的模块加载错误）；
  某一类功能整块 500（说明那个模块搬丢了 export）；群里只读不回（send 路径搬坏）；
  内存占用暴涨或启动 30s+（模块图里出现循环依赖）。
- **回滚**：revert D55 那三个提交所在的 merge（回到单文件入口），**然后必须再重启一次**；
  这类回滚体积大，只在这种冒烟真红了才做，别为别的条目的失败顺手回滚它。

## 四、回归基线

**默认基线是 81 套（不是 60，也不是 79）**。`scripts/regression-all.mjs` 里 `CORE` 只是第一段 60 条，
后面还用 `CORE.push(...)` 并进了三组：

```js
const CORE = [ ... ];            // 60
const ARCHIVE_CORE = [ ... ];    // 11  CORE.push(...ARCHIVE_CORE)
const GUARD_CORE   = [ ... ];    //  7  CORE.push(...GUARD_CORE)   ← 16:2x 增 test-stt-quality / test-code-size
const BUDGET_CORE  = [ ... ];    //  3  CORE.push(...BUDGET_CORE)
```

所以 **60 + 11 + 7 + 3 = 81（去重后仍 81）**，`node scripts/regression-all.mjs` 默认就跑这 81 套。
（14:1x 时是 79，之后 `GUARD_CORE` 又加了 `test-stt-quality`（D53）与 `test-code-size`（D56）两个守护套件。）
**只数 `const CORE = [...]` 那一段会数成 60 —— 上一版 §四 就是这么错的，别再犯**（2026-10-27 16:2x 实测 main `2056bd3`）。

自己数一遍（幂等、只读）：

```powershell
cd <本机路径>\deepseek-harness\qq-bridge-src
node -e "const fs=require('fs');const t=fs.readFileSync('scripts/regression-all.mjs','utf8');const q=String.fromCharCode(39);function arr(n){const i=t.indexOf('const '+n+' = [');const j=t.indexOf('];',i);return t.slice(i,j).split(q).filter(s=>s.startsWith('test-'))}const all=['CORE','ARCHIVE_CORE','GUARD_CORE','BUDGET_CORE'];let tot=[];for(const n of all){const a=arr(n);console.log(n,'=',a.length);tot=tot.concat(a)}console.log('合计',tot.length,'去重',new Set(tot).size)"
node scripts/regression-all.mjs          # 跑这 81 套
```

三组分别是谁（对不上就是有人改了登记）：

| 组 | 条数 | 内容 |
|---|---|---|
| `CORE` | 60 | 基础闸（末三项 `test-dsh-endpoint / test-vision-media / test-pack-exclude`） |
| `ARCHIVE_CORE` | 11 | 归档线：atomic / contentkey / lock / path / p1-recycle / p1-zip / p1-maintain / p2-pause / p2-progress / p2-sidecar / p2-transfer |
| `GUARD_CORE` | 7 | `test-affinity` / `test-affinity-endpoint` / `test-persona-guidance` / `test-session-cwd-guard` / `test-self-model` / **`test-stt-quality`（D53）** / **`test-code-size`（D56）** |
| `BUDGET_CORE` | 3 | `test-context-budget` / `test-budget-effect` / `test-session-resets` |

**本轮这批新套件在基线里的登记情况**：

- 已进基线：`test-persona-guidance`、`test-stt-quality`、`test-code-size`（都在 `GUARD_CORE`）、
  `test-context-budget` / `test-budget-effect` / `test-session-resets`（`BUDGET_CORE`）；
- **没进任何数组**：`test-people`（D42）、`test-memory-timeline`（D48）—— 这两个必须**单跑**，
  或请 w1 各加一行（加完基线变 **83**，别再写 81）：

```powershell
foreach ($s in @('test-people','test-memory-timeline','test-cross-session-memory','test-cross-session-digest-v2','test-cross-session-digest-wiring')) { node "scripts\$s.mjs"; if ($LASTEXITCODE -ne 0) { "RED $s" } else { "OK $s" } }
```

- 想连「没登记进任何数组」的脚本一起跑，用 `node scripts/regression-all.mjs --all`；
  在**工作树**里跑会红几条（缺 `config.json` 的既有环境项），**判定以 main 工作树为准**；
- `test-win6-board.mjs` 不在基线里，别拿它算数。

### 4.1 历史：01:15 那次「三条待确认」（已完成使命，留作对照）

| 问题 | 当时的结论 | 现在的状态（13:4x） |
|---|---|---|
| a) CORE 是 60 还是 61 | 60，`test-affinity` 没进 CORE | **61 的说法作废，真实基线是 81**（16:2x）：`test-affinity` 后来进了 GUARD 组，三组（GUARD 7 / ARCHIVE 11 / BUDGET 3）一起 `push` 进 CORE → 60+11+7+3=81（见本轮 §四） |
| b) D19 / D27 是否已合 | 已合（`5a95ce2` / `c34f0e2`） | 已生效（12:09 重启过，见 §七） |
| c) `GET /api/affinity` | 没有，只有 `POST /api/affinity/shift` | 仍没有；分数读 `state/affinity.json` 的 `people[<QQ>].score` |

## 五、回滚总表

| 症状 | 回滚 |
|---|---|
| 重启后桥接起不来 / 群里全面不回 | `git -C <本机路径>\deepseek-harness\qq-bridge-src revert <merge-sha>` 再重启；或 `git checkout <上一个稳定 sha>` |
| 图片仍看不见且日志报错 | 只 revert D19 那个 merge，保留其它 |
| 表情卡数变少但**丢了收藏** | 立刻 revert M2，并用 `state\stickers.json.bak-*` 恢复 |
| 摘要读出乱码/答非所问 | revert T12 |
| 好感度越界（报出第三人分数）或分数乱跳 | revert D27；先 `config.socialV2.affinity.enabled=false` 止血 |
| 被问跨群记忆仍装傻 / 块里还是 `[图片]` 或半句 | 先确认 `crossSession.disclosure` 的值；要立刻回旧口径就设 `strict`（热加载），要回旧摘要逻辑就 revert `2201609` |
| 换人设的引导刷屏、或对正常闲聊误补 `/persona` | revert `aa1f26b`（D39）；该功能没有单独开关，只能回代码 |
| 认人把两个人混成一个 / 说出不该说的 | 立刻 `socialV2.memory.people.enabled=false`（热加载止血）；再 revert D42 的 merge |
| 预算回收太凶（会话频繁重建、答非所问） | `socialV2.contextBudget.enabled=false`（热加载）；或把 `maxPressurePct` 调大、`minTurnsBeforeRecycle` 调大 |
| 重启后 `sessionResets` 还是空 / 长会话不再被回收 | revert `57a6306`；同时注意 D45 的 turns 兜底也会跟着失效 |
| 记忆时间全变「刚刚」或对旧数据编时间 | revert `70b6889`（退回 `cfff9a7`），或整个 D48 merge |
| 视频/语音转出来是乱码、或没人声也编内容 | 先 `socialV2.stt.model` 改回 `small`（热加载止血）；仍在就 revert `8ce297a`（D53）；转写变慢到 >40s 基本是 `medium` 在 CPU 跑，改回 `small` 即可 |
| 重构后起不来 / 某类功能整块 500 / 群里只读不回 | revert D55 那三个提交所在的 merge（回单文件入口）**并再重启一次**；只在这种冒烟真红了才用，别为别的条目失败顺手回滚它 |

## 六、验收完要回填的

- 每条结果（通过/不通过 + 证据片段）写进 `docs/CHANGELOG.md` 一段「00:xx 重启验收」；
- 不通过的条目标题回看板，由 w1 派新任务，别当场连续试。

> 另：`dsh.modelFallbacks` 删掉失效 `scnet/...` 条目**可以顺手一起做**——它走热加载（约 1 秒），
> 不用等重启；但「启动警告消失」要等这次重启后看 `logs/bridge-stdout.log` 才验证得到。

## 七、历史：12:09 那次重启的实测结果（已上线，作为对照）

> 这次（12:09:17，pid 102156）验的是 **D19 / M2 / T12 / M7 + D34 接线（含「N 小时前」）**，全部通过。
> **本轮（13:4x 之后的这次重启）新增的是 §三 第 5~9 条**（D39v2 / D34+D36 / D42 / D45 / D47 / D48）；
> 下表只当「上一次怎么验的、证据长什么样」的样板，不要照抄结论。

一条命令复核：`cd <本机路径>\deepseek-harness\qq-bridge-src; node scripts\collect-restart-evidence.mjs --fast`
（只读，运行前后 6 个 state 文件 sha256 一致；`--selftest` 自证 9/9）

| 验收项 | 结论 | 证据（01:15 采集） |
|---|---|---|
| ① 换进程 | ✅ | `bridge.lock` pid = boot-log 最后一条 start pid = 85700（00:39:54），上一条 118188（00:19:07） |
| ② T12 摘要跨重启 | ✅ **通过（本轮第一次拿到真机证据）** | `digests['group:<群号>'].at = 00:08:32`，而进程起于 00:39:54 → 这条摘要只可能来自磁盘（重生须再收 20 条且用 `Date.now()`）；`digests` 共 1 条 |
| ③ D19 视觉路由 | ✅ **通过** | 01:13:19 取图 ok=true；日志 3 条 `[模型] 选择 source=media deepseek-account/deepseek-flash（带图强制）`（00:48:33 / 01:11:49 / 01:12:40）；取图前后各 4 条采样均为 `deepseek-account/deepseek-flash` ✅ 可看图；全日志已无 `image unavailable / does not declare image input` |
| ③' 视觉**内容**验证（不只看路由） | ✅ | 01:11:41 收到图 → 01:12:12 回「这图我看了两遍才反应过来…那四个盒子拆到底全是蓝毛我」；01:13:06 第二张图 → 01:13:26 回「这个不能给妈妈保管呀」——是内容级接话，不是套话 |
| ④ M2 表情重复 | ✅ | 库内 194 条 = 按 dhash 去重后 194 卡，缺 dhash 0 条（加载期去重已收敛并写回） |
| ⑤ M7 好感度入站 | ✅ 入站已生效 | `state/affinity.json` 已生成、10 人、各 `score=50` 且 `reasons` 有记录；**分数尚无分化属正常**（正证据走每日 10% 拉拽）。`GET /api/affinity` 仍无，对照读文件 |

坑：`collect-restart-evidence.mjs` 的 state 路径相对**脚本所在仓库**（`ROOT = 脚本上一级`），所以要在
`<本机路径>\deepseek-harness\qq-bridge-src` 里跑它才是线上数据；在工作树里跑只会读到该工作树的空 `state/`。
