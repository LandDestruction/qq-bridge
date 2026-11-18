# 聊天机器人改动日志（2026-10-25 至 2026-10-26 凌晨）

> 记录人：审阅窗口（dsh）。范围：`<本机路径>\qq-bridge-src`（原 `<本机路径>\Documents\deepseek-harness\qq-bridge-src`）。
> 当日提交 **318 条**，全量清单见 [`docs/CHANGELOG-COMMITS.md`](CHANGELOG-COMMITS.md)；本文按模块叙事。
> 更早的历史（接手前的批次 1~33）见 `AUDIT-STATUS.md` §1~§32，本文只做索引，不重复抄写。

---

## 0. 起点（接手时基线）

| 项 | 状态 |
|---|---|
| main 基线 | `d64f33b` baseline（黑话自动标注、控制台 basis 标签） |
| 运行方式 | `node src/bridge.js`，控制台 `127.0.0.1:3100`，token 在 `state/console-token` |
| 网关 | WorkBuddy2API `127.0.0.1:7863` + SnowLuma `ws://127.0.0.1:3001`（账号 100000007 大肥鱼小姐） |
| 模型 | DSH `127.0.0.1:14043`（后多次变化） |
| 已知欠账 | 识图链路空转、视频/音频链路不稳、文件转存未做、表情缩略图失效、账本口径偏差 |

---

## 1. 基础设施与迁移（C 盘 → E 盘）

