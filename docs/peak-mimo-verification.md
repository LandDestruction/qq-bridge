# 高峰期 MiMo 验证：静态核对 + 明早 09:05 真机五步

> 任务 T2（w2）。**只做静态核对与文档**：本文不要求改 `config.json`，也不动 `peakPause.windows`。
> 真机部分必须在 09:00–12:00 或 14:00–18:00 窗口内做，今晚只能静态核对。
> 配套探针：`scripts/probe-peak-static.mjs`（只读，见文末附录）。

## 0. 一句话结论

- **时段判定是好的**：09:00 算高峰、12:00 与 18:00 端点排他、工作日/法定节假日/调休补班都按配置走。
  探针自检 18/18，八个边界点全部符合预期（附录 A 有原始输出）。
- **但「高峰用哪个模型」有两份配置在打架**，这直接决定明早怎么算验收通过：
  - `socialV2.modelRouting.peak` = `xiaomi-mimo` / **`mimo-v2.6-pro`** ← **这一份才真正生效**；
  - `socialV2.peakPause.agent` = `xiaomi-mimo` / **`mimo-v2.6-flash`** ← 只喂一行日志、状态视图和一次缓存失效，**不参与选型**。
  - 所以明早如果按「日志里出现 mimo-v2.6-flash 就算通过」来验收，会**误判**：实际跑的是 pro，
    而日志里那句「[峰值] 高峰时段：模型切到 xiaomi-mimo/mimo-v2.6-flash」是**提示语，不是事实陈述**。
  - 若产品意图确实是「高峰期用 flash」，那是**改配置**（`modelRouting.peak` 改成 `xiaomi-mimo/mimo-v2.6-flash`），
    属于主窗口执行范围，不在本任务内。

## 1. 判定链：谁在什么时候把模型换成 MiMo

选型在 `src/bridge.js` 的 `ensureChatModel()`（约 11667 行起），优先级（`src/model-routing.js:52` `resolveModelChoice`）：

```
media（本轮带图/表情/视频）> peak（高峰）> idle（空闲）> fallback 顺序 > 调用方默认
全程跳过 disabled 与「已知不可用」，available 探测非空时只认清单内的
```

「是不是高峰」只有一处入口：`peakPauseActive()`（`src/bridge.js:15013`）：

```js
if (!c.enabled) return false;                 // enabled 是总开关，关了立刻回群聊
return c.schedule ? inPeakWindow() : true;    // schedule 只表示「要不要限定在时段内」
```

`inPeakWindow()`（`src/bridge.js:14993`）规则：

| 维度 | 规则 |
|---|---|
| 工作日 | 周一至周五（`peakPause.days` 默认 `[1,2,3,4,5]`，0=周日） |
| 节假日 | 命中 `peakPause.holidays`（按 `YYYY-MM-DD`）→ 不算高峰 |
| 调休补班 | 命中 `peakPause.makeupDays` → **强制算工作日**（优先于节假日判断） |
| 时段 | 半开区间 `[start, end)`：**含起点、不含终点**；`start > end` 视为跨夜 |
| 时间源 | **本机时钟** `new Date()`（`getHours()/getMinutes()/getDay()`），配置里不存时区 |

## 2. 口径差异：业务侧 vs 计费侧（两套实现，互不引用）

| 项 | 业务侧（决定切不切 MiMo） | 计费侧（决定高峰价还是空闲价） |
|---|---|---|
| 位置 | `src/bridge.js:14993` `inPeakWindow()` / `15013` `peakPauseActive()` | `src/model-prices.js:206` `isPeakAt()` |
| 是否导出 | 否（闭包内部函数，探针只能镜像） | 是（探针直接 `import` 做交叉对照） |
| 时间源 | 本机时区 | 硬编码北京时间 `UTC+8`（`beijingParts()`） |
| 粒度 | 分钟 | **整点（只看小时）**，分钟被丢弃 |
| 工作日编号 | `0=周日 … 6=周六`（`getDay()`） | `1=周一 … 7=周日` |
| 时段来源 | `socialV2.peakPause.windows` | 价目表 `pricing.peakWindows`（默认 `[[9,12],[14,18]]`） |
| 节假日 | `socialV2.peakPause.holidays` | 价目表 `holidays` |
| 调休补班 | 支持（`makeupDays`） | **不支持**（计费侧没有补班概念） |

