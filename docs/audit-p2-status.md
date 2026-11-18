# P2 七项审计结论清单（带证据）

> 目的：避免下一批审计把已修/误报的项再派一遍。
> 结论列只有三种：**已修**（给 commit）、**误报**（给代码行证据）、**未做**（给原因）。
> 采集时间：2026-10-25，代码基线 `2eb51c6` 之后的 main。复核方式见每行命令。

## P2-1 唤醒闸门写入顺序 —— 误报

```bash
grep -n "pendingWakeKeys" src/bridge.js | head
```
`bridge.js:12929` 附近是「先预占、失败回滚」：`pendingWakeKeys.add(key)` → `deliverPrompt`
→ `result.ok === false` 时 `delete` + `rollbackWakeTime()`；`catch` 里同样 `delete`。
唯一故意不删的分支是 `result.queued === true`（等 DSH 恢复后补投，删了会丢安全兜底），
注释写明是设计。**并发预占是标准写法，不需要改。**

## P2-2 preSleepWaitMs > wait.maxMs —— 已修

```bash
grep -n "clampPreSleepWait" src/bridge.js src/v2-wait.js
```
`src/v2-wait.js` 的 `clampPreSleepWait()` + bridge 两处闸门（mark-read / wake-config）用它夹值，
被夹时只告警一次。commit `940dfc4`。

## P2-3 markReadCalledKeys 被控制台污染 —— 已修

```bash
grep -n "markReadCalledKeys.add" src/bridge.js
```
`bridge.js:6198` 改为 `if (req.headers['x-agent-token']) markReadCalledKeys.add(key)`，
控制台调用不再计入「模型本回合调过 mark_read」。commit `d3200d2`。

## P2-4 state/audio、state/tts 只增不删 —— 误报

```bash
ls /c/Users/PC/Documents/deepseek-harness/qq-bridge-src/state/audio/tts | wc -l   # → 0
grep -n "cleanupTemp" src/bridge.js src/voice-core.js
```
TTS 产物不落本地库（`src/tts.js`、`src/edge-tts.js` 无 fs 写入）；唯一落盘的是音量处理产物，
在 `bridge.js:2388` 的 `finally { cleanupTemp(sendPath, processed.converted) }` 里删。
线上 `state/audio/tts` 为空即为证据。

## P2-5 视频临时文件不在 finally —— 误报

```bash
grep -n "finally" -A2 src/video-analyze.js | grep -c unlinkSync   # → 3
```
三处（`:108`/`:126`/`:145`）都是 `finally { try { fs.unlinkSync(...) } catch {} }`。

## P2-6 tts.synthGroupId 死配置 —— 误报

```bash
grep -n "synthGroupId" src/bridge.js src/tts.js
```
`bridge.js:2502` 读取并归一化（`> 0 ? : null`），`:2586` 缺值时抛可读错误；
`config.json` 里是 `0` = 「不指定，回落白名单第一个群」，是**合法的未设置状态**。

## P2-7 POST /api/dsh/model 只有 GET —— 已修

```bash
grep -n "api/dsh/model'" src/bridge.js
```
`bridge.js:6278` 有 `isModelSetAlias = req.method === 'POST' && url.pathname === '/api/dsh/model'`，
与 `POST /api/model` 共用同一套校验（含落盘前的可用清单校验）。

## 附：本批新增的两条（原 P1）

- **媒体哈希同步阻塞**（`src/image-hash.js` 的 `spawnSync`）：已改为 `dhashFromBufferAsync`
  （`bridge.js:1865` 调用点 await），commit `0d85c08`；`src/state-acl.mjs` 的 `spawnSync(icacls)`
  仅启动期 `hardenDir()` 调用一次，不在消息热路径，保留并注释说明。
- **TTS 扩展名**：共 **5 处**落盘点（`grep -n "ttsFileName(" src/bridge.js`），全部按 `synth*.ext`，
  并有静态断言 `scripts/test-tts-ext.mjs` 拦截「新增落盘点忘改扩展名」。

## 附二：本窗口第 1 轮补的两条（2026-10-25 晚）

### 网关取图重复抓取（原 test-token-economy 35/36）

```bash
node scripts/test-token-economy.mjs | tail -1
# → Token economy bridge regressions: 36/36 passed.
grep -n "getImageCached" src/bridge.js
# → 缓存 TTL 10 分钟 / 上限 50 条（FIFO），tryGetImage 统一走它
```
原因：同一张图在一条消息里被解析 3 次（快照压缩句柄 1 次 + `/api/images/message` 2 次），每次打网关。
现在同一 file 在窗口内只抓 1 次；测试期望同步从 2 次改为 1 次（断言处有注释）。

### 工具调用按轮归因

```bash
node scripts/tool-calls-by-turn.mjs --since 60
node scripts/tool-calls-by-turn.mjs --dup        # 只看「同一轮内同名工具被调多次」
grep -n "currentTurnBySession" src/bridge.js
```
`tool-calls.jsonl` 的 `call` 记录新增 `turn`（DSH 给的 turn 号，缺失用会话内自增）与 `step`。
旧日志没有该字段，全部落在 `turn=?` 组（脚本按 50 组上限兜住，不改历史数据）。

### 观察群顺序（`19df0cd`）

```bash
node scripts/test-tts-ext.mjs | tail -1
# → ✅ 观察群学习调用在「忽略未授权会话」之前（不会被当未授权丢掉）
```
线上证据：`忽略未授权会话 group:100000005` + `messages.db` 该群 0 条 → 闸门在观察逻辑之前 return。
已在 `handleIncoming` 的未授权分支开头插入 observe 分支（无任何发送路径），并加静态断言防回退。

## 附三：工具调用重复统计的口径（避免误读）

```bash
node scripts/tool-calls-by-turn.mjs --dup
# ⚠️ 有 5 组没有 turn 字段（旧日志）：这些组的「×N」是**跨轮合计**，不能当重复调用看。
# 含重复调用的轮次（仅统计有 turn 的组）：0
```
`tool-calls.jsonl` 里的 **turn 字段是本次新加的**（`d921b79`），此前所有记录都没有该字段。
因此旧日志里 `qq_wait_for_messages×84` 这类数字是**同一会话跨数十轮的总和**，不是同一轮重复调 84 次。
脚本已显式告警，并且 `--dup` 只统计「有 turn 的组」。

判据：想判断「某轮是否重复调同一工具」，必须在**新日志**上跑（bridge 重启后产生），
旧日志只能回答「这个会话历史上调了多少次」。