- **项目主体迁到 E 盘**：`<本机路径>\Documents\deepseek-harness` → `E:\deepseek-harness`；`state/files` → `<本机路径>\files`；三个工作树 → `<本机路径>\*`。C 盘旧目录保留（当时被 DSH/MCP/WorkBuddy2API 占用，无法整体改名）。
- **启动器**：`qq-bridge-src/scripts/start-bridge-hidden.vbs` 里 `Const ROOT` 从 C 改为 `<本机路径>\qq-bridge-src`（`483f967`），保证计划任务仍指向 C 路径也能拉起 E 的代码。
- **DSH 配置**：`~/.dsh/profiles/desktop/cordis.patch.yml` 三个 MCP server 路径改为 E；曾因脚本覆写把 3668 字节写坏成 661 字节（`agent-default-model`/`llm-pi-ai`/MCP 段全丢，导致 `preset "qq-chat-v2" 不在清单`），已从备份恢复并只替换路径。
- **preset 注册**：`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 增加 `qq-agent-presets` / `qq-mode-console`，重启 DSH 后 `agentPresets.list` 才出现 `qq-chat`、`qq-chat-v2`。
- **工作树重挂**：`wt-backend`/`wt-frontend`/`wt-feature` 的 `.git` 原指向 C 仓库，导致施工提交"主线看不见"；已重挂到 E 仓库（`git worktree list` 现全部 E 侧），并新建 `wt-audio`（施工 D）。
- **WorkBuddy2API**：仍在 C 盘 `default-workspace\_wb` 运行（未迁移）。
- **群名称缓存**：`state/group-names.json`（`get_group_info` 拉取，100000001 → 扣1复活牢大）。

---

## 2. 模型与视觉

| 改动 | 说明 | 提交 |
|---|---|---|
| 视觉能力实测 | 6 个模型中只有 `deepseek-account/deepseek-flash` 能收图，写进 `dsh.visionModels` | `cd2fdba` 等 |
| 视觉守卫修正确模型 | parts 构造改读 `appliedModelBySession`（`resolveTurnModel`），不再用 `activeModelOverride` 误判「无视觉」 | `f0b5fc5`/`2602f82` |
| 大图被 8MB 抓取上限卡死 | 新增 `socialV2.media.maxDownloadBytes`（默认 40MB）只管下载，`maxBytes` 收窄为送模型预算 | `e6fe77b` |
| HEIC/HEIF 支持 | `sniffHeic` + ffmpeg 转 JPEG；逐图失败打 `[media] 图N 未发送：原因` 并写进给模型的内容 | `9887096` |
| malformed tool-call JSON | 识别 `tool input is invalid JSON` → 同模型重试 → 切 `deepseek-v4-pro`（纯文字轮）→ 中性提示；含图轮保持视觉模型 | `de600c0`/`3aa0cf8` |
| 已知坏模型不再当首选 | `knownUnavailableModels` 命中直接选可用项，避免每轮先失败一次 | `5779317` |
| 模型降级链按 provider 交替 | `orderFallbacksByProvider`，避免在同一个坏池里来回跳 | `cd2fdba` |

---

## 3. 视频与语音（含 STT 服务化）

- **视频分流**：`classifyAttachment` 统一判定（当前消息/引用/文件段）；mp4 一律 `video-file`，**不再被当图片抓**（`621e084`/`37bf88b`）。
- **抽帧**：3×3 九宫格拼图（`extractFrameGrid`），4 秒 640×360 实测 170KB、归一化通过。
- **转写**：`tools/stt_cli.py`（faster-whisper，CPU int8）；`socialV2.stt = { model:'medium', lang:'zh' }` 起步，后改为视频默认 `small`。
- **两段等待**：抽帧 ≤8s、转写 ≤`stt.waitMs`（默认 90s），本轮只等 6s，迟到转写**主动补发**（`4c941cc` → 后续 `bcb3e49`）。
- **引用里的视频**：此前直接 skip 并标注「未做抽帧/转写」，导致引用视频问内容必然回「听不到」；已改为挂临时消息跑 `enrichVideoFile`（25s 上限，没赶上如实标 pending）（`4502fc9`/`95bd…` 系）。
- **常驻转写服务**（施工 D）：`tools/stt_server.py`（127.0.0.1:8791，`/health`、`/transcribe`、空闲 30 分钟卸载）+ `src/stt-service.js`（懒启动、健康检查、CLI 回退）+ `src/video-followup.js`（每视频只补发一次、状态持久化、重启不重发、minGap）。
- **实测**：16s 中文视频 冷 4.98s / 热 1.83s（旧 CLI 4.84s/次且每次重载模型）；服务热转写 1.55s。
- **迟到补发真根因**：旧回调引用了不存在的 `LongText()`，`ReferenceError` 让消息永远发不出去；已修。
- **话术**：转写中 →「语音转写中，稍后补给你」；无音轨/失败 → 明确给原因；不再出现「听不到/没声音」。

---

## 4. 文件转存（含 BOOTH 与 simpleMode）

### 4.1 基础能力（施工 C 批次 1~5）
- 新增 `src/file-archive.js`：台账 `file_archive`（`state/messages.db`）、目录 `<群号>/<YYYY-MM>/`、保留期 60/120 天、`safeResolveInside`、`sanitizeFileName`、sha256、`.tmp-*` 再 rename。
- 新增 `src/observe-learn.js`、`safeFetchBinary`、四个接口 `/api/files`、`/stats`、`/cleanup`、`/category`。
- `bot.onNotice('group_upload')` 接入；`oneBotAction('get_group_file_url')` 取直链。
- 用户规则：**只收图片 + 压缩包**，表情包永不转；上限逐步提到 **2.5GB（2560MB）**；`safeFetchToFile` 流式落盘（sha256 边写边算）。

### 4.2 命令触发（施工 C 第五批）
- 只响应 `/转存` 或「@机器人 + 转存意图词」；`group_upload` 不再自动落盘（只留 10 分钟缓存供指令引用）；纯聊天/纯引用不转。

### 4.3 BOOTH 元数据（施工 A 研究 + C 实现）
- 逆向 `vrc-booth/booth-library-manager`（`docs/booth-library-manager-reverse.md`，`ed33992`）：数据模型 = 商品（BoothItem）+ 文件数组（downloadUrls）。
- 新增 `src/booth-meta.js`（`parseBoothName`/`sniffBoothIds`/缓存 TTL）、`fetchBoothMeta`、封面 `src/booth-cover.js`（`getBoothCover`，og:image → 长边 ≤512 JPEG ≤200KB，`state/booth-cache/<id>/cover.jpg`，TTL 30 天）。
- 商品库接口（`src/library-items.js` + bridge）：`/api/library/items`（只聚合压缩包）、`/api/library/item/:boothId`（含同号图片）、`/api/library/unclassified`、`/api/library/item-thumb`；同号图片回填 `booth_id`（`scripts/backfill-image-booth.mjs`）。
- 分类映射表、年龄墙/429/404 边界、同号多文件 meta 合并、人工分类不被覆盖、`scripts/booth-e2e.mjs`。

### 4.4 退而求其次：simpleMode（当前线上生效）
- 只收**文件名以 7 位数字开头**的压缩包/图片；不抓 BOOTH、不自动分类、**不自动清理**。
- 布局：`<本机路径>\<群号_群名>\<YYYY-MM>\<文件>`；不合规 → `<本机路径>\_未分类\<群号_群名>\`。
- **2026-10-26 更新**：转存触发时按文件名开头的 **7 位 BOOTH 号**归到同名文件夹
  `<群号_群名>\<7位号>\<文件>`（同号压缩包/图片聚在一起；8 位日期/6 位号仍走 `<YYYY-MM>`）。
  存量 8 个文件已迁移（sha256 校验通过），明细见 `docs/handoff-booth-dir.md`、`scripts/migrate-simple-booth-folders.mjs`。
- 存量迁移：11 条（`9013048.zip` 合规进群目录；10 张无号图片进未分类），逐条 sha256 校验通过、台账 `rel_path` 已更新（`scripts/migrate-archive-simple-layout.mjs`，`00b9bc3`）。
- 踩坑修复：`simpleMode` 新键没被 `normalizeFileArchiveConfig` 搬运 → 出现"开了 simpleMode 清理照跑"（已修，配置白名单式构造的经典坑）。

---

## 5. 表情库（sticker）

- 表情注释页「图片已失效」：根因是面板直接打 QQ CDN 过期链接；改为 `state/sticker-files/<md5>.img` 本地缓存优先。
- 新增 `/api/stickers/thumbnail?id=`（本地 → CDN → OneBot `get_image` 回退）与 `/api/stickers/repair`。
- 去重：`dedupeStickerEntries`（读盘/合并都过一遍，md5 优先保留带缓存的条目），92 → 84 条，重复组 0（`3cdde95`）。
- 补缩略图：`scripts/repair-sticker-thumbs.mjs`（5 条修好；2 条源链 400 不可恢复，标 `thumbStatus:"missing"`）。
- 采集即落盘：观察群/收藏/同步三条入口拿到 url 立刻下载算 md5（施工 C）。

---

## 6. 观察学习

- 新增观察白名单机制：`observe.enabled=true, groups=["100000005"]`；观察优先于 allow.groups，**不唤醒/不回复**。
- 实测日志：`观察群 100000005：只学习不发言（已收集词汇）`；启用后不再出现「忽略未授权会话」。
- 只读接口 `GET /api/observe/config`（enabled/groups/learnSlang/learnStickers/description/effectiveGroups，`source` 字段），修过 `observeApiView` 漏 import 的 500。
- 控制台「观察学习」卡从「未知」改为按 `enabled` 渲染（B）。

---

## 7. 控制台 / 运维面板

- 文件转存面板：空态/失败态分离、分类下拉、失败文案统一「接口 + 状态 + 原文」、skip link、focus-visible、aria-live、标题层级。
- 台账分页：真 `offset/total`（20/50/100、页码夹边界、显示 A–B/共 N），删掉「接口正在补 offset」。
- 按群分组明细：用 `stats.byGroup` 渲染（兼容数组/单对象/缺失），空数据显示「还没有转存文件」。
- BOOTH 库页 `public/library.html`（施工 B）：商品卡片（封面/标题/店铺/文件数/分类徽标）、详情抽屉（压缩包 + 同号图片 + meta）、未分类区、搜索/筛选/排序、封面占位；`/library` 路由（修过缩略图 404 与 `image-thumb` 漏 import）。
- 表情注释页 `public/ops.html`：去重展示、缩略图来源链、失效占位+删除、只看失效筛选。

---

## 8. 账本 / 成本

- `series.totals` 统一口径（修 3.6 倍偏差，断言进 `test-token-usage`）。
- 「空 model 采样」改 **0 成本**（`priceOf` 纯函数化，7 处计价统一入口）。
- 日志刷屏修复：计数从只读路径移到摄入侧 `noteUnpriced`（首条 + 每 100 条），`/api/tokens/summary` 增 `unpricedSamples`/`unpricedCostOmitted`，重启后 `unpricedSamples=0`、`totals.cost≈48.96`。
- 契约：`/api/files` 的 `byGroup` 恒数组、`limit` 夹取、`offset` 回显；`docs/api-contract-files.md`。

---

## 9. 其它修复

- **事件流中断**：降级重试里裸 `sessionId` → `ReferenceError`，每轮降级都断流且重试从不投递；改 `frame.sessionId`（`580ce16`）。
- **媒体哈希异步**：`dhashFromBufferAsync`（spawn + 超时 kill），媒体热路径不再同步阻塞事件循环。
- **TTS 扩展名**：5 处落盘点按 `synth.ext`，加静态断言。
- **send-image 配额**：`/api/socialV2/send-image` 加冷却 + 每小时上限 + 429。
- **磁盘护栏**：`src/disk-guard.js`（2.5GB + 5GB 预留）；`stats.disk` 在目录未创建时沿祖先 statfs。
- **图片抓取上限**：8MB → 20MB（送模型预算），下载上限 40MB。
- **P2 七项**：3 修 4 误报（证据 `docs/audit-p2-status.md`）。
- **4 处合并漏 import**：`observeApiView`、`normalizeThumbWidth`/`scaleImageBuffer`、`buildLibraryItems`、`regression-all` 清单并集。

---

## 10. 工程与测试

- `scripts/regression-all.mjs` 一键回归：**45/45 套件通过**（跳过 `test-dsh-session-retire`，需活 DSH socket）。
- 新增套件（节选）：model-fallback、local-fallback、media-queue、imagegen/tiered/quota、token-usage/economy、observe-learn、file-archive、chat-file-archive、booth-parse/meta/archive/classify/merge/errors/cover、library-items、image-thumb、category-move、sticker-thumb(s)/dedupe/repair/persist、malformed-retry、attachment-classify、async-wait、stt-service/video-followup/stt-wiring/video-stt-flow、heic、tts-ext。
- 验收脚本：`scripts/verify-after-restart.mjs`（7/7）、`scripts/check-acceptance.mjs`、`scripts/migrate-archive-simple-layout.mjs`、`scripts/booth-e2e.mjs`、`scripts/probe-stt-service.mjs`。
- 施工管理：`worker-loop*.mjs`（每 3 分钟检查工作树/队列/达标条件，空闲补催），共四轮（A/B/C/D）。

---

## 11. 线上配置变更（`config.json`）

| 键 | 值 | 时间 |
|---|---|---|
| `dsh.visionModels` | `["deepseek-flash"]` | 10-25 下午 |
| `dsh.modelFallbacks` | workbuddy2api/deepseek-v4-pro → glm-5.3 → deepseek-account/deepseek-flash → scnet/… | 下午 |
| `socialV2.media.maxBytes` | `20971520`（20MB） | 20:5x |
| `socialV2.media.maxDownloadBytes` | `41943040`（40MB） | 21:0x |
| `fileArchive.maxFileMb` | `2560`（2.5GiB） | 20:40 |
| `fileArchive.groups` | `["100000001"]` | 20:14 |
| `observe` | `{enabled:true, groups:["100000005"]}` | 20:14 |
| `fileArchive.simpleMode` | `true` | 23:53 |
| `fileArchive.dir` | `E:/booth-inbox` | 00:16 |
| `socialV2.stt` | 默认（service/followUp 走默认值） | 00:0x |

---

## 12. 已知未完成 / 搁置

1. **库页封面与 simpleMode 的取舍**：simpleMode 下不抓 BOOTH，库页卡片无封面（现有 `9013048` 封面是手动补的）。三个选项待定：关 simpleMode / 只抓封面 / 保持现状。**用户已说明暂时搁置**。
2. **C 盘旧项目目录**：`<本机路径>\Documents\deepseek-harness`（879MB）仍在，被 DSH/MCP/WorkBuddy2API 占用；两个计划任务动作仍写 C 路径（靠启动器转 E）。彻底清理需管理员改任务。
3. **WorkBuddy2API** 仍从 C 盘运行。
4. **库页分页/筛选**：`offset` 已支持，但 B 的库页在 items 维度上分页依赖后端 `total`，未做无限滚动。
5. **BOOTH 抓取的年龄墙/R-18**：标 `gated` 但未做专门展示策略（待拍板）。
6. **`AUDIT-STATUS.md`** 需补 §34 指向本日志（见下一条）。

---

## 13. 2026-10-26：高峰期模型换代与稳定性修复

### 13.1 高峰期聊天模型：本地 8B → 小米 MiMo（API）
- 新增 provider xiaomi-mimo（https://api.xiaomimimo.com/v1，OpenAI 兼容），写入 DSH cordis.patch.yml，模型 mimo-v2.6-pro / mimo-v2.6-flash。
- 高峰期改为**只切模型、不拦消息**：socialV2.peakPause.agent = { enabled, provider, model }；消息照常进 agent（工具/识图/语音/画画都保留），仅在 ensureChatModel 里换模型。
- 关闭思考：请求体 	hinking: { type: 'disabled' }，实测 4.1s → **1.7s**（reasoning tokens 0）。
- 本地 ollama 路径保留但不启用（localModel.enabled=false）。
- 闸门：@/问句/8% 概率 + 同群 20s 冷却 + 10 分钟 5 条 + 30 分钟去重 + 纯媒体/过短跳过。
- 带图回合优先 deepseek-account/deepseek-flash（视觉模型），文本回合用 MiMo。

### 13.2 三个导致「叫了没反应」的缺陷
1. **高峰拦截在 agent 之前**：早期版本把高峰消息截给直连小模型，工具面与识图全部失效。已改为只切模型。
2. **DSH 重启后恢复的回合被判忙 10 分钟**：队列里的 @ 全进「会话繁忙」。改为恢复回合只给 **90 秒宽限**，到期清忙并补推排队唤醒。
3. **恢复定时器让桥接 exit 1**：遍历 state.sessions 用了 or...of（普通对象）。改 Object.entries。
- 另重置了卡死的 group:100000003 DSH 会话。

### 13.3 降级链与通知
- dsh.modelFallbacks 末尾加官方 DeepSeek deepseek-account/deepseek-v4-pro。
- 模型自动回退**只写日志**，不再私聊管理员；同一小时去重保留。

### 13.4 验收数据（2026-10-26 12:14）
`
12:13:56 group:100000003 | xiaomi-mimo/mimo-v2.6-pro | turn | 973 tok
12:14:14 group:100000003 | xiaomi-mimo/mimo-v2.6-pro | turn | 904 tok
12:14:25 group:100000001 | deepseek-account/deepseek-flash | turn | 303 tok  ← 带图
12:14:32 工具统一发送 group:100000001: 成功 2/2 条
`
- egression-all **49/49**；接口 /api/status|peak/status|files/stats|library/*|tokens/summary|stickers|slang 全 200；页面 /、/ops、/library 全 200。
- 归档 iles.active=18，布局 <本机路径>\<群号_群名>\<BOOTH号>\；归档相关 5 套测试全过。
- 指令：/stop /resume /mute /summary /todo /who /search /slang /sticker /help /persona，三级权限。

### 13.5 打包
- scripts/pack-project.ps1 → dist\qq-bridge-<时间戳>.zip + .sha256 + 包内 MANIFEST.tsv；排除 state/、config.json、
ode_modules/、.git/、*.bak*、logs/。
---

## 14. 2026-10-26：配置热加载（不重启进程）+ 重启记账

### 14.1 背景
上午为了改高峰模型反复重启桥接（日志里「控制台：重启桥接」跨天 229 条），每次重启机器人掉线十几秒；
另外有 10 次 \Error: write EOF\ 崩溃（stdout 管道被父进程关闭）与 1 次 \state.sessions\ 遍历 bug 导致的 \exit 1\。

### 14.2 做了什么
- \src/config-reload.js\：纯逻辑决定哪些字段可热替换、哪些必须重启；\planConfigReload/pinRestartOnlyFields\ 可单测。
- 桥接：\POST /api/config/reload\（手动）+ \s.watch(config.json)\ 自动（\socialV2.hotReload.enabled\，800ms 去抖）；\GET /api/config/reload\ 查状态；\/api/status.configReload\ 暴露计数与最近跳过项。
- **必须重启的字段**（磁盘改了也保持旧值并在日志/返回里提示）：\consolePort\、\sessionCwd\、\gentPreset\、\snowluma.wsUrl/httpUrl/accessToken\、\dsh.baseUrl/authToken/authHeader/authPrefix\。
- **坏 JSON 不会搞挂服务**：返回 400，内存沿用旧配置。
- \state/boot-log.jsonl\：每次启动/退出记一行；启动日志显示「今日第 N 次启动」，重启次数可精确核对。
- \stdio\ 写失败（write EOF/EPIPE）不再杀进程；文件日志照常。

### 14.3 实测
| 测试 | 结果 |
|---|---|
| 白名单加群 → reload | 立即生效，PID 不变 |
| 改 \consolePort\ → reload | \skipped: consolePort\，3100 仍可访问 |
| 坏 JSON → reload | HTTP 400，\/api/status\ 正常 |
| 单测 | \	est-config-hot-reload\ 5/5；\egression-all\ **50/50** |

### 14.4 文档
- 新增 \docs/HOT-RELOAD.md\（能/不能热更的字段表、两种用法、实测记录、何时仍需重启）。
---

## 15. 2026-10-26：安全拦截可诊断 + 高峰期模型换 flash

### 15.1 「回复被安全策略拦截」是怎么触发的
- 13:36:50 在 \group:100000004\ 触发过一次（全天仅 1 次）。拦截规则在 \src/sensitive.js\：
  只匹配 **本机路径**（\C:\...\、\/home/...\、\\\\\host\\share\）与 **凭据赋值**（\	oken=…\、\密码：…\、\earer …\）。
  普通聊天提到 "token"（如「按 token 吨位算」）**不会**命中——已用 5 组样例回归验证。
- 当时日志只写「疑似包含敏感信息」，没有说明命中哪条规则、命中了什么，无法复盘。已改：
  - 新增 \describeSensitiveMatch(text)\：返回 \{name, excerpt, length}\，\excerpt\ **首3/尾2 打码**，可安全写日志；
  - 拦截日志现在长这样：\⚠️ 回复被安全策略拦截 (group:…)：规则=windows-path 片段=E:\\***js 长度=51\；
  - 群里的提示文案改成如实描述：「含疑似敏感信息（本机路径/凭据），已被拦截、没有发出去」——
    原话「已记录并通知管理员」其实并没有单独通知管理员，属于误导，已删。
- 新增 \scripts/test-sensitive.mjs\（5 项）：窗口路径/Unix/UNC/凭据命中；正常聊天与「token 吨位」不误伤；两种判断入口结论一致。

### 15.2 高峰期模型：mimo-v2.6-pro → **mimo-v2.6-flash**
- 用户反馈 pro 比 DeepSeek 还贵，换成 flash。
- 配置：\socialV2.peakPause.agent.model = "mimo-v2.6-flash"\（\localModel.model\ 同步改，便于回退）。
- 切换用了**配置热加载**，没有重启进程（PID 不变）：
  \POST /api/config/reload\ → \{"ok":true,...}\，随后 \/api/status.peakLocal.model = "mimo-v2.6-flash"\。
- 实测探针（同一 prompt）：pro ≈ 1.5s；flash ≈ 2.0s（首次偶发空回复，重试正常）。
- \/api/status.peakLocal\ 增加 \mode\（agent/local）与 \provider\，避免再把「高峰期用的模型」看成本地模型。

### 15.3 测试
- \egression-all\：**51/51** 通过（新增 \	est-sensitive\）。

---

## 16. 2026-10-26 21:0x：loop8 退出条件修正（不再漏掉迟到提交）

### 16.1 事故
- 20:28:57 loop8 第 16 轮合并完施工 D 的 `26d5410` 后 `pending` 归零，立刻打印「🎉 所有窗口已整合完成」并退出。
- 20:43 施工 D 又提交 `4c473ba`（语气收紧：反骨只在玩梗时、正常提问正常答），**没有看护器接**，
  最后由人工合并进 main —— 这正是「提前退出漏提交」的典型。
- 顺带发现「自动重启」这步从来没成功过：日志里三次
  「重启失败：`POST /api/restart` 415 Unsupported Media Type」。根因是控制台 CSRF 闸门要求写操作
  必须 `content-type: application/json`（`src/bridge.js` 4753-4758），而循环脚本发的是裸 POST。

### 16.2 改动（工具在 `default-workspace`，不在本仓库）
- 新增 `loop8-decide.mjs`：把退出判定抽成纯函数 `roundVerdict(prevQuiet, {newCommits, merged, pending})`
  与 `trackHeads(prevSeen, heads, aheadByKey)`，无 IO、可单测。
- `worker-loop8.mjs` 改为：**连续 8 轮「无新提交 + 无新合并 + 无在途任务」才退出**（8 × 2 分钟 ≈ 16 分钟宽限，
  按 20:28→20:43 那 15 分钟迟到提交的教训定；用户 21:0x 拍板 8 轮），任一轮有动静计数归零；
  在途任务（脏工作树 / 产物未达标 / 冲突 / 回归失败重试）期间不累积安静轮次。
  「新提交」= 分支 head 相对上一轮变了 **且** `main..branch` 仍有增量（第一次见到的 head 不算，避免启动即误判）。
- **默认不自动重启**：合并进来的改动含 `src/`、`public/` 时只登记 `needsRestart` 并提示，
  由人挑时间 `POST /api/restart`（理由是正在群里测试时不能被看护器打断）；`LOOP8_AUTO_RESTART=1` 恢复自动。
- 重启链路修好：`consolePost()` 带 JSON body + `content-type`；重启后轮询 `/api/status`，
  并用 `state/boot-log.jsonl` 出现**新 pid** 作为「真的换成新进程」的证据；未连上 SnowLuma 只警告不重复重启。
- 旋钮：`LOOP8_EXIT_QUIET_ROUNDS`(8) / `MAX_ROUNDS`(30) / `LOOP8_SLEEP_MS`(120000) / `LOOP8_DRY=1` / `LOOP8_AUTO_RESTART`(off)。

### 16.3 验证
| 项 | 结果 |
|---|---|
| `node worker-loop8-selftest.mjs` | **6/6**（含 20:28 事故复盘：第 16 轮合并 D → 安静 7 轮 → 第 24 轮迟到提交 → 第 25 轮合并 → 第 33 轮才退出；在途 50 轮不退出） |
| 真机 dry-run（`LOOP8_DRY=1`，1.5s/轮） | 第 8 轮安静后退出，四个窗口判定 A/B/C 已合并、D 无新提交 |
| 真机短间隔跑（1~2s/轮，真判定不 dry） | 同上（8/8 → 退出），`worker-loop8-state.json` 正常写 `merged`/`seen`，无误合并、无重启 |
| CSRF 闸门对照 | 裸 POST `/api/config/reload` → **415**；带 JSON body+content-type → **200**（证明重启失败根因） |
| `regression-all` | **59/59**（本次只动 docs 与 default-workspace 工具，源码未改，无需重启桥接） |

### 16.4 设计取舍（记下来别改回去）
- 宽限 8 轮 = 16 分钟 > 15 分钟迟到窗口；再长会让「确实做完了」的看护器多占一小时。
- 自动重启默认关：重启会让机器人掉线 5~15 秒，用户正在群里测试时属于不可接受打扰；
  宁可留 `needsRestart` 提示，也不自动踢进程。

---

## 17. 2026-10-26 21:1x：面板保存把模型路由清空（**实为线上 bug**）

### 17.1 现象与真机证据
交接文档 §6-2 记的是「面板保存后下拉全空（B 已修，待用户确认）」。做真机自测时复现了更深的一层：

```
POST /api/model-routing  {"idle":"workbuddy2api/deepseek-v4.1-flash","peak":"xiaomi-mimo/mimo-v2.6-flash", ...}
→ config.json 的 socialV2.modelRouting 变成 {"idle":null,"peak":null,"fallback":[],"disabled":[]}
→ 下一轮 ensureChatModel 只能退回 dsh 默认模型（群里表现：换的模型没生效 / 高峰没切）
```
根因：`public/ops.html` 的下拉值统一是 **`"provider/model"` 字符串**（`routingKey()`），
而 `src/model-routing.js` 的 `normOne` **只认 `{provider,model}` 对象**，字符串一律判 `null` 丢弃。
B 之前修的是前端「GET 失败不清选项」的显示层，后端这一刀一直没修 —— 所以「保存」本身就是破坏性操作。

### 17.2 改动
- `src/model-routing.js`：新增并导出 `normalizeModelRef(v)`，**对象与 `"provider/model"` 字符串都收**
  （超长/残缺/数组等一律返回 null，不抛）。
- `src/bridge.js` `POST /api/model-routing` 加两道闸门：
  - **解析守卫**：请求里给的候选解析不出 provider/model → 400 并列出是哪一项（不再静默写 null）；
  - **清空守卫**：磁盘本来有路由，而这次会把 `idle`/`peak`/`fallback` 一起清空 → 400 拒绝（要真清空得显式带 `allowEmpty:true`）。
- 新增真机往返探针 `scripts/probe-model-routing-live.mjs`：GET → POST（**用面板那种字符串形态**）→ GET → 断言
  「options 仍非空、选中值还在、config.json 除 modelRouting 外没被动过、allow/observe 没丢」。
  这条脚本就是「保存后下拉全空」的端到端回归，顺带守住「写 config 不能清掉别的段」。
- `.gitignore` 补 `dist/`（打包产物）与 `logs/`（跨天日志），仓库里不再冒出未跟踪目录。
- 契约文档 `docs/api-contract-model.md` §6 补两种候选写法、两道 400 与本次事故说明。

### 17.3 验证
| 项 | 结果 |
|---|---|
| `test-model-routing.mjs` | 12 项全过（新增：字符串归一、残缺输入不抛、面板字符串载荷不再被清空） |
| `test-model-api-contract.mjs` | **21/21**（新增两条静态断言：解析守卫、清空守卫） |
| `regression-all` | **59/59** |
| 线上配置 | 事故当晚被这次探针写空过一次，已从快照恢复 `idle=workbuddy2api/deepseek-v4.1-flash`、`peak=xiaomi-mimo/mimo-v2.6-flash`、1 条 fallback，`/api/config/reload` 后 `effective` 回到 idle |
| 重启 + 真机复测 | 21:2x 重启桥接（pid 11860 → 101368，**3 秒**恢复，mode=reserved2、dshReady=true、SnowLuma 已连），随后 `probe-model-routing-live.mjs` **18/18**，`config.json` 除 modelRouting 外零变化 |

### 17.4 教训
- 「前端已修」不等于「这条链路好了」：前端只是把损坏的数据显示得不那么难看，写入侧仍会把路由清空。
  以后遇到「保存后显示异常」，先看**保存写进 config 的到底是什么**。
- 白名单式 `loadConfig` 之外，**解析器只认单一形态**同样会静默丢数据；对外的写接口要「要么解析成功，要么 400」。

---

## 18. 2026-10-26 深夜：三处用户直报问题 + 打包闸门

> 今晚三件用户直报（看不见图片 / 表情双卡 / 重启忘摘要）的共同点：**链路上某一层悄悄把东西丢了，日志本身看着正常**。
> 三处都只改 `src/` 与 `scripts/`，**必须重启桥接才生效**；23:39:10 已重启一次（pid 101368 → 110400，main 自 `bdd97fc` 起含全部三项）。
> 五个提交：`d6eb709`（M1）、`4cc0a0d`（M2）、`0b56981`（T12）、`ea51f9b`（T13），回归闸 `e9857b0`（D11）。

### 18.1 看不见图片（M1，`d6eb709`）

**现象**：群友发图，机器人回「图我还是看不见，只能听你描述」。

**真机证据链**（缺一不可，全部来自只读取证）：
1. `state/tool-calls.jsonl`：`mcp__snowluma__qq_get_message_images` 是 **`ok:true`** —— 桥接确实把图取回并归一化
   （同日 `bridge.log` 有 `[media] 图片1: 动图 60 帧/2.0s，已抽 6 帧拼成 3×2 网格`）。
2. 但 DSH 侧工具结果是：
   `[image unavailable: image/jpeg; model "deepseek-v4.1-flash" does not declare image input]` —— 图被换成了这行字。
3. 同一轮 `state/token-usage.jsonl` 记的模型是 `workbuddy2api/deepseek-v4.1-flash`，而
   `config.dsh.visionModels` 只有 `["deepseek-flash"]`。

**根因（两条，叠在一起）**：
- **选型层**（`src/bridge.js` `ensureChatModel` / `keyHasRecentMedia`）：reserved2 模式下图片**不经 prompt parts**，
  是模型调 `qq_get_message_images` 之后才回来的；而「这一轮算不算含图轮」只看 socialV2 状态里
  **最近 3 条 unread + 最近 2 条 recentMessages**的 `hasMedia` 标志。图稍微靠前（或 unread 已被 mark_read 清掉）
  就判成「无图」→ 用空闲模型去调图片工具 → DSH 拒绝收图。另一处：`ensureChatModel` 的「本 epoch 已应用」早退
  会让同一会话在**刚对齐过模型**的下一秒不再重选，即使这轮真来了图。
- **parts 层**（`src/bridge.js` `resolveMediaList`）：`imagePartsAllowed` 是 `if (media.kind === 'face')` 分支里的
  **块级 `const`**，普通图片分支却在后面读同名变量 → `ReferenceError: imagePartsAllowed is not defined`；
  同一段还引用了这个函数里根本不存在的 `sessionId` → `sessionId is not defined`。两处都让内联含图消息整轮抛异常。

**改法**：
- 新增 `src/media-turn.js`（纯函数 + Map，TTL 10 分钟）：`noteMediaTurn/isFreshMediaTurn`，回答「这个会话最近出现过图吗」。
  `mediaHintFor()` 在拼「本条消息含 N 个图片/表情，去调 `qq_get_message_images`」这句提示时记一笔；
  `keyHasRecentMedia()` 优先认这个标记，再回落到状态窗口。
- `ensureChatModel()`：这一轮有图、且**已应用模型看不了图**时作废「本 epoch 已应用」缓存，强制重选
  （选到 `socialV2.modelForMedia = deepseek-account/deepseek-flash`）。
- `resolveMediaList()`：把「本轮生效模型 + 能否塞 image part」提到循环外算一次，两条分支共用；
  会话 id 改由 `key` 从 `state.sessions` 解析（原来那个不存在的 `sessionId` 删掉）；
  普通图片分支补上「当前模型看不了图，不要猜画面」的文字说明（与表情分支对齐）。
- `scripts/audit-bridge-harness.mjs`：VM 沙箱里 import 会被剥掉，补注入 `media-turn`，否则 harness 里一调用就 ReferenceError。

**验证**：
| 项 | 结果 |
|---|---|
| 新增 `scripts/test-image-vision-routing.mjs` | **32/32**（含「从 `bridge.js` 抽出真实 `resolveMediaList` 在 vm 里跑」，修复前该用例必抛 `ReferenceError`；修复后 1 张图 = 2 个 part、2 张 = 4 个） |
| `test-media-normalize` | ALL PASS（含「桥接 `resolveMediaList` 一代内联同样出图」） |
| `test-audit-bridge` / `test-audit-regressions` | 全 PASS |
| `test-model-fallback` / `test-model-routing` / `test-media-queue` | 59/59 / 通过 / 通过 |

**待补**：重启后到目前还没有含图轮（`tool-calls.jsonl` 自 23:39:10 起无 `qq_get_message_images`），
所以「`ok:true` 且其后模型为 `deepseek-account/deepseek-flash`」这条端到端对照**还没拿到真机样本**；
已有间接证据：`bridge.log` 23:37:43 `[模型] 选择 source=media deepseek-account/deepseek-flash（带图强制）`、
23:41:33 `[视觉] 本轮含图，当前模型 … 不支持图片，已切到 deepseek-account/deepseek-flash`。
用户发一张图并 @ 机器人后即可补记。

### 18.2 面板表情收集出现双卡（M2，`4cc0a0d`）

**现象**：面板「表情包注释」196 条里，有 **11 对**视觉上是同一张的表情各自成卡。

**根因（三个叠加）**：
1. 同一张图被 QQ 重编码后 **md5 变了**，只有 dHash 认得出；但 `collectSticker` 从不写 `dhash`
   （196 条里仅 53 条有），`src/bridge.js` 里的兜底比对等于白跑。
2. dedupe 的 dhash 分支要求字符串**完全相等**，差 1 bit 的同一张图漏掉。
3. `stickerUrlKey` 丢掉整个 query，而 **122 条**表情共用 `multimedia.nt.qq.com.cn/download`，
   身份其实全在 `fileid` 里。

**改法**（`src/sticker-lib.js` +112 / `src/bridge.js` +18）：
- dhash 改**汉明距离聚类**，阈值 1 —— 实测差 0~1 是同一张，差 4 是两张不同的白底文字截图（误并会丢卡）。
- `collectSticker` / `persistStickerThumb` 落 `dhash`。
- `stickerUrlKey` 以 `fileid` 作身份；`formatStickerList` 读取路径也去重。
- 新增 `scripts/backfill-sticker-dhash.mjs`：先备份再补 hash + 合并（默认 dry-run）。

**验证**：`test-sticker-dedupe` **27/27**、`test-sticker-persist` 9/9、`test-sticker-thumbs` 20/20、
`test-sticker-thumb` 20/20、`test-sticker-repair` 5/5；backfill 预演 **196 → 186**。
**需重启**；重启后 `persistMissingStickerThumbs` 每轮补 60 条 dHash，两三轮自动收敛并合并
（23:39:15 日志已见 `[sticker] 已补齐 60 条表情的视觉指纹（dHash）`）。

### 18.3 重启就忘掉跨会话摘要（T12，`0b56981`）

**现象**：刚重启时问「别的群最近聊了啥」，问不出来。

**根因**：`saveSocialV2State()` 只写会话状态，**不写 digests**；摘要一直只活在进程内存里，重启即清空
（审计结论见 `docs/cross-session-verify.md`）。

**改法**：`src/cross-session-memory.js` 新增 `digestSnapshot` / `normalizeDigests`
（丢坏条目、丢 >24h、最多 50 会话、不改原对象）；`saveSocialV2State` 落盘 `digests`，
`loadMemoryLayers` 改用 `normalizeDigests` 读回。

**验证**：`test-cross-session-memory` **15/15**（含真写临时目录的「写盘 → 重载 → 摘要仍在」往返）、
`probe-cross-session --selftest` 13/13、`test-memory-layers` 25/25、`test-context-continuity` 通过、
`test-regression-guards` 10/10。**需重启**。
重启后 `state` 顶层的 `digests` 键出现即为结构性证据（旧代码没有这个键）；
注意计数也在内存里，重启后每会话要**再收满 20 条**入站才生成第一条摘要，所以「重启后立刻没有摘要」属预期。

### 18.4 打包排除清单化 + 回归闸（T13 `ea51f9b` / D11 `e9857b0`）

**问题**：排除规则散在 `pack-project*.ps1` 里、缺项没人发现，**23 个敏感文件 23/23 会进包**
（`state/`、本机路径等）；而清单本身是纯数据，删错一条不会有任何测试报错。

**改法**：
- 排除规则搬进 **`scripts/pack-exclude.json`（单一真源）**，两个打包脚本共用；新增 `-DryRun`
  （只 stage + 校验、不产包），**写 zip 前强制**跑 `pack-egress-scan --stage`，不通过直接 throw。
- 顺带修 full 包误删 `node_modules/*/dist`（2029 文件）与 `privacy-scan` 的 2 处高熵误报。
- 新增 `scripts/test-pack-exclude.mjs`（D11）：**双轨探针** —— CONTRACT 写死 36 个「无论清单怎么改都不许进包」
  的样本 + 按清单增量生成的 37 条规则探针；用真实 `pack-project*.ps1 -DryRun` 出 stage、真实
  `pack-egress-scan --stage` 判定（本文件不实现 glob→正则）。

**验证**：`pack-egress-scan --selftest` **21/21**；normal `-DryRun` stage 355 文件 0 违规、
full `-DryRun` stage 4645 文件 0 违规且 `node_modules/*/dist` 保住；stage 内 `privacy-scan` 0 处；
`test-pack-exclude` **26/26**；变异测试（临时删掉清单里 `*.log` 规则）→ 套件 exit 1、
闸门报「1 个敏感文件名进了 stage」，还原后复跑 26/26 且 git 干净。不改运行期，**无需重启**。

### 18.5 这一批的共性教训

- **「日志有输出」不等于「这一步成功了」**：`[media] 图片1: → 1280×720` 只是归一化打完收工，
  后面 parts 构造抛异常、模型没有视觉能力，日志都不会替你喊疼。判断成功要看**下游**（DSH 工具结果、账本 model）。
- **块级作用域 + 闭包变量名**是这类高频事故的温床：`imagePartsAllowed` 与 `sessionId` 两个 ReferenceError
  都不是类型错误，`node --check` 查不出来；抽出真实函数在 vm 里跑一遍（不复制逻辑）比读代码可靠。
- **跨模块状态要写「何时算出现过」**，别靠“最近 N 条”猜：reserved2 的图在工具结果里，状态窗口天生看不到。
- 改 `src/` 的三项（M1/M2/T12）都**必须重启**才生效；改打包脚本（T13/D11）不用。

---

## 19. 2026-10-27 中午：语气真机确认收尾（T8，3/3 合格）

> 用户配合在三个白名单群各发一句，主窗口从 `state/social-v2.json` 捞实际回复并逐条判定。
> 本项**只补记录，不改代码、无需重启**；核对器与清单是 T8 早前交付的成果。

| # | 时间 / 群 | 输入 | 实际回复（摘要） | 判定 |
|---|---|---|---|---|
| 1 | 12:23:53 `group:100000001` | 推荐部电影 | 《看不见的客人》，反转一个接一个；想轻松点就看《白日梦想家》 | ✓ 真给片名 + 理由，没泛泛而谈 |
| 2 | 12:24:18 `group:100000002` | 你是不是傻，别在这烦人 | 「行，那我少吵一点」（8 字） | ✓ 没反击、没说教 |
| 3 | 12:24:07 `group:100000004` | 换个傲娇人设 | `/persona` 引导文案（与设计文案逐字一致） | ✓ 没自己演、直接指路 |

**核对命令**：`node scripts/check-tone-replies.mjs --in <本机路径>\Downloads\tone-live.json`
→ **✓ 3/3 条回复合格**（要推荐 / 被骂 / 人设 三项全过）。

**结论**：`docs/tone-live-checklist.md` 的三条验收（真给内容 / 被骂不反击 / 换人设不自己演）在真机全部成立；T8 收口，不再重发群消息复验。