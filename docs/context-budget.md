# 上下文预算回收（D45）：把「越聊越长」改成「有预算」

> 一句话：每步输入不再由会话有多长决定，而由 `socialV2.contextBudget.maxPressurePct` 决定 ——
> 超过就退役会话、下一轮重建（digest 交接），压力回到起点。

## 1. 现象与根因（已确认，不重复排查）

**现象**：线上 7,130 步，输入 12.9 亿 / 输出 180 万 token（比值 718:1，告警线 500）；
每步输入 p50 119k、p90 431k、p99 693k、max 755k；总成本 ¥102.15、平均 ¥0.088/轮。

**根因**：DSH 每一步都把**整个会话历史**重发一遍。所以只要会话还在长，每步的输入就跟着线性涨。

原来的两道刹车都没刹在这件事上：

| 刹车 | 管的是什么 | 为什么没刹住 |
|---|---|---|
| `socialV2.sessionRecycle` | 消息**条数** / **小时数** | 条数 600 条（现已改 200 条/8h）才回收；200 条里只要每条都长，单步照样 70 万 token |
| `toolResultPruner.thresholdChars` | 单条**工具结果**的长度 | 早就是 20000，没有余量了；而且大头是历史，不是工具结果 |
| `compaction-basic` | 上下文到一定**比例**就压缩 | 没写任何阈值 → 走插件默认 `thresholdRatio: 0.8`，即 1,048,576 × 0.8 ≈ **83.9 万 token** 才压缩。实测最高一步 755k，从来没到过 → 一次都没触发 |

**结论**：缺的不是「更狠的裁剪参数」，是**一条按实际上下文压力算的预算线**。

## 2. 做法

每轮结束（`turn/end` 的收尾分支）看一次该会话的上下文压力：

```
pressure% = projectedTokens / contextWindow × 100      （与 default-workspace\ctx-report.mjs 同口径）
```

- `≥ maxPressurePct` **且** 该会话轮次 `≥ minTurnsBeforeRecycle` → 退役会话
  （`retireSession`，内部已含 `saveHandoffDigest` 交接），下一轮由 `ensureSession`
  重建，bootstrap 时注入交接脉络。**不写第二套重建逻辑**，与 D34 的 cwd 自愈守卫同一套。
- 否则什么都不做。

数据源：DH `session/projections` 的 `contextPressure`
（`pressureTokens` / `projectedTokens` / `contextWindow`）+ `sessionStats.turns`。

### 纪律（这几条是需求里的硬约束，都有测试盯着）

| 约束 | 落实 | 测试 |
|---|---|---|
| 不许每步都打 RPC | 压力是慢变量：**60 秒 TTL** + 单飞 + **5 秒超时**（复用 D34 的 `sessions.list` 守卫模式） | 21 次检查只打 1 次 RPC；5 个并发合并成 1 次 |
| 拿不到数据 fail-open | 超时 / 抛错 / 缺字段 / 窗口为 0 → 一律当「没超」，继续用，不报错 | 失败返回 `null`、失败后 60s 内不重试、失败不改变决策 |
| 开关关闭完全不动作 | `enabled !== true` 直接 return，**连 RPC 都不打** | 关闭时 `skip`，压力再高也不回收 |
| 别砍错会话 | 回收前核对 `state.sessions[key] === sessionId` | 静态断言 |
| 不拖慢回复 | 调用处 fire-and-forget + `catch` 吞异常 | 静态断言 |

### 代码

| 文件 | 内容 |
|---|---|
| `src/context-budget.js` | 纯逻辑：`budgetConfig` / `pressureSnapshot` / `decideBudgetAction` / `formatBudgetLog` / `createContextPressureProbe`（TTL+单飞+超时，`call` 由外部注入，方便单测） |
| `src/bridge.js` | `CONTEXT_BUDGET_*` 常量 + `contextPressureProbe` + `messagesSinceSessionReset` + `budgetTickForTurn`（挂在 `sessionRecycleCfg` 旁边），轮末调用一处 |
| `scripts/test-context-budget.mjs` | 46 条断言（含 5 条必测项 + 静态接线断言） |

## 3. 配置（键由用户在主窗口加，**默认关闭**）

```jsonc
"socialV2": {
  "contextBudget": {
    "enabled": true,
    "maxPressurePct": 30,        // 建议值见 §5；缺省/非法回落 55
    "minTurnsBeforeRecycle": 20  // 缺省/非法回落 20
  }
}
```