结论：**本机在 `Asia/Shanghai`、且没有调休补班/跨夜窗口的普通工作日，两边结论一致**（八点交叉对照全一致）。
换机器时区、或落在调休补班日，两边会分叉——那时以**业务侧**判断「模型会不会切」，计费侧只影响记账。

## 3. 静态发现（按影响排序）

### D1 高峰模型两份配置不一致（最重要）
- 生效的是 `modelRouting.peak`（pro），但 `peakPause.agent` 写的是 flash。
- 附带开销：`ensureChatModel()` 开头（`src/bridge.js:11671`）在「agent 启用 + 高峰 + 群聊」时，
  用 `agent` 的 `provider/model` 跟「已应用模型」比对；两者永远不等 → **每轮都让缓存失效、每轮多一次
  `session.selectModel` RPC**。高峰期群聊首句延迟会因此多一跳，日志里每轮都会出现一次
  `已设置会话模型 … -> xiaomi-mimo/mimo-v2.6-pro`。
- 建议（**不由我执行**）：让两份配置指向同一个模型；或让 `agent.provider/model` 只做展示、不参与比对。

### D2 `schedule=false` + `enabled=true` = 全天高峰
`peakPauseActive()` 里 `schedule` 只表示「要不要限时段」。所以控制台把「只在时段内」关掉（`schedule=false`）
而总开关还开着，就变成**全天 24 小时都按高峰处理**（包括周末凌晨）。当前配置是 `enabled=true, schedule=true`，正常。
这是预期语义，但很容易被误读成「关掉自动时段 = 不暂停」，验收时别搞反。

### D3 时间源不统一
业务侧用本机钟：桥接进程跑在非 `Asia/Shanghai` 的机器/容器里，高峰窗口会整体平移（计费侧却仍是北京时间）。
当前本机 `Asia/Shanghai`（`getTimezoneOffset() = -480`），无影响，但换机器要复核。

### D4 计费侧小时粒度
`isPeakAt()` 只比较小时，所以计费上 11:59 和 12:00 之间没有分钟级切换（整点才换价）。
业务侧是分钟级（`12:00` 这一分钟就已经空闲）。两者在整点前后 59 分钟内的差异只影响「这一分钟按什么价记账」，
不影响「切不切模型」——对账时不要拿计费侧的整点结论去推断业务侧。

### D5 直连小模型（`peakPause.localModel`）当前是关的
`socialV2.peakPause.localModel.enabled=false`。历史上高峰期是「直接拦下来交给 ollama/直连小模型」，
现在是「消息照常进正常流程，只换模型」（`src/bridge.js:15500` 注释）。所以**高峰期工具、识图、语音、画画都还在**，
但前提是选中的模型支持这些（MiMo 支持工具调用，识图另见 `modelForMedia` 兜底逻辑）。

### D6 节假日表只覆盖 2026
`peakPause.validYear=2026`，`holidays` 33 条、`makeupDays` 6 条。桥接启动时若发现年份超了会告警
（`src/bridge.js:17625`）。2027 年之前必须更新，否则节假日会被当工作日算高峰。

## 4. 明早 09:05 真机验证五步（任何人照做可复现）

准备：`cd <本机路径>\w2`（或主仓库，探针只读，两边都能跑）。
下文命令里的 `<token>` 从 `<桥接根目录>\state\console-token` 读，**不要打印到聊天里**。

### 第 1 步（09:00–09:10 之间）先证明「现在算高峰」
```powershell
node scripts/probe-peak-static.mjs 09:05 --date 2026-10-27 --config E:/deepseek-harness/qq-bridge-src/config.json
```
应看到（今晚已实测）：
```
判定：PEAK（高峰）
原因：2026-10-27（周二），09:05 落在窗口 09:00–12:00（含起点、不含终点）
计费侧 isPeakAt 对照：PEAK（与业务侧一致）
```
> 2026-10-27 是周二、不在 2026 节假日表、不是补班日 → 合法高峰日。
> 如果这天恰好被加进 `holidays`（临时放假），第 1 步会显示 `IDLE（法定节假日）`，那就**到此为止**，
> 不要继续做第 2–5 步（不是 bug，是配置生效）。

