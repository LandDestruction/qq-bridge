# 交接：新窗口接手 QQ Bridge（2026-10-26 21:0x）

> 给接手窗口：**先读完本文**，再动任何文件。所有路径、命令、已知坑都在这里。
> 旧窗口（本会话）继续可用，但之后由你全权负责修复与研发。

---

## 0. 一句话现状

QQ 机器人（桥接）跑在 `<本机路径>\qq-bridge-src`，`main` 已合并今天全部改动，`regression-all` **59/59** 通过；
桥接进程 pid 见 `state/bridge.lock`，控制台 `http://127.0.0.1:3100`（token 在 `state/console-token`）；
空闲期模型 `workbuddy2api/deepseek-v4.1-flash`，高峰期（09:00-12:00 / 14:00-18:00）切 `xiaomi-mimo/mimo-v2.6-flash`。

---

## 1. 目录与进程

| 项 | 值 |
|---|---|
| 主仓库 | `<本机路径>\qq-bridge-src`（git，main） |
| 旧 C 盘副本 | `<本机路径>\Documents\deepseek-harness\qq-bridge-src`（**已废弃，勿改**；C 盘还占 879MB，待清理） |
| 启动 | `node src/bridge.js` 或 `start.bat`；重启也可 `POST /api/restart`（带 `x-console-token`） |
| 控制台 | `http://127.0.0.1:3100/?token=<state/console-token>`；运维页 `/ops`；库页 `/library` |
| SnowLuma | `ws://127.0.0.1:3001`（OneBot WS）、`http://127.0.0.1:3000`（HTTP）；账号 **100000007 大肥鱼小姐** |
| DSH | 端口随重启变化，桥接自动发现；当前可用 `http://127.0.0.1:11046` |
| 模型网关 | WorkBuddy2API `http://127.0.0.1:7863/v1`（合池）；官方 DeepSeek、小米 MiMo 直连 |
| 状态 | `state/`（`messages.db`、`social-v2.json`、`stickers.json`、`token-usage.jsonl`、日志、token）**绝不外发** |
| 归档 | `<本机路径>\<群号_群名>\<BOOTH号>\`（simpleMode） |
| 日志 | `state/bridge.log`（主）、`logs/bridge-stdout.log`（跨天追加，无日期） |

---

## 2. 施工窗口（可继续用，也可不用）

| 窗口 | DSH session id | 工作树 | 分支 |
|---|---|---|---|
| A（后端） | `session-a350f43c-7151-4847-b239-3819dbee2d59` | `<本机路径>\Documents\deepseek-harness\wt-backend` | `feat/backend` |
| B（前端/面板） | `session-6ec9a999-2a55-48aa-82de-bd4704051d36` | `...\wt-frontend` | `feat/frontend` |
| C（杂项/契约） | `session-157e3444-3cc7-45e9-9c76-131fb0b669a2` | `...\wt-feature` | `feat/file-archive` |
| D（验收/语气） | `session-cb51a80c-58eb-42b4-bd51-89699d16c07e` | `<本机路径>\wt-audio` | `feat/audio` |

派活方式（旧窗口用过）：
```powershell
cd <本机路径>\Documents\deepseek-harness\default-workspace
node dispatch.mjs a msg-xxx.md          # a/b 是默认窗口，C/D 用 session id
node dispatch.mjs <session-id> msg-xxx.md --model deepseek-account/deepseek-flash
```
看护器：`worker-loop8.mjs`（**完成即自动 merge + 跑回归 + 失败回滚 + 成功重启**）。
判定逻辑已抽到 `loop8-decide.mjs`（纯函数，`node worker-loop8-selftest.mjs` 自测 6/6），
两者都在 `<本机路径>\Documents\deepseek-harness\default-workspace`（不在本仓库里）。

**退出条件（2026-10-26 21:0x 已改）**：旧版只要「本轮 pending 归零」就立刻打印「🎉 所有窗口已整合完成」退出，
20:28 第 16 轮合并完 D 就跑了，结果 D 20:43 又提交 `4c473ba`（语气收紧）没人接 —— 事件就这么漏的。
现在改成：**连续 8 轮「无新提交 + 无新合并 + 无在途任务」才退出**（8 × 2 分钟 ≈ 16 分钟宽限，
刚好覆盖 20:28→20:43 那 15 分钟的迟到提交），任一轮有动静计数归零重来。
- 新提交的判定：分支 head 相对上一轮变了 **且** `main..分支` 仍有增量（避免把「刚合并完」当新提交；第一次见到的 head 不算）。
- 在途任务（脏工作树 / 产物未达标 / 合并冲突 / 回归失败重试）期间**不累积安静轮次**，绝不退出。
- 旋钮：`LOOP8_EXIT_QUIET_ROUNDS=8`（默认 8）、`MAX_ROUNDS=30`（硬上限兜底）、
  `LOOP8_SLEEP_MS=120000`、`LOOP8_DRY=1`（只判定不合并不重启）、`LOOP8_AUTO_RESTART=1`（见下）。
- **默认不自动重启**（用户拍板：正在群里测试时不能被看护器打断）：合并进来的改动若含 `src/`、`public/`，
  只在日志里登记「⚠️ 需要重启才生效」并在 `worker-loop8-state.json` 写 `needsRestart`，由人挑时间 `POST /api/restart`；
  要恢复「合并即重启」用 `LOOP8_AUTO_RESTART=1`。
- 顺带修掉「成功重启」那步从来是假的：`POST /api/restart` 缺 `content-type: application/json`，
  控制台 CSRF 闸门直接 415（旧日志里三次「重启失败：415」）。现在带 JSON body 发请求，
  重启后轮询 `/api/status` 并用 `state/boot-log.jsonl` 的新 pid 证明真的换成新进程了。
  桥接由计划任务 `QQBridge-Bridge → start-bridge-hidden.vbs`（Const ROOT 指 E 盘）守护，退出 5 秒后自动拉起。

---

## 3. 配置与热加载（重要）

- 改 `config.json` **大多不用重启**：`socialV2.hotReload.enabled=true`，保存后 `fs.watch` 自动加载；也可 `POST /api/config/reload`。
- **必须重启**的字段：`consolePort`、`sessionCwd`、`agentPreset`、`snowluma.wsUrl/httpUrl/accessToken`、`dsh.baseUrl/authToken`。
- 改代码（`src/*.js`）**必须重启**；只改 `public/*` 刷新页面即可。
- **`loadConfig` 是白名单式构造**：新增配置段必须同时在 `loadConfig` 里搬运，否则运行时是 `undefined`（踩过两次：`imagegen`、`simpleMode`）。
- **写 config 的纪律**：脚本默认禁止写真实 `config.json`（需 `QQ_BRIDGE_ALLOW_CONFIG_WRITE=1`）；桥接写配置必须**先读盘再合并**（C 已修，防止模型路由被旧快照清空）。

---

## 4. 当前关键配置（`config.json`）

```jsonc
"socialV2": {
  "peakPause": { "enabled": true, "schedule": true,
                 "windows": [{"start":"09:00","end":"12:00"},{"start":"14:00","end":"18:00"}] },
  "modelRouting": {
    "idle":  {"provider":"workbuddy2api","model":"deepseek-v4.1-flash"},
    "peak":  {"provider":"xiaomi-mimo","model":"mimo-v2.6-flash"},
    "fallback":[{"provider":"deepseek-account","model":"deepseek-flash"}],
    "disabled":[]
  },
  "modelForMedia": {"provider":"deepseek-account","model":"deepseek-flash"},
  "stt": { "service": {"enabled":true,"port":8791,"model":"small"}, "followUp": {"enabled":true} },
  "hotReload": {"enabled": true}
},
"fileArchive": { "enabled": true, "groups":["100000001"], "dir":"E:/booth-inbox",
                 "simpleMode": true, "maxFileMb": 2560 },
"observe": { "enabled": true, "groups": ["100000005"] },
"allow": { "groups": ["100000001","100000002","100000003","100000004"] }
```
> `992835975` 是**非白名单**群（一直刷屏，桥接会忽略，属正常）。

模型选择优先级（`src/model-routing.js`）：
`media（带图）> peak（高峰且启用）> idle > fallback 顺序 > dsh 默认`，全程跳过 `disabled` 与已知不可用模型。

---

## 5. 今天已修完的事（别再重复踩）

| 主题 | 结论/提交 |
|---|---|
| 唤醒缺 `self_id` → @ 不醒 | `src/wake-selfid.js`，启动缓存 `get_login_info`；日志 `[启动] 机器人 self_id=…` |
| 表情库重复（164→163） | `sticker-lib.js`：去重键 `md5→emojiId→id→url(去query)` + dhash；**saveStickerStore 写盘前去重**；备份 `state/stickers.json.bak-dedupe-*` |
| 跨会话记忆 | `src/cross-session-memory.js`：每 20 条刷新会话摘要，注入【其它会话近况】（白名单、24h、≤3 个） |
| 语气反骨 | preset + `antiAiLine`：只在玩梗/挑衅时反骨；正常提问先给答案；8 条前后评测在 `docs/tone-eval-*.json` |
| 面板保存后下拉全空 | 后端 options 静态兜底 + 前端保留旧选项 + `cache-control: no-store` |
| 高峰模型切不过去 | epoch 失效提前、`activeModelOverride` 清理、每轮投递前 `ensureChatModel` |
| `write EOF` 崩进程 | stdio 错误护栏（`src/bridge.js` 顶部） |
| 卡死回合占 busy | 看门狗：群回合 4 分钟无事件 → 清忙并补推 |
| 空回复（MiMo flash 偶发空 content） | 群内空文本自动换 `deepseek-account/deepseek-flash` 重试一次 |
| config 被清空 | C：读盘再合并 + 脚本写保护 |

细节见 `docs/CHANGELOG.md` §13-§15、`docs/hot-reload.md`、`docs/api-contract-model.md`、`docs/handoff-*.md`。

---

## 6. 待办 / 需要新窗口继续的

1. ~~**loop8 退出条件**：改成「连续 3 轮无新提交才退出」~~ **已修（2026-10-26 21:0x）**：
   见 §2 的「退出条件」，逻辑在 `default-workspace\loop8-decide.mjs`，自测 `worker-loop8-selftest.mjs` 6/6；
   默认宽限按 15 分钟迟到提交的教训定为 **8 轮（≈16 分钟）**。
2. **面板「高峰期与模型」保存后下拉全空** → **已定位到真因并修（2026-10-26 21:1x）**：
   不只是前端显示问题 —— 面板发 `"provider/model"` 字符串，后端 `normalizeRouting` 只认对象，
   **点一次保存就把 `socialV2.modelRouting` 写成全 null**，下一轮退回 dsh 默认模型。
   现已支持字符串 + 加「解析失败 400」「拒绝全清空 400」两道闸门 + 真机回归 `scripts/probe-model-routing-live.mjs`（见 §17 CHANGELOG）。
   **仍需重启桥接才生效**；重启后在 `/ops` 点一次保存 + 刷新，确认下拉与选中值都还在（用户确认项）。
3. **跨会话记忆**：需要有 ≥20 条消息的会话才会生成摘要；找两个白名单群各聊几句，再在 A 群问「B 群最近聊了什么」验证。
4. **高峰模型 MiMo flash**：当前 21:00 已过窗口，验证需等明天 09:00-12:00，或临时把 `windows` 加一段（记得还原）。
5. **语气校准**：离线评测已复跑（2026-10-26 21:1x，`node scripts/probe-agent-tone.mjs --json <tmp>`，8/8 用例、0 失败）：
   「要推荐」从 `自己做点饭吃，比看什么电影都香`（拒答抬杠）变成真给两部片；「被骂」从 `傻的是你吧…` 变成
   `嘴这么冲干嘛，有事说事`（不升级）；「情绪低落」从 `骂回去` 变成共情+追问。基线对比在 `docs/tone-eval-before.json` / `tone-eval-after.json`。
   **仍差群内确认**（离线评测是同一 preset 直连模型，不等于群里真链路）：群里发「推荐部电影」「你是不是傻」「换个傲娇人设」，
   确认 ①不抬杠 ②人设请求提示 `/persona`。
6. **归档 simpleMode**：当前只收「7 位 BOOTH 号开头的压缩包/图片」，落到 `<本机路径>\<群号_群名>\<BOOTH号>\`，未分类进 `_未分类`；不再自动清理。
7. **清理**：C 盘 `<本机路径>\Documents\deepseek-harness` 现 **651MB**（2026-10-26 21:2x 清点）。
   已删 `qq-bridge-airgap/`（196MB，airgap 打包尝试产物，全仓库无引用，释放 201MB）。
   剩余清单（**都在用或待拍板，别乱删**）：
   | 目录 | 大小 | 说明 |
   |---|---|---|
   | `default-workspace/` | 475MB | **在用**：派活脚本、loop8、`_wb`（WorkBuddy2API 还从这里跑） |
   | `qq-bridge-src/` | 99MB | C 盘旧副本，但**计划任务 QQBridge-Bridge 指向这里**的 `scripts/start-bridge-hidden.vbs`（Const ROOT 已指 E）。该 vbs 必须留；其余（`state/` 65MB 旧数据、`node_modules/`、`.git/`）可删 |
   | `qq-deepseek-bot-backup-20261023/` | 35MB | 上一代机器人备份，含明文 `.env` 凭据（留着就有泄露面） |
   | `qq-bridge/` | 25MB | 上游 `Derpyu520-qq-bridge` 解压副本（参考用） |
   | `wt-backend/` `wt-frontend/` `wt-feature/` | 16MB | **在用**：三个施工工作树 |
   | `.tmp/` | 4MB | 临时 |
   **计划任务无法无提权重指**（`schtasks /Change` 直接 Access denied），要彻底清掉 C 盘旧副本得先提权改任务动作到
   `<本机路径>\qq-bridge-src\scripts\start-bridge-hidden.vbs`。
8. **`state/` 外发边界**：聊天记录、token、日志一律不出包。

---

## 7. 常用自检命令

```powershell
cd <本机路径>\qq-bridge-src
node scripts/regression-all.mjs                 # 全量回归（应 59/59）
node scripts/setup-doctor.mjs                   # 环境体检
node scripts/probe-peak-local.mjs               # 高峰模型真机探针
node scripts/probe-agent-tone.mjs               # 语气前后对比
node -e "const c=require('./config.json');console.log(c.socialV2.modelRouting)"
```
控制台 API（都要 `x-console-token`）：
```
GET  /api/status            GET /api/model-routing      POST /api/model-routing
GET  /api/config/reload     POST /api/config/reload     POST /api/restart
GET  /api/files/stats       GET /api/library/items      GET /api/stickers
```

---

## 8. 规矩（别破坏）

1. **不在用户测试时随意重启**；攒批重启，配置改动走热加载。
2. **测试绝不写真实 `config.json` / `state/`**（用临时目录）；C 已加写保护，别绕过。
3. **改代码后必须跑 `regression-all`**，失败不许合。
4. **`state/` 不进压缩包**；打包用 `scripts/pack-project.ps1`（精简）或 `pack-project-full.ps1`（含依赖），产物进 `<本机路径>\Downloads`。
5. **不把 token/key 写进文档或聊天**；`config.json`、`state/console-token` 只在本地。