- **没有这个键 = 关闭**（`enabled !== true` 一律不动作），代码已合入也不会自己开始换会话。
- 非法值回落默认而不是抛错：配置写错不该让桥接起不来。
- 改的是 `src/` → **需要重启桥接才生效**。

## 4. 日志（做量化用这一行）

```
[预算] key=group:100000001 pressure=41.1%~ tokens=431.4k turns=57 动作=keep why=under-budget
[预算] key=group:100000001 pressure=55.3%~ tokens=580.1k turns=61 动作=recycle why=over-budget
[预算] group:100000001 按预算回收（55.3% ≥ 55%），下一轮重建
```

- `pressure=` 后面是「预计占用 / 窗口上限」，`~` 表示这是 projected 口径（不是已用）。
- 拿不到压力时打 `pressure=?~`，不会打出 `undefined` / `NaN`（有测试）。
- `动作=` 只有 `keep` / `recycle` / `skip`（`skip` 表示开关关闭，正常情况下看不到）。

## 5. 能省多少（用线上 `state/token-usage.jsonl` 实测数据算的）

基线：7,161 步、总输入 1.31B、平均每步 182.6k、实际成本 ¥102.15。

口径：**把每步输入按上限截断后重新求平均**（`mean(min(input_i, cap))`），再按同样步数折算成本。
这是**保守下界**——真实回收后上下文从 ~24k 重新长，比「截断到上限」更省；
但回收要付 digest 交接、重建、以及丢上下文的代价，所以不把下界当保证。

| 上限 | 截断后平均/步 | 相对基线 | 折算成本 | 结论 |
|---|---|---|---|---|
| 20%（210k） | 128.3k | **−29.8%** | ¥71.75 | 能把「线性涨」压成平台 |
| 25%（262k） | 142.1k | **−22.2%** | ¥79.50 | 同上，丢的上下文少一些 |
| 30%（315k） | 153.0k | **−16.2%** | ¥85.60 | 同上，推荐第一档 |
| 40%（419k） | 167.7k | −8.2% | ¥93.79 | 开始只切尾巴 |
| 55%（577k） | 179.3k | −1.8% | ¥100.27 | **几乎不省**（原提案值） |
| 80%（839k） | 182.6k | −0.0% | ¥102.15 | 等于现在 compaction 的默认线 |

**要注意的一条**：原提案的 `maxPressurePct: 55` 只切掉 p95 以上的尾巴，平均每步只从 182.6k 降到
179.3k（−1.8%，约 ¥1.9）。原因是 p50 才 119k、平均 182.6k，55%（577k）离日常水位太远 ——
会话要滚很久才碰线，碰线前那段的钱照付。

所以：**若目标是「不再随会话长度线性涨」，55% 做不到；30%（省 16%，约 ¥16.6）才算真的把曲线压平，
20–25% 更狠（省 22–30%）但上下文丢得更多。** 建议从 30% 起步，看 `[预算]` 日志里 recycle 的频率
（太频繁说明丢得太狠，往上调；几乎不 recycle 说明可以再往下压）。

单会话视角（最长会话 `group:100000001`：2,400 步 / 633.4M，现在平均 263.9k/步）：
30% → 203.9k，25% → 184.9k，20% → 161.3k。

**不确定性说明**：① 截断口径假设回收后成本不超过上限，真实更低，故为下界；
② 没算 digest 交接与重建本身的成本（每轮几 k token，可忽略，但要诚实）；
③ 假设模型价格结构不变、缓存命中率不变（实际回收后 cache 前缀全失效，前几步会贵一点点，
    这是本估算里没扣的一笔，量级远小于省下的）；
④ 步数按历史 7,161 步推算，没考虑用户聊天量变化。

## 6. 顺手修的过期文案

`public/console.html` 的成本解读原来写「检查是否需要更激进的裁剪（工具结果阈值 50K → 20K）」——
preset 里早就是 20000，这句话会持续误导人去调一个已经没有余量的旋钮。改成：

> 成本主要在会话历史（每步重发），不是工具结果：prompt 是输出的 N 倍（告警线 500:1）。
> 看 p90 与最长会话轮次，考虑收紧 socialV2.sessionRecycle 或开 socialV2.contextBudget（按上下文压力回收会话）。

`scripts/test-console-static.mjs` 同步改了断言，并新增反向断言「页面上不许再出现 `50K → 20K`」。

