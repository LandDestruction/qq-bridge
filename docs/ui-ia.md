# 客户端信息架构（IA）与首启向导 —— 上游设计

> 任务：T18 / owner w5（gen3）｜基线：`c496376`（= main）｜产出：本文 + `docs/ui-wizard.md`
> 读者：w4（T16 外壳）、w2（T17 安装包）。**本文只定结构与接口预算，不写代码、不改 `src/` `public/`。**

## 0. 一句话结论

现有 `public/` 三页（console 387KB / ops 1384 行 / library 33KB）把「日常聊天运维」和「一次性安装配置」混在同一层，
导航项按**实现批次**（一代/二代、V1/V2）切分而不是按**用户任务**切分。新客户端按 9 个一级导航重组，
**每个面板都能落到已存在的 GET 路由上**（表内引用 55 条路由实测 54 条字面量命中、1 条为前缀分发，见 §7），
真正缺的只有 10 条 API（§3），**每条都给了不写服务端也能做的降级方案**，其中只有 #1/#3/#4 真正影响首屏体验。

## 1. 口径与约束

- 一级导航 **≤9 项**，扁平、无二级菜单（移动端/小窗可收缩成图标条）。
- 每一项**必须**至少绑定 1 条**已存在**的 GET 路由；拿不到数据的项不进导航，进 §3 缺 API 表。
- 设置类写操作沿用现有 POST 语义（`x-console-token` 鉴权，带 `x-agent-*` 一律 403），新客户端**不新增写路径**。
- 真实群号 / QQ / 令牌只活在本地 `config.json` 与 `state/`；文档、截图、示例一律占位符。

## 2. 一级导航（9 项）

| # | 导航 | 面板职责（一句话） | 现有 GET API（实测存在） | 对应旧页面哪一块 | 缺什么 |
|---|---|---|---|---|---|
| 1 | **仪表盘** | 回答「现在能不能用」：通道、DSH、模型、花费、自检四盏灯 + 一键体检 | `/api/status`<br>`/api/ops/services`<br>`/api/ops/status`<br>`/api/self-check/last`<br>`/api/tokens/summary`<br>`/api/debug/budget`<br>`/api/peak/status`<br>`/api/storage/stats` | console `overview`（运行总览、metric 卡片）；ops.html 顶部 bridge/DSH/SnowLuma 三灯 + 「机器人自检（九组）」卡 | 无「首启是否已完成」端点（§3-1）；无实时指标流（§3-4） |
| 2 | **会话** | 群/私聊列表 → 单个会话的消息、未读、唤醒配置 | `/api/sessions`<br>`/api/pending`<br>`/api/socialV2/states`<br>`/api/socialV2/state`<br>`/api/socialV2/recent`<br>`/api/socialV2/unread`<br>`/api/socialV2/message-detail`<br>`/api/socialV2/group-members`<br>`/api/socialV2/active-members` | console `sessions`（会话与审批 + `pendingCount` 角标）、`social-v2` 的消息区 | 无按关键词查历史的 GET（§3-9）；`recent` 的 `limit`/`offset` 只能翻**内存窗口** `recentMessages`，翻不到更早 |
| 3 | **人设** | 角色卡、人格/角色模式、仿真提示词与其备份 | `/api/roles`<br>`/api/roles/content`<br>`/api/preset/sim-prompt`<br>`/api/socialV2/prompt`<br>`/api/presets` | console `persona`（人格与角色）、`section-persona`、`section-mode` | 无角色卡字段级校验；无 diff 视图（§3-7 的 schema 缺口） |
| 4 | **记忆** | 轻量记忆、共享事件、好感度、黑话词库四块 | `/api/socialV2/memory`<br>`/api/affinity`<br>`/api/slang`<br>`/api/socialV2/slang/query` | console `slang`（黑话词库）+ 记忆区；ops.html「黑话库升权」「好感度」相关卡 | 记忆事件只有 POST 写入，无时间线读接口（§3-9 同源缺口） |
| 5 | **表情** | 表情库（缩略图/注释/去重）、语音库 | `/api/stickers`<br>`/api/socialV2/sticker-list`<br>`/api/stickers/thumbnail`<br>`/api/socialV2/voices`<br>`/api/voice/list` | ops.html「表情包注释（不注释就不能发）」；console 表情/发送区 | 无批量读接口；`/api/stickers` 只接受 `count`（≤1000）与 `query`，没有 `offset`/游标 |
| 6 | **文件库** | 归档文件浏览、booth 详情、分类与统计 | `/api/files`<br>`/api/files/lists`<br>`/api/files/stats`<br>`/api/library/items`<br>`/api/library/unclassified`<br>`/api/observe/config`<br>`/api/files/thumb` | `library.html` 整页（筛选栏 + 「商品详情」抽屉） | 无（这一页最完整，可直接搬信息结构） |
| 7 | **AI 黑名单** | 防 AI 互相接话：名单、模式、冷却、今日跳过数 | `/api/socialV2/ai-blacklist` | ops.html「AI 黑名单（别跟别的 AI 接成永动机）」卡 | 只有 `stats.skippedToday` 汇总，无按 QQ 的历史明细 |
| 8 | **日志** | 工具调用、token 流水、AI 反馈、bridge 尾部日志四路排查 | `/api/socialV2/tool-log`<br>`/api/tokens/recent`<br>`/api/tokens/turns`<br>`/api/tokens/series`<br>`/api/socialV2/feedback`<br>`/api/ops/status`（含 `logLines`） | console `operations`（调试与运维）；ops.html「最近日志（state/bridge.log 尾部）」 | **无流式推送、无 `/api/logs`、无级别过滤**（§3-4/§3-5） |
| 9 | **设置** | QQ 通道、DSH/模型、白名单、控制台令牌、热加载状态 | `/api/socialV2/config`<br>`/api/security`<br>`/api/whitelist`<br>`/api/dsh/models`<br>`/api/dsh/model`<br>`/api/models`<br>`/api/model-routing`<br>`/api/config/reload`<br>`/api/socialV2/activity`<br>`/api/socialV2/private-quota` | console `access`（访问与安全）+ `usage`（令牌与花费）+ `reference`（工具参考） | 无脱敏整份配置只读视图（§3-3）；无字段元数据（§3-7） |