### 第 2 步 桥接自证：`/api/model-routing` 的四个字段
```powershell
$t = (Get-Content <本机路径>\qq-bridge-src\state\console-token -Raw).Trim()
Invoke-RestMethod "http://127.0.0.1:3100/api/model-routing?token=$t" |
  Select-Object @{n='inWindow';e={$_.peakPause.inWindow}}, @{n='active';e={$_.peakPause.active}},
                @{n='enabled';e={$_.peakPause.enabled}}, @{n='schedule';e={$_.peakPause.schedule}},
                @{n='src';e={$_.effective.source}}, @{n='provider';e={$_.effective.provider}},
                @{n='model';e={$_.effective.model}}, catalog | Format-List
```
必须满足：
- `inWindow = True`、`active = True`（否则高峰没生效，看 `enabled`/`schedule`/系统时间）；
- `src = peak`（这是「用了高峰档」的唯一权威字段）；
- `provider/model` 记录成**实际值**（当前配置预期 `xiaomi-mimo` / `mimo-v2.6-pro`）；
- `catalog = True` 表示 DSH 探到的模型清单非空（否则 `options` 是静态兜底，选型可能受限）。

### 第 3 步 真机一轮：在白名单群叫它一次
在 `allow.groups` 里的任一群，用**管理员/群主账号** @ 机器人说一句普通问话（不要带图，避免走 media 分支）：
```
@大肥鱼小姐 早，今天有什么推荐的
```
期望：拿到一条正常回复（不是静默、不是报错）。**记下回复时间**，用于第 4 步对日志。

### 第 4 步 三处证据交叉（任何一处对不上都算没通过）
```powershell
# 日志有两份：标准输出 logs\bridge-stdout.log（守护窗口重定向）和轮转 state\bridge.log（上限 2000 行）
$logs = @('<本机路径>\qq-bridge-src\logs\bridge-stdout.log','<本机路径>\qq-bridge-src\state\bridge.log')

# ① 桥接日志：选型那一行（source=peak 才说明走了高峰档）
Select-String -Path $logs -Pattern '\[模型\] 选择 source=' | Select-Object -Last 5 | ForEach-Object { $_.Line }

# ② 会话模型真正落地的回执
Select-String -Path $logs -Pattern '已设置会话模型' | Select-Object -Last 5 | ForEach-Object { $_.Line }

# ③ 账本：这一轮实际记账的 provider/model
Invoke-RestMethod "http://127.0.0.1:3100/api/tokens/recent?limit=10&token=$t" | Select-Object -ExpandProperty entries |
  Select-Object -Last 5 | Select-Object t, model, provider | Format-Table
```
今晚（空闲时段）日志里已经能看到同格式的行，可用来对照：
`22:47:12 [bridge] [模型] 选择 source=idle workbuddy2api/deepseek-v4.1-flash（空闲时段）`
——明早同一位置应当变成 `source=peak xiaomi-mimo/…（高峰时段）`。

判定表：

| 现象 | 结论 |
|---|---|
| ① `source=peak` 且 ② `-> xiaomi-mimo/…` 且 ③ 账本同一轮 `provider=xiaomi-mimo` | **通过**（模型确实切到 MiMo） |
| ① `source=peak` 但 ②/③ 仍是 `workbuddy2api` 或 `deepseek-account` | 没切成功：往下看 ② 附近的 `设置会话模型失败` / `已知不可用` / 降级行 |
| ① `source=idle` | 高峰没生效（时间不对/开关被关），回到第 2 步 |
| ① `source=fallback` | 高峰模型不可用，已自动降级——记下来，算「MiMo 不可用」而不是「验证通过」 |
| ③ 账本里出现两个不同 model（同一轮） | 中途换过模型（fallback 重试），按失败记 |

> 注意区分这两行：`[峰值] 高峰时段：模型切到 …` 是**每个桥接进程只打一次**的提示语，取自
> `peakPause.agent`，**不代表实际选型**；真正的证据是 ①②③。