## 7. 调研：compaction-basic 能不能显式配阈值（只读，未改 preset）

**能，而且默认值就是这次没刹住的原因。** 依据：DSH 内置包 `@deepseek-ai/dsh-compaction-basic@0.2.1-rc.2`
的 `README.zh.md` 配置表与 `lib/index.js` 里的 `BASIC_COMPACT_CONFIG_KEYS`（从 `app.asar` 只读抽出）。

默认触发点 = `floor(min(W × thresholdRatio, W − O − headroomTokens))`，
`thresholdRatio` 默认 **0.8**、`headroomTokens` 默认 **65536**、`retainRatio` 默认 0.16。
本机 `W = 1,048,576` → 触发点 ≈ **838,860 token（79.9%）**，而实测最高一步 754,720 → 一次都没触发。

全部顶层配置键（`BASIC_COMPACT_CONFIG_KEYS`，不是猜的）：

```
thresholdRatio  headroomTokens  retainRatio  retainTokens
summarizationProvider  summarizationModel  maxTokens  compactionRetries
maxOverflowRetries  modelPolicies  auto
```

配置样例（写在 preset 的 `compaction-basic` 节点下；**现在 preset 里该节点没有 config**）：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    auto: true
    thresholdRatio: 0.55        # 1,048,576 × 0.55 ≈ 577k 触发压缩
    retainRatio: 0.16           # 近期尾部逐字保留（W−O 的 16%）
    compactionRetries: 1
    modelPolicies:              # 按路由覆盖，可选
      - provider: deepseek-account
        model: deepseek-flash
        thresholdRatio: 0.55