**旧导航 → 新导航的归一**：`overview→仪表盘`；`sessions→会话`；`persona→人设`；`social-v2 / social-v1→会话`（一代/二代是行为开关，不是两个页面，收进「会话→该会话的唤醒配置」）；`slang→记忆`；`usage→仪表盘（花费卡）+ 日志（流水）`；`access→设置`；`operations→日志 + 仪表盘（自检）`；`reference→设置（只读区）`。

## 3. 缺的 API（10 条，按阻塞程度排序）

「谁补」一栏：`src/bridge/console/*` 属服务端路由，本任务不碰；需要主窗口按单派给能改 `src/` 的窗口（W1/W2/W3/W4/W6）。

| # | 缺什么 | 缺在哪 | 谁补 | 不补的降级方案（T16 可直接用） |
|---|---|---|---|---|
| 1 | `GET /api/setup/state` —— 首启进度（通道/DSH/模型/白名单四项是否已配） | 无任何端点；现有信息散在 3 个接口 | 服务端（console 路由） | 前端并发打 `/api/status` + `/api/whitelist` + `/api/dsh/models`，判定式：`dshReady===true && allowGroups.length>0 && ownerQQ!=null && models.source!=='error'` → 认为已配置，直接跳仪表盘 |
| 2 | `POST /api/setup/probe` —— 单步连通性探测（snowluma / dsh / model 分开） | 只有 `/api/self-check` 九组整跑（且结果是「快照」落盘） | 服务端 | 用 `POST /api/self-check` 后从 `report.groups`（**数组**）里取 `id` 为 `snowluma` / `dsh` / `config` 的组；代价是每次要跑完整九组 |
| 3 | `GET /api/config`（脱敏整份只读） | 只有 `/api/security` 的安全子集 + 各专用端点 | 服务端 | `/api/whitelist` + `/api/status` + `/api/dsh/models` 三份拼出「向导要回显的字段」；其余字段桌面端读本地 `config.json` |
| 4 | `GET /api/logs/stream`（SSE/WebSocket 实时流） | 全仓 `grep -c 'text/event-stream\|EventSource'` = **0** | 服务端（需保活与背压设计） | 2 秒轮询 `/api/ops/status` 取 `logLines`，前端做「暂停滚动/继续」纯本地实现 |
| 5 | `GET /api/logs?level=&since=&limit=`（按级别/时间过滤） | 无 `/api/logs`；`/api/ops/status` 只给固定尾部 | 服务端 | 客户端取回尾部后**本地**按级别正则过滤；时间范围靠 `/api/tokens/recent`、`/api/tokens/series`（支持 `hours`/`buckets`/`limit`） |
| 6 | `POST /api/confirm`（危险操作二次确认令牌） | `/api/restart`、`/api/files/cleanup`、`/api/slang/clear` 等均为裸 POST | 服务端（建议与 `RESTART_REQUIRED_PATHS` 同一张表驱动） | 前端本地二次确认（输入操作名才放行）+ 操作后读 `/api/status` 复核；**不提供一键连点** |
| 7 | `GET /api/config/schema`（字段类型/默认值/是否需重启） | 需重启的路径常量只在源码里 | 服务端 | 向导内置静态清单（`config.template.json` + 本文 §「需重启的键」），每个版本随包更新 |
| 8 | `GET /api/snowluma/health`（真打一次 OneBot `get_login_info`） | `/api/status.snowluma` 是**快照**，可能陈旧 | 服务端 | `POST /api/self-check` 的 snowluma 组；或客户端直连 `snowluma.httpUrl` 探测 |
| 9 | `GET /api/socialV2/search?q=`（历史关键词检索） | 检索能力只在 MCP 工具（`qq_search_history`），浏览器调不到 | 服务端（桥接已有归档库，成本低） | `POST /api/socialV2/recall`（按 7 天归档检索）+ 前端二次筛选 |
| 10 | `GET /api/setup/import/scan`（扫描旧 `config.json` / `setup-dsh` 产物） | 无 | **不必补**：桌面客户端有本地文件权限 | 客户端本地读文件 → 字段映射（见 `docs/ui-wizard.md` §5），不经 bridge |