### 第 5 步 收尾：12:00 之后复测一次，确认能自动退回空闲档
```powershell
node scripts/probe-peak-static.mjs 12:05 --date 2026-10-27 --config E:/deepseek-harness/qq-bridge-src/config.json
# 期望：IDLE（原因写「不在任何窗口内」；若正好 12:00 则写「终点排他」）
```
然后同样发一句 @，确认日志出现 `[模型] 选择 source=idle workbuddy2api/deepseek-v4.1-flash`。
**只验证进入高峰、不验证退出**是最常见的漏项：退出不回来，等于全天烧空闲档预算。

## 5. 失败/异常与回滚记录（照抄模板）

任何一步不符合预期，先记录，再回滚，**不要手改 `config.json`、不要重启桥接**：

```
时间：2026-10-27 09:0X
步骤：第 N 步
现象：<日志原文一行 / 接口字段原值>
影响：<没切模型 / 切了但账本还是旧模型 / 降级到 fallback>
回滚动作：<控制台 /ops 把「高峰期暂停」总开关拨到关（热生效）｜或把 modelRouting.peak 改回 idle 模型>
回滚后是否恢复：<日志 source=idle，用时 X 秒>
```

回滚优先级：
1. **控制台 `/ops` 把高峰总开关拨到关**（`peakPause.enabled=false`）——热生效，下一轮就回 idle，不重启；
2. 把 `modelRouting.peak` 在面板上改成与 idle 相同的模型——热生效，作为「暂时不让它切」的软回滚；
3. 若 MiMo 侧 401/额度错，记录 `provider=xiaomi-mimo` 的错误原文，交主窗口处理（可能需要换 key，属配置变更）。

## 6. 附录

### A. 探针自检与八点输出（今晚实测）
```
node scripts/probe-peak-static.mjs --selftest
```
```
✅ 边界 08:59 → IDLE（期望 IDLE）      ✅ 跨夜 23:30 → PEAK（期望 PEAK）
✅ 边界 09:00 → PEAK（期望 PEAK）      ✅ 跨夜 01:30 → PEAK（期望 PEAK）
✅ 边界 11:59 → PEAK（期望 PEAK）      ✅ 跨夜 02:00 终点排他 → IDLE（期望 IDLE）
✅ 边界 12:00 → IDLE（期望 IDLE）      ✅ 跨夜 21:59 → IDLE（期望 IDLE）
✅ 边界 13:59 → IDLE（期望 IDLE）      ✅ 周六 10:00 非工作日 → IDLE
✅ 边界 14:00 → PEAK（期望 PEAK）      ✅ 节假日 10:00 → IDLE
✅ 边界 17:59 → PEAK（期望 PEAK）      ✅ 调休补班（周六）10:00 → PEAK
✅ 边界 18:00 → IDLE（期望 IDLE）      ✅ enabled=false 时 09:30 → IDLE
                                      ✅ schedule=false 时 03:00 → PEAK
自检：18/18
```
八点一览（`--all --config …`）：08:59 IDLE / 09:00 PEAK / 11:59 PEAK / 12:00 IDLE /
13:59 IDLE / 14:00 PEAK / 17:59 PEAK / 18:00 IDLE，计费侧对照全部一致。

### B. 探针用法
```powershell
node scripts/probe-peak-static.mjs 09:05                       # 单点（默认今天、内置默认时段表）
node scripts/probe-peak-static.mjs 09:05 --date 2026-10-27 --config <config.json>   # 用真实节假日表
node scripts/probe-peak-static.mjs --all [--date YYYY-MM-DD]   # 八个边界点一览
node scripts/probe-peak-static.mjs --selftest                  # 自检 18 条（退出码 1 表示失败）
node scripts/probe-peak-static.mjs 23:30 --windows 22:00-02:00 # 跨夜窗口
node scripts/probe-peak-static.mjs 03:00 --schedule false      # 全天高峰语义
```
- **只读**：不写 `config.json` / `state/` / `logs/`；`--config` 只 `readFileSync`。
- 业务侧规则是**镜像**（bridge 里那两函数没导出）。`src/bridge.js:14973-15016` 一旦改规则，
  必须同步改 `scripts/probe-peak-static.mjs` 与本文——否则探针会给出「看起来很对」的旧结论。
- 已知边界：不支持 `peakPause.agent`/`localModel` 的启用状态判断（探针只回答「是不是高峰时段」，
  不回答「高峰时到底用哪个模型」——后者看第 2、4 步的接口与日志）。