```

**风险**：
1. 压缩 = 一次额外的**摘要 LLM 调用**（`summarizationProvider/Model` 不填就用最近一次的请求目标），
   自己也要花 token；压得太勤会变成「省钱变花钱」。实测一次摘要在几 k token 量级，相对 57 万的历史不算大。
2. 压缩替换掉的是历史本身，早期细节**不可逆丢失**（原始摘要留在 `compaction/summary` 事件里，但不再进 prompt）。
3. 配置写错会在插件加载时**快速失败**（未知键、`retainRatio ≥ thresholdRatio`、`retainTokens` 与 `retainRatio` 同时出现等），
   而 preset 加载失败会连带影响建会话 —— 改这个必须先在临时 preset 上验一次再上线上。
4. 压低 `thresholdRatio` 会**改变历史形态**（更早出现 `<compacted-summary>`），与人设/记忆相关的提示词行为要一起观察。

**与 §1 的关系：可以叠加，但语义不同，别当成二选一。**

| | contextBudget（本文 §1） | compaction-basic 调阈值 |
|---|---|---|
| 动作 | 换会话（历史清零，只带 digest 脉络） | 同会话内把旧历史压成摘要 |
| 省法 | 每步重发的历史**直接没了** | 重发的历史**变短** |
| 代价 | 丢上下文（只有 digest）；重建要一次 bootstrap | 摘要调用花钱；摘要内容有损 |
| 能保证「不线性涨」吗 | 能（硬上限） | 能（到线就压），但压缩也要时间与模型配额 |
| 生效 | 改 `src/` 已实现，重启后看配置 | 改 preset + 重启 DSH（preset 在**建会话时**读） |

建议：**先只开 contextBudget（30%）**，它是硬上限且不需要额外模型调用；compaction 保持默认
（80%）当「超长单轮」的兜底。若开完发现丢上下文太狠影响体验，再考虑把 compaction 阈值降到
比预算线**略高**（例如 budget 30%、compaction 0.45）—— 让它在换会话之前先把历史压一轮，
等于「能救就救，救不动再换」。**两者阈值不要设成一样**：那会让压缩刚压完就被预算切掉，
白付一次摘要钱。

## 8. 建议（不在本次改动内，供拍板）

1. `maxPressurePct` 建议 30（省 ~16%，下界口径），不要 55（几乎不省）。
2. 想更狠再降到 25，但先跑一周看 `[预算]` 日志与群里「怎么不记得了」的反馈。
3. 不要为了省 token 去删人设/工具/记忆 —— 那是产品决策。若真要动，先看 D21/D22 的结论：
   工具面 37 vs 上游 28、prefix 25.8% 是 RP 与反骨块，这些是「显得笨」的相关项，不是成本大头。
4. `internal:黑话学习` 占 252.4M（19%，1,194 步 / 平均 211k）—— 它也是会话，
   开预算后同样会被回收；但它是后台任务，回收丢的是学习上下文，**建议单独确认是否要让
   `slang` 会话豁免预算**（当前实现不豁免，若需要我给 `contextBudget.exemptKeys`）。

## 9. 验收

- 单测 `scripts/test-context-budget.mjs` **46/46**（含 5 条必测：超阈值→回收、未超→不回收、
  RPC 失败→fail-open、开关关闭→完全不动作、`minTurnsBeforeRecycle` 生效）。
- `node --check src/bridge.js` / `src/context-budget.js` 通过。
- `scripts/test-console-static.mjs` 通过。
- 已接进 `regression-all` 的 CORE（`test-context-budget.mjs`）。
- **改的是 `src/` → 需重启桥接才生效**；配置键由用户加，默认关闭。

## 10. 真机只读验证（2026-10-27 13:xx，未改任何配置/状态）

对**真实 DSH** 打了一次 `sessions.list` + 每个会话一次 `session/projections`（只读），
用 `pressureSnapshot` 解析、按 `maxPressurePct: 30` 决策，确认字段假设成立：

| 会话轮次 | pressure | tokens | 决策 |
|---|---|---|---|
| 699 轮 | 69.8% | 698.5k | `recycle`（over-budget）|
| 461 轮 | 51.2% | 536.9k | `recycle` |
| 31 轮 | 51.6% | 515.6k | `recycle` |
| 14 / 10 / 8 / 3 轮 | 10–22% | 105–229k | `keep`（min-turns 或 under-budget）|

两条结论：
1. **字段是真的**：`contextPressure.contextWindow` = 1,048,576、`projectedTokens`、`sessionStats.turns`
   都能拿到，699 轮那一条正好对上用户给的「最长 699 轮」。
2. **compaction 确实一次没触发**：699 轮 / 69.8% 仍在 80% 阈值之下 —— 这解释了 p99 69 万 token
   为什么能攒出来。

同时这也说明按 30% 开预算后，**第一次运行会有 3 个存量长会话各被回收一次**（各付一次 digest 交接与
重建），之后才进入平台期。这是预期行为，不是故障；日志里会看到 3 行 `动作=recycle`。

## 11. 上线后怎么量化（D46：`scripts/probe-budget-effect.mjs`，只读）

开了预算之后，「到底省了多少」不要靠感觉。一条命令：

```powershell
node scripts/probe-budget-effect.mjs                  # 人读
node scripts/probe-budget-effect.mjs --json            # 机读
node scripts/probe-budget-effect.mjs --simulate 15,25,30,55   # 假如上限设成 X 的静态估算
node scripts/probe-budget-effect.mjs --selftest         # 自测（11/11）
```

它把两边数据接起来（都只读，跑前跑后 state 的 sha256 不变）：

| 段 | 数据来源 | 回答什么 |
|---|---|---|
| 预算日志摘要 | `state/bridge.log` 的 `[预算]` 行 | 检查了多少次、keep/recycle 分布、每个会话最后压力 |
| 每步输入趋势 | `state/token-usage.jsonl` | 按小时的中位输入（带 ▁▂▃ 条形和占窗口百分比）——**曲线有没有被压平看这张** |
| 回收效果 | 日志里的 recycle 时刻切 token 步 | 同一会话「回收前 40 步 vs 后 40 步」的中位输入与降幅；回收后还没新步会明确写「效果未知」而不是硬算 |
| `--simulate` | 全部历史步 | 假如下限设成 X%：截断后平均、越线步占比、越线次数（≈会换几次会话） |

已知不确定（写进代码注释了，别当保证）：`bridge.log` 行首只有时分秒，跨天前的行会按文件 mtime 那天
补日期，所以趋势窗口默认只看最近 24h；`--simulate` 是静态估算，不建模「回收后重新增长」的曲线。

**第一次真机数据（2026-10-27 13:1x，main 配的是 `maxPressurePct: 15`）**：

```
越线步占比：15% → 39.9%，25% → 23.9%，30% → 17.9%，55% → 4.1%
截断后平均：15% → 110.3k（省 39.9%），30% → 153.4k（省 16.5%），55% → 180.2k（省 1.9%）
越线次数（≈换会话次数 / 7,186 步）：15% → 29 次，30% → 13 次，55% → 4 次
```

即：15% 确实最省（≈40%），但历史上要换 ~29 次会话；30% 省一半的幅度、换会话次数也减半。
15% 意味着「上下文一过 157k 就清空」——大约相当于最近 20~40 轮的对话，如果群里开始出现
「你刚才不是说过吗」这类反馈，就该上调。


## 12. 静默漏点与兜底 sweep（D51）

### 漏在哪

2026-10-27 13:14 重启后，`group:100000004` 在 31 分钟里 5 步烧掉 **3.53M**（706k/步），
同期 `[预算]` 日志**一条都没有**。原因在回合末的守卫：

```js
if (key && state.sessions[key] === frame.sessionId) { void budgetTickForTurn(...) }
```

DSH 重启会**恢复「进行中的回合」**（日志：`重连后恢复了进行中的回合（session-…）`），
那些 frame 的 `sessionId` 与 `state.sessions[key]` 里的映射不一致 ⇒ 守卫为假 ⇒
**既不检查也不打日志**。不是偶发一次，而是那一整段回合全漏，而且无痕。

### 现在怎么防（两层）

**① 不匹配不再静默**：打一行 warn，带两侧 sid 后 8 位，同一组 `(key, 映射 sid, 实际 sid)`
只在状态变化时打一次（不会每步刷屏）：

```
[预算] 跳过 key=group:100000004 映射=abc12345 实际=def67890（会话已换：不检查，等 sweep 兜底）
```

frame 完全没有 key（reverse 里查不到）也留痕，计入 `skipsNoKey`。

**② 兜底 sweep**：不再只依赖「回合末恰好映射一致」。

| 项 | 做法 |
|---|---|
| 触发 | 每 **10 分钟**（定时器）或每 **10 个回合**，先到先算 |
| 范围 | 只扫白名单内、且 `state.sessions` 里**仍有映射**的会话（`isSessionAllowedInCurrentMode`） |
| 用的 sid | `state.sessions[key]` 的 sid（按需求口径） |
| 决策 | 与回合末**同一套**（含 `minTurnsBeforeRecycle`、`fail-open`） |
| 幂等 | 同一 key 在一个 hold 窗口（= sweep 周期 10 分钟）内不会被回收第二次；回合末刚砍完的 key，sweep 只记 `skipsHeld` 不再砍 |
| 并发 | 单飞：上一轮没扫完不会叠一轮 |
| 失败 | RPC 超时/抛错/缺字段 → 跳过该 key，记 `errors`，绝不影响回复 |

### 怎么观测（不用再猜）

`GET /api/status` 的返回里新增 `budget` 对象（只在操作者视图，带 agent 头的那条分支拿不到）：

```json
"budget": {
  "enabled": true, "maxPressurePct": 15, "minTurnsBeforeRecycle": 20,
  "checks": 128, "recycles": 3, "skipsSessionMismatch": 0, "skipsNoKey": 0, "skipsHeld": 2,
  "sweeps": 6, "sweepRecycles": 1, "errors": 0,
  "lastPct": 12.3, "lastKey": "group:100000004", "lastAt": 1793036100000,
  "lastRecycleAtMs": 1793035000000
}
```

也有独立入口 `GET /api/debug/budget`（同样的字段；**带 agent 头一律 403**，因为 `lastKey` 是群号）。
本地看：

```powershell
curl -s -H "x-console-token: <consoleToken>" http://127.0.0.1:3100/api/debug/budget
```

判读：`checks` 长期不涨 = sweep 没跑或开关关了；`skipsSessionMismatch` 一直涨 = 映射长期不对，
说明「刚重启后的那批进行中回合」还在；`skipsHeld` 高但 `recycles` 不涨 = 阈值太紧（刚砍完又超线）。

### 已知残余（故意不做，等拍板）

被 DSH 恢复的**那个进行中回合**（frame sid ≠ 映射 sid）不会被 sweep 砍掉：要砍它只能
`stopSessionWork` 那个 sid，而它当时**还在跑一轮回复**——砍了就是「回复被吞」，违反
「这套东西坏了最多多花钱，绝不许让回复弄没」。所以这一轮的钱照付，只保证：①日志留痕；
②下次映射恢复后立刻接上预算；③`skipsSessionMismatch` 记账让你看得见它。
若要把这段也压掉，可选的下一步是「回合结束后（而不是回合中途）回收掉那个孤儿 sid」，
需要单独一拍板（它有把 DSH 侧会话归档错的风险）。