> 结论：**10 条里只有 #1/#3/#4 真正影响 T16 首屏体验**；#4 是唯一的性能项（轮询 vs 流），其余都能前端降级。

## 4. 页面跳转图（文字版）

```
[首启向导] ──检测到已配置──> [仪表盘]
    │  ①QQ通道 ②DSH ③模型 ④白名单
    └─每步「测试连接」─失败─> 行内错误 + 重试 / 跳过（写进向导状态，仪表盘继续报红）

[仪表盘]
  ├─ 灯红（通道）──> [设置]QQ通道        ├─ 灯红（DSH）──> [设置]DSH与模型
  ├─ 灯红（自检 fail）──> [日志]（带筛选条件）
  ├─ 花费卡 ──> [日志] token 流水
  └─ 会话数 ──> [会话]

[会话] ──选会话──> 会话详情
  ├─ 消息/未读/成员
  ├─ 「这条怎么回的」──> [日志]（tool-log，按 messageId 预筛）
  ├─ 人设/唤醒 ──> [人设]
  ├─ 表情收藏 ──> [表情]
  └─ 附件/归档 ──> [文件库]（带 boothId 预筛）

[记忆] ├─ 好感度 ──> 会话详情（同人）
       └─ 黑话库 ──> 词条详情（升权/禁用）

[设置] ├─ QQ通道 / DSH / 模型 / 密钥（需重启的键单独标红）
       ├─ 白名单 / ownerQQ ──> 保存后回读 /api/whitelist 逐字段比对
       ├─ AI 黑名单 ──> [AI 黑名单]
       └─ 高级（重启 / 清空 / 导出）──> 二次确认 ──> [日志]
```

规则：**任何面板最多一跳到达**（`仪表盘 → X`），不允许「设置 → 子设置 → 子子设置」；需要三跳的信息用抽屉（沿用 `library.html` 的 drawer 心智）。

## 5. 鉴权与可见性口径（照抄现有实现，不新造）

- 管理端一律 `x-console-token`；带 `x-agent-call` / `x-agent-token` 的请求在管理接口上 **403 `admin_only`**
  （`/api/affinity`、`/api/socialV2/ai-blacklist`、`/api/self-check*` 都这么判，客户端**不要**试图绕）。
- `GET /api/status` 有**两套视图**：带 agent 头只返回 `mode/role/roleMode/dshReady/socialV2Paused`；
  无 agent 头才有 `ownerQQ / allowGroups / allowPrivate / snowluma / sttService / budget / activity`。
  → 仪表盘的灯**必须**用无 agent 头的请求，否则字段全空，会被误判成「都没配」。
- 危险操作（`/api/restart`、`/api/files/cleanup`、`/api/slang/clear`、`/api/socialV2/reset`）都在**设置→高级**，
  且必须走 §3-6 的前端二次确认；结果一律进「日志」页留痕。

## 6. 对照 NapCat WebUI：可借鉴 8 条、不借鉴 5 条

> 只读参考 `NapNeko/NapCatQQ` `v4.8.111` 的 `napcat.webui/`（React19 + HeroUI + Tailwind + Vite + ECharts + xterm + Monaco + qrcode.react）。
> **本文不含其截图、文案、代码**，只写结构文字描述 + 链接；其许可是**限制性许可**（禁商业、修改后不得公开、默认禁复制），
> 我方交付包是 MIT，**不引入任何其代码或资源**。参考链接：
> <https://github.com/NapNeko/NapCatQQ/tree/v4.8.111/napcat.webui> ·
> <https://github.com/NapNeko/NapCatQQ/blob/v4.8.111/LICENSE>

### 可借鉴（8）

| # | 做法（文字描述） | 为什么适合我们 | 落地到哪一项 |
|---|---|---|---|
| 1 | 路由层把「WebUI 令牌登录」与「QQ 账号扫码登录」拆成两个独立页面，未认证由守卫统一踢回登录页 | 我们的失败面本来就分两层（控制台令牌 / QQ 通道），分开后错误文案不会互相污染 | 向导 ①、设置 |
| 2 | 守卫支持 URL 带令牌直达（`?token=`） | 安装包生成的快捷方式可自带令牌，省一次输入；我们只允许**一次性**令牌换取会话，不用长效明文 | T17 安装包 |
| 3 | 登录后首屏固定是「概览」，不是配置页 | 用户 90% 时间在确认「有没有坏」，配置是低频路径 | 仪表盘 |
| 4 | 一级导航扁平 8 项、无二级菜单（首页/网络/配置/日志/调试/文件/终端/关于） | 与我们要的 ≤9 项吻合，验证了「扁平 + 抽屉」在同类产品上可维护 | 全部 |
| 5 | 配置按**域**拆子页（登录 / OneBot / 服务器 / WebUI / 主题 / 改密码 各一个文件），不是一个巨型表单 | 我们配置键多且分属不同生效方式（热加载 vs 重启），按域拆才能标出「这页保存要重启」 | 设置 |
| 6 | 日志页明确分「实时 / 历史」两个 Tab：实时流是看现象，历史是按文件回看 | 我们正好缺流（§3-4），但两段式心智可以先落地：实时=轮询尾部，历史=`/api/tokens/*` 区间查询 | 日志 |
| 7 | 扫码页固定 3 秒轮询登录状态，成功即 toast + 跳首页，不留在登录页 | 我们的向导「测试连接」同样是被动轮询，节奏可直接复用（3s 起步、退避到 5s） | 向导 ① |
| 8 | 调试（HTTP/WS）/ 终端这类危险能力**独立成页**，不与日常配置混排 | 我们把「重启/清空/导出」放设置末级并单独留痕，同理 | 设置→高级 |

### 不借鉴（5）

| # | 做法 | 原因（分类 + 说明） |
|---|---|---|
| 1 | 拷贝其组件、样式、文案、截图或图标 | **许可**：Limited Redistribution License —— 默认禁复制、禁商业、修改后不得公开；我方 MIT 交付包一旦混入即不可分发 |
| 2 | 终端页（xterm + 服务端 shell） | **成本/安全**：等于在 HTTP 上暴露任意命令执行；我们按最小权限设计（白名单群 + 控制台令牌），桌面客户端不需要，且出事无法回滚 |
| 3 | 网络页那套「多套 OneBot ws/http 端点矩阵」手工编辑 | **架构不匹配**：我们只有 SnowLuma 单一网关 + `followDiscoveredEndpoint` 自动发现，手配矩阵只会产生「配了但没生效」的假配置 |
| 4 | 主题/换肤/音频/3D 卡片等装饰层 | **成本**：HeroUI + 动效组件树换不来可用性；我们交付包要求离线可用、体积可控（现 `public/` 是纯静态单文件） |
| 5 | 扫码页的登录状态实现（只有「已登录 / 刷新二维码」两态，无过期、无失败态，靠 3s 轮询无限重试） | **不借鉴其实现（但要求比它强）**：我们要显式状态机——`等待扫码 / 已扫待确认 / 成功 / 过期 / 失败`，每个状态给不同文案与出口（见 `docs/ui-wizard.md` §6） |

## 7. 核对命令与本次结果（可复跑）

在仓库根目录执行（PowerShell；bash 把 `Sort-Object` 换成 `sort -u`）：

```powershell
# 1) 真实路由字面量总数
git grep -hoE "'/api/[A-Za-z0-9/_.:-]+'" -- "src/bridge/**/*.js" "src/bridge.js" |
  ForEach-Object { $_.Trim("'") } | Sort-Object -Unique | Measure-Object |
  Select-Object -ExpandProperty Count
```

```powershell
# 2) 本表 53 条引用路由逐条核对（缺哪条会打印 MISSING）
$uniq = git grep -hoE "'/api/[A-Za-z0-9/_.:-]+'" -- "src/bridge/**/*.js" "src/bridge.js" |
  ForEach-Object { $_.Trim("'") } | Sort-Object -Unique
$routes = @('/api/status','/api/ops/services','/api/ops/status','/api/self-check/last','/api/self-check',
  '/api/tokens/summary','/api/debug/budget','/api/peak/status','/api/storage/stats','/api/sessions',
  '/api/pending','/api/socialV2/states','/api/socialV2/state','/api/socialV2/recent','/api/socialV2/unread',
  '/api/socialV2/message-detail','/api/socialV2/group-members','/api/socialV2/active-members','/api/roles',
  '/api/roles/content','/api/preset/sim-prompt','/api/socialV2/prompt','/api/presets','/api/socialV2/memory',
  '/api/affinity','/api/slang','/api/socialV2/slang/query','/api/stickers','/api/socialV2/sticker-list',
  '/api/stickers/thumbnail','/api/socialV2/voices','/api/voice/list','/api/files','/api/files/lists',
  '/api/files/stats','/api/files/thumb','/api/library/items','/api/library/unclassified','/api/observe/config',
  '/api/socialV2/ai-blacklist','/api/socialV2/tool-log','/api/tokens/recent','/api/tokens/turns',
  '/api/tokens/series','/api/socialV2/feedback','/api/socialV2/config','/api/security','/api/whitelist',
  '/api/dsh/models','/api/dsh/model','/api/models','/api/model-routing','/api/config/reload',
  '/api/socialV2/activity','/api/socialV2/private-quota')
$missing = $routes | Where-Object { $uniq -notcontains $_ }
"TABLE_ROUTES=$($routes.Count) MISSING=$($missing.Count)"; $missing
```

本次实测（基线 `c496376`）：

| 指标 | 结果 |
|---|---|
| 唯一 `/api/` 路由字面量 | **149** |
| 本表引用路由 | **55** |
| 字面量命中 | **54/55** |
| 唯一非字面量项 | `/api/self-check/last` —— `request.url.pathname.startsWith('/api/self-check')` 前缀分发后按 `GET` 分支返回**落盘的最近一次报告**（无报告时 404）；同前缀 `POST` 才是「跑一次体检」 |

> 复跑口径：`MISSING=0` 即全部命中；本次 `MISSING=1` 且唯一项已按上表解释，**不是缺失、是写法不同**。

## 8. 交接给 T16 / T17 的三件事

1. **先做仪表盘 + 会话两页**：这两页能覆盖旧 `console.html` 的 `overview` + `sessions`，是用户 80% 的点击；文件库直接搬 `library.html` 的信息结构（它已经是最干净的）。
2. **不要把一代/二代做成两个导航项**：它们是同一会话的行为开关，拆开会让用户以为「两套机器人」。
3. **换新外壳不要动 POST 语义**：`/api/whitelist` 会 `fail-fast`（配置损坏直接 500、绝不回写），`/api/dsh/models` 的 `source='error'` 是 DSH 不通的唯一可靠信号；前端只要如实显示，不要重试到把状态刷乱。
