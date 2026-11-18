# 前端缺陷修复台账（施工 B，2026-10-25）

给**人**看的清单：每条都写清「当时看到什么现象 / 在哪个位置 / 怎么修的 / 怎么验证的」。
想判断「还修没修」时，按「位置」去代码里对照「修法」的关键标识，或直接跑：

```bash
node scripts/test-console-static.mjs      # 静态契约 + 回归断言（本文件里提到的标识都在里面）
node scripts/test-console-encoding.mjs    # 中文注释没被破坏
```

改动范围始终只有 `public/console.html`、`public/ops.html`、`scripts/test-console-static.mjs`、`docs/**`。

---

## 批次一：配置读取 / XSS / 定时器 / 滚动 / 白名单解析

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 配置读取失败毫无提示，输入框保持空值；用户点「保存」就把写死的兜底默认值（5000/1000/10000）灌进 `config.json`，而真实默认是 30000/5000/600000 | `public/console.html` 的 `loadV2Config` / `loadSocialForm` / `loadSecurity` / `loadSlangConfig` 四个 loader 的空 `catch{}`，以及各自的 `save*` | 新增 `configLoadState` / `CONFIG_GUARDS` / `setConfigLoadState(key, loaded)` / `requireConfigLoaded(key)`：读取成功才解锁保存，失败则写「配置读取失败，请勿保存…」并 `disabled` 掉对应保存按钮；`saveV2Config` 提交前再校验一次；兜底值对齐成 30000/5000/600000 | 静态断言数 `setConfigLoadState(...)` 成功/失败各 4 处 + `requireConfigLoaded('socialV2')` |
| 黑话词条未转义拼进 `innerHTML`（存储型 XSS）：词条来自群聊自动提取与 AI 提交，群友可控；脚本能读 `location.search` 的 token 进而调 `/api/ops/action` | `public/ops.html` 的 `renderSlang`（`e.content` / `e.meaning`）、`renderServices`（`s.name` / `s.detail` / `s.supervision`） | 新增 `esc()`；`renderSlang` 的 badge/词条/释义改用 `createElement` + `textContent`；`renderServices` 全字段 `esc()` | 断言 `wordEl.textContent` / `meaningEl.textContent` / `esc(s.name)` 等；护栏反向验证能抓到修复前 `384a836` 版本的这两行 |
| 暂停开关每点一次多一个永不清理的 30 秒定时器，页面越用越卡 | `public/ops.html` 的 `loadPeak` 按钮回调里的 `setInterval(..., 30000)` | 提到模块级 `ensurePeakPolling()` 单例，已有实例直接复用 | 断言 `setInterval(() => { loadPeak()` 全文件只有 1 处且在 `ensurePeakPolling` 里 |
| 3 秒轮询把用户拽回列表顶部（黑话面板 / 会话列表 / 待审批） | `public/console.html` 的 `renderSlangPanel` / `refreshSessions` / `refreshPending` | 新增 `renderPreservingScroll(box, html)`：渲染前存 `box.scrollTop`，渲染后恢复；三处（含空状态分支）都改走它 | 断言 `renderPreservingScroll` 调用点 ≥ 5 处 |
| 白名单里 `123456789(测试群)`、全角数字、`@123456789` 被 `filter(Number.isFinite)` 静默丢掉，界面仍提示「已保存并生效」 | `public/console.html` 的 `wlSave` 解析函数 | 新增 `normalizeId`（全角数字转半角、去 `@/＠` 前缀）+ `parseIds`（返回 `{values, bad}`，按 5~12 位纯数字校验）；有无法识别的原值就 `alert('以下条目无法识别，未保存：…')` 并中止；`ownerQQ` 同样校验 | 断言「以下条目无法识别，未保存」文案、全角/`@` 归一化、ownerQQ 校验；片段实测 10 组输入 |

## 批次二：接口失败时界面假装一切正常

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| `api()` 只特判 401，其余直接 `return res.json()`：桥接重启的 5 秒空窗、500、或打到错误端口拿到 HTML，都会变成 `SyntaxError` 被空 catch 吞掉，面板永远停在旧数据或「加载中…」 | `public/console.html:api()` | 改 `await res.text()` 后统一判：非 2xx 抛 `HTTP <status>：<body 摘要>`；空 body 抛「响应为空（桥接可能正在重启）」；非 JSON 抛「返回的不是 JSON」。新增 `bodySnippet()` / `errText()` / `renderPanelError(boxId, title, e)`。**200 + `{ok:false}` 仍照常返回**，保留各 save 处理器的 `r.ok ? … : r.error` | 断言 `!res.ok` 抛错分支存在且 `api()` 内不再有 `return res.json()`；`api()` 隔离实测 6 种响应（500+HTML / 503+JSON / 空 body / HTML 登录页 / 合法 JSON / 超长错误体截断） |
| 同上，五个面板的空 catch 把错误吞干净 | 会话列表、待审批、白名单、预设、黑话概要、二代活动、社交状态 | 会话/待审批用 `renderPanelError` 画在数据位置并把指标置 `—`；白名单新增 `#wlLoadMsg`（并提示「请先刷新成功再保存」）；预设新增 `#presetLoadMsg`；黑话概要 → `#slangCandidateList`；二代活动 → `#v2ActivityStatus`；社交状态 → `#socialStatus` | 断言 5 处 `renderPanelError` 调用 + 两个新 id + 各面板文案 |
| ops 三个 loader 不判 `res.ok`/`data.ok`：401 的 `{ok:false}` 让黑话退化成空数组显示「没有匹配的条目」；`loadStickers` 无 try/catch，未捕获 rejection 让网格永久空白；`tickServices` 只在 `data.ok` 时重绘，服务表永远「加载中…」 | `public/ops.html` 的 `loadSlang` / `loadStickers` / `tickServices` | 前两个判 `!res.ok || !data.ok` 抛错，`loadSlang` 例外：**`GET /api/slang` 的成功响应没有 `ok` 字段**，故判 `Array.isArray(data.entries \|\| data.items)`。失败写 `#svc-msg` / `#slang-msg` / `#sticker-msg`，并把列表画成明确的错误块（文案写「不是『没有条目』/『没有收藏』」） | 断言三处判定 + 失败写入点；核对 `src/bridge.js` 三个接口的真实响应结构 |
| 3 秒轮询重建 `#sStateKey` 下拉，打断用户正在展开的选择 | `public/console.html:refreshSocialStatus` | 照 `syncUsageKeySelect` 的写法：`keys.join('\u0000')` 作 `sel.dataset.signature`，集合没变或 `document.activeElement === sel` 时不重建 | 断言 `dataset.signature` + `activeElement` 守卫 |
| 表情注释 `change` + `blur` 双绑，一次编辑写两次后端 | `public/ops.html` 的 `renderStickers` / `saveStickerNote` | 只留 `change`；保存前比对 `noteEl.dataset.orig` 与 `e.tags`，无变化直接 return（点标签也会连带触发保存，光去双绑挡不住） | 断言无 `blur` 绑定 + `dataset.orig` 比对存在 |

## 批次三：清掉剩余静默失败 + 加护栏

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 用量面板整表 `innerHTML` 重建，3 秒轮询重置滚动位置（容器 `.tool-log-table` 是 `max-height:500px; overflow:auto`） | `public/console.html` 的 `renderUsageConversations` / `renderUsageTurns` / `renderUsageRecent` | 三处（含两处空状态分支）改走 `renderPreservingScroll` | 断言 `renderPreservingScroll(box, html + '</table>')` ≥ 2 处 + 空状态也走同一路径 |
| 会话列表 / 待审批刷新丢滚动、丢勾选 | 同文件 `refreshSessions` / `refreshPending` | 滚动：批次一已修（`renderPreservingScroll`）。勾选：**这两个列表没有 checkbox / 选中态**（待审批是三列纯展示表，会话列表只有每行「清除上下文」按钮），没有选中集合可保，未加逻辑 | 断言既有调用点仍在；人工核对渲染体无 checkbox |
| 全量空 catch 清点 | 两个 html | 影响判断的一律改成显示明确错误；确实无害的保留并写明理由。最终全仓只剩 **1 处空 catch**：`public/console.html` 主题 `localStorage.setItem`（隐私模式/配额满时抛错，提示用户也无从操作） | 批次三交接里的「空 catch 清点表」逐条列了位置/现状/处理/理由 |
| 担心以后有人把「未转义接口数据拼 `innerHTML`」写回来 | `scripts/test-console-static.mjs` | 规则化护栏：取每条 `innerHTML =` / `+=` 语句（配平括号、跳过字符串/模板），若语句里出现 `x.(content\|meaning\|sender\|nickname\|name\|detail\|usage\|text\|label\|question\|reason\|error\|desc\|note\|tags\|hint\|title\|sessionId\|key\|value)` 且整条语句既无 `esc(` 也无 `textContent`，判失败并打印行号；豁免须就地写 `// innerHTML-ok: <为什么安全>` | 护栏对修复前 `384a836:public/ops.html` 报出 2 处真实历史缺陷（L234 / L292），对当前代码 0 误报；4 个注入样本行为符合预期 |
| 担心 `api()` 被改回「直接 return res.json()」 | 同上 | 断言 `api()` 里存在 `!res.ok` 抛错分支且不再有 `return res.json()` | 断言本身即验证 |

## 批次四：轮询资源治理 + 破坏性操作防护

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 标签页切到后台 / 窗口最小化后仍每 3 秒（ops 每 2 秒）打接口，桥接重启窗口期还连打失败 | `public/console.html` 两个 `setInterval`；`public/ops.html` 的 `tick` / `tickServices` / `ensurePeakPolling` | 收敛成 `startPolling()` / `stopPolling()`（console）与 `opsStartPolling()` / `opsStopPolling()`（ops）；`document.addEventListener('visibilitychange')`：隐藏时 `clearInterval` 全部，回前台先补刷一次再恢复。ops 停止时一并把 `peakPollTimer = null`，让 `ensurePeakPolling` 能重建。**是暂停不是停用**：回前台一定会重新 start | 断言 `visibilitychange` 监听、`document.hidden` 分支、回前台补刷、定时器数量（console 2 处 / ops 3 处）、`peakPollTimer = null` |
| 网络慢时按钮点了没反应，用户连点导致重复请求（重复触发研究、重复保存配置、重复重启） | 所有会发 POST 的按钮 | 新增 `busy(btn, fn)`（console）/ `opsBusy(btn, fn)`（ops）：点击后立刻 `disabled` + 「处理中…」，结束恢复原文案与**点击前的禁用状态**（不会解开配置守卫的禁用）；`dataset.busy` 挡重复点击；异常用 `alert('操作失败：…')` 说出原因 | 断言 `busy()` 语义 4 条 + 调用点 48 处（console）/ 3 处（ops） |
| 破坏性操作缺二次确认 | `silentOn`（开启静默）、`v2PauseBtn`（暂停二代仿真）、ops `peak-toggle`（立即暂停群聊） | 各加一条说清「对什么、做什么、能不能撤」的 `confirm`；`ops` 的暂停只在「开启暂停」时问，恢复不问 | 断言三条确认文案 |
| 换模型池只改一处，机器人对群里哑掉 | `docs/COLLAB.md` §7 已知坑 | 补「换模型池要同步三处」+ 2026-10-25 `cn:` 前缀事故记录 | 人工阅读 |

---

## 已有确认、本批未动的破坏性操作（避免重复劳动）

`public/console.html`（20 处 `confirm`）：
删除人格（含 `roles/<name>.md` 路径）、保存代预设源文件、还原预设备份、重启桥接、清空「QQ 聊天」工作区（归档全部会话）、清空会话轻量记忆、删除初始提示词、重置二代 AI 状态、清空全部 AI 反馈、清空全部工具调用日志、删除单条黑话、批量确认/拒绝/删除候选、批量删除已确认/已拒绝词条、清空 token 用量账本、清除会话上下文。

`public/ops.html`：服务「启动/停止/重启」走**两步确认**（先点一次变「确认重启？」，4 秒内再点才执行，见 `pendingConfirm`）。

## 批次五：一键自检 + 窄屏适配 + 统一提示

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 怀疑「面板是不是坏了」时只能靠肉眼逐个点 | `public/console.html` 运行总览页新增「一键自检」卡片 | 新增 `SELF_CHECKS`（6 项：`/api/status`、`/api/slang`、`/api/socialV2/activity`、`/api/sessions`、`/api/tokens/summary`、`/api/stickers`）+ `runSelfCheck()`：逐项串行请求，每项独立 try/catch（**单项失败不中断后续**），校验 HTTP 2xx、是否 JSON、结构是否符合预期（`dshReady` 字段 / `entries` 数组 / `paused` 布尔 / `sessions` 数组 / `totals` / `stickers` 数组），失败显示「接口 + 状态码 + 响应片段（≤200 字）」，全过显示「全部正常（6 项）」。**不用 `api()`**：它在 401 时会弹 prompt 阻塞，而自检应把 401 当成失败项报出来 | 断言 6 个 path、`!res.ok` 分支、`slice(0, 200)`、逐项 `catch`、`setTimeout(resolve, 0)` 让出主线程、「全部正常」文案 |
| 窄屏（1024 / 768 / 420）下表格挤成一团、工具条重叠 | 两个 html 的 CSS | console.html 新增 `@media(max-width:1280px/1024px/768px/420px)`：`.card{overflow-x:auto}` + 表格 `min-width:560/640/520px`（挤列 → 横向滚动）、`.row` 内 `.meta` 换行、420px 下按钮占满整行、`.overview-summary` 与 `.mode-row` 单列、toast 全宽。ops.html 新增 `@media(max-width:768px)`：卡片横向滚动 + 表格 `min-width:560px`。只加 CSS，不动 DOM 结构 | 断言四个断点存在、`overflow-x:auto`、`min-width` 三档、420px 按钮整行 |
| 各面板各用各的 msg 元素 + `alert`，风格不一致 | 两个 html | 新增 `toast(message, kind)` / `opsToast(...)` + `#toastHost`：成功/信息 3.5 秒自动消失，**失败带 × 必须手动关**（失败信息自己消失等于又静默了一次）；最多同时 4 条，超出丢最旧。**新增**提示（`busy()` 的操作失败、自检结论）走 toast；既有 `alert` 未强制替换（清单见下） | 断言 toast 容器/函数/关闭按钮/3.5 秒/`busy` 改走 toast |

### 自检接口与任务书的差异

任务书要求检查 `GET /api/socialV2/status`，但 `src/bridge.js` 里**没有这个路由**（`/api/socialV2/*` 只有 config / activity / reset / states / wake / initial-prompt / feedback / tool-log / memory* / … 等）。
改用 `GET /api/socialV2/activity`（返回 `{ok:true, paused}`，是二代仿真的真实状态来源），校验 `paused` 是布尔。
`/api/status` 的 `dshReady`、`/api/slang` 的 `entries`、`/api/sessions` 的 `sessions`、`/api/tokens/summary` 的 `totals`、`/api/stickers` 的 `stickers` 都已对着 `src/bridge.js` 的真实响应核对过。

### 仍保留 `alert` 的地方及原因（console.html 25 处，ops.html 0 处）

| 类别 | 处数 | 例子 | 为什么不用 toast |
|---|---|---|---|
| 前置校验 | 9 | 「请先勾选要拒绝的候选词」「请输入会话 key」「词条不能为空」 | 用户没做成操作，需要**立刻、阻塞地**看到该改什么；toast 一闪而过会让人以为「点了没反应」 |
| 操作结果 | 12 | 「白名单已保存并生效」「❌ 保存失败：…」「❌ 拒绝失败」 | 与前面的 `confirm` 成对（确认 → 结果），语义上是一次「对话」；换成 toast 会让「刚点了什么、结果如何」脱节 |
| 需要读完再决定 | 2 | 「模式已写入本地，但未能同步到 DSH 设置…下一次轮询会把模式改回去」 | 多行、要用户判断下一步，`alert` 的模态性是优点 |
| 不可识别条目 | 1 | 「以下条目无法识别，未保存：…」（多行列表） | 同上，需要逐条核对 |
| 配置守卫 | 1 | 「配置未成功读取，已阻止保存」 | 阻止类提示，必须打断 |

**新代码约定**：新增的「高频、非阻塞」提示用 `toast()`；「需要用户改操作 / 需要读完 / 与 confirm 配对」的继续用 `alert`。

## 批次六：重启后自动自检 + 顶部状态条 + 用量按模型

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 改完模型池后群里直接哑掉，但面板看起来一切正常；自检有了却要人记得点 | `public/console.html` 的 `restartBtn` 处理器 | 点「重启桥接」后：`waitForBridge(60000, 2000)` 每 **2 秒**轮询 `/api/status`（带 `x-console-token`，避免 401 被误判成没回来），**60 秒上限**；超时明确写「桥接 60 秒未恢复：<原因>」+ 红色 toast，不再无限转圈；回来后自动 `runSelfCheck({ toast: false })`，失败项整行红色高亮（`.check-row.err`），并用一条 toast 汇总「重启完成，但 N 项检查失败」/「重启完成，自检全部正常」 | 断言 `RESTART_WAIT_MS = 60000`、`RESTART_POLL_MS = 2000`、`while (Date.now() - started < timeoutMs)`、「桥接 60 秒未恢复」文案、自动自检调用、`check-row err` 高亮、`runSelfCheck` 返回 `{failed,total}` |
| `/api/status` 已有 `mode` / `dshReady` / `snowluma` / `socialV2Paused`，但页头没有汇总 | `public/console.html` 全局 `#statusBar`（在 `#connectionAlert` 之后，每页可见） | 四个 chip：模式 / DSH / SnowLuma / 群聊。DSH 未就绪标红；SnowLuma「未连接」「已连接·未接收」标红、「未知」标黄；暂停用 warn 色；状态条自身读取失败时四个 chip 全变「读取失败」并把错误写进右侧说明（否则「一片灰」分不清是桥接挂了还是页面没轮询）。刷新：`STATUS_POLL_MS = 10000` 的**独立**定时器，挂在 `startPolling/stopPolling` 里，**不叠加** 3 秒主轮询；回前台补刷一次 | 断言四个 chip id、`STATUS_POLL_MS = 10000`、`setInterval(refreshStatusBar, STATUS_POLL_MS)`、各异常分支配色、读取失败分支 |
| 用量面板只看得到「按会话」，看不到「哪个模型花了多少」 | `public/console.html` 用量页新增「按模型」区块 | `/api/tokens/summary` **没有** per-model 的 token/花费（`conversations[].models` 只是模型名列表），所以从 `GET /api/tokens/recent?limit=500`（每条调用带 `model` + `cacheMiss/cacheHit/cacheWrite/output` + `cost`）前端聚合：模型 / 调用次数 / 输入 / 输出 / 费用，输入 = 未命中+命中+写入（明细放在 `title` 里）。`model` 为空的归到「未标注模型」；有 `estimated` 的标「估」。标题写明「本次窗口 N 条，不是全量历史」。500 条流水**30 秒**才聚合一次（不跟 3 秒轮询同频），手动点「刷新」立即重算 | 断言 `usageModels` 容器、数据源 `recent?limit=500`、`e.model || '未标注模型'`、只聚合 `cost`/各桶、`不是全量历史`、`esc(m.name)`、`usageModelsAt > 30000` 节流 |

**顺带统一**：旧的 `showConsoleToast()`（写 `#consoleToast`，4.2 秒）改为转发到 `toast(message, 'ok')`，同一页面不再有两套提示观感与两套消失规则。

**与任务书的一处说明**：任务书写「`/api/tokens/summary` 有 totals 和按会话的数据」，实际它**没有**按模型的数据；按模型只能在 `/api/tokens/recent` 的样本窗口上聚合。因此「按模型」表标注了窗口范围，没有把它伪装成全量历史。

## 插队任务：模型选择改成下拉 + 保存前校验（2026-10-25 线上事故）

事故：控制台把一个**已改名的模型 id**（`cn:deepseek-v4-pro`，合池后改了名）写进 `config.json`，机器人每轮先失败一次、靠自动降级才回得上话；面板上一切正常。

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 模型只能看不能选，选错也没有任何拦截 | `public/console.html` 的 `section-dsh` | 新增 `#dshModelSelect` + `#dshModelSave`（+ 手输兜底 `#dshModelInput`），选项来自 `GET /api/dsh/models`；每项显示 `provider/model`（有 `name` 时补「（名字）」），`current` 那一项标注「· 当前」 | 断言下拉由 `/api/dsh/models` 填充、选项文案含「· 当前」 |
| 提交前不校验，写进 `config.json` 才发现错 | 同上 `saveDshModel()` | 保存前**本地校验**：所选值必须在最近一次拉到的清单里（`dshModelCatalog.models.some(...)`）；不在就**不提交**，提示「该模型不在可用列表，请刷新后重选」并弹 err toast | 断言 `dshModelCatalog.models` 校验分支与该文案 |
| 服务端其实知道正确答案，但界面上看不到 | 同上，`POST /api/dsh/model` 返回 400 的分支 | 不用 `api()`（它会把 400 压成一条字符串），改裸 `fetch`：**400 时把服务端给的 `models` 清单原样列在 `#dshModelListMsg`**（这是最可信的清单），并按它刷新下拉；用户输入**保留在输入框里**便于对照 | 断言 `res.status === 400` 分支与「服务端可用模型：」文案 |
| 正在用降级模型却毫无提示 | 同上 `#dshModelDegraded` | `GET /api/dsh/models` 返回 `degraded: true` 时，模型区显示红字「⚠️ 当前处于降级状态：配置里的模型不可用，运行期已在用降级模型（回退是兜底，不是正确配置）…」 | 断言 `degraded === true` 分支与提示文案 |
| 旧版桥接没有 `/api/dsh/models`，界面不能因此卡死 | 同上 `loadDshModelCatalog()` 的 catch | 拿不到清单时：下拉隐藏、**退回手输框**（并用当前 `provider/model` 预填），提示「无法获取可用模型列表，请手工确认 id 正确（<原因>）」；此模式跳过本地清单校验，靠服务端 400 兜底 | 断言该文案 + `input.hidden = false` |
| 前端改完没法验（Playwright 缺） | `scripts/console-ui-fixture.mjs` | 补 `GET /api/dsh/models`（3 个假模型，含 `workbuddy2api/deepseek-v4.1-flash` 以区分拼接口径）与 `POST /api/dsh/model`（未知模型 → **400 + 清单**） | 真起 fixture 实测：`GET` 返回清单；`POST deepseek-pro` → 200；`POST cn:deepseek-v4-pro`（就是事故值）→ **400 + 清单** |

**没做的**：没有把「`provider/model` 里 model 本身含 `/`」的情况特殊处理——按第一个 `/` 切分。当前清单里的 id 都不含 `/`；若将来出现，需要在 `saveDshModel` 里改成「按清单精确匹配后再切」。

## 批次七：状态条接模型 / 本地兜底 + 保存后回读

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 状态条只看得到模式 / DSH / SnowLuma / 群聊，看不出「现在跑的是哪个模型」「是不是本地小模型在代班」 | `public/console.html` 的 `#statusBar` + `renderStatusBarModel()` | 数据源 `GET /api/model`（与 `/api/status` **分开取**，一个挂了不影响另一个），跟状态条一起 **10 秒**刷新。新增两个 chip：**模型**＝`provider/model`，`degraded=true` 时变「…（降级中）」用 warn 色；**本地兜底**＝`enabled=false`→「未启用」、`enabled && !active`→「待命 · 成功 N · 失败 M」、`active=true`→「接管中（已 X）· 成功 N · 失败 M」并用 **err 红**配色。`local.ok/fail` 取真实计数，不写死 0。接管时状态条右侧还会把「更新时间」换成红字「⚠️ 本地兜底接管中：<model> 正在代班（<baseUrl>）」 | 静态断言 5 条覆盖三分支 + 计数 + 配色；**另起 fixture 把三种分支各造一遍**用 `scripts/test-statusbar-branches.mjs` 校验文案（见下） |
| 保存模型后只有一句「已切换」，看不出**实际生效**的是哪个（可能仍是降级模型） | `saveDshModel()` 成功分支 | 保存成功后回读 `GET /api/model`，提示改成「✅ 已切换为 `provider/model`（下一条消息生效）」；若回读仍是 `degraded=true`，提示变红并追加「但当前仍处于降级状态，请检查模型是否真的可用」；同时 `refreshStatusBar()` | 断言回读调用、「已切换为 <actual>」、「仍有降级」分支、刷新状态条 |
| 施工 A 的 `POST /api/dsh/model` 还没上线，保存会 404 | 同上 | 先打 `/api/dsh/model`（将来带清单校验），**404/405 时自动退回已上线的 `POST /api/model`**（同样的落盘语义：写 `cfg.dsh.provider/model`、清 override、bump epoch） | 断言 404/405 回退分支 |
| 没有浏览器，三分支文案没法验 | 新增 `scripts/test-statusbar-branches.mjs` | 用 fixture 的 `startConsoleFixture()` 起内存服务，通过 `/__fixture/local` 把本地兜底切到「未启用 / 待命 / 接管中」，再把 `console.html` 里的 `statusChip` + `renderStatusBarModel` **原样抽出来**跑在假 DOM 上，逐条断言文案与 class | `node scripts/test-statusbar-branches.mjs` → 未启用 / 待命 / 接管中（含真实 ok=3 fail=1）/ 模型正常 / 模型降级 / 接口读不到，**7 条全过** |
| fixture 没有 `/api/model` | `scripts/console-ui-fixture.mjs` | 补 `GET /api/model`（`state.model` + `state.local`）、`POST /api/model`（切换并清 degraded）、以及 fixture 专用控制口 `POST /__fixture/local`（切换三种本地兜底分支） | 由上面的分支脚本覆盖 |

## 批次八：账本一致性指示灯 + 用量导出 CSV

背景：审阅窗口实测 `/api/tokens/summary` 自相矛盾——`cost=45.622`、`attributed=38.636`、`unattributed=11.086`，后两者相加 `49.722`，比 `cost` **多 9%**。施工 A 的 P1 在修口径。

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 账本口径对不对只能读代码/手算 | `public/console.html` 用量页 `#usageConsistency` | 四张指标卡下面一行指示灯：`attributedCost + unattributedCost - cost`，**差值先量化到分**再比阈值 `LEDGER_TOLERANCE = 0.01`；`|差| ≤ 0.01` → 绿「账本一致」（说明里写出 已归属 + 未归属 = 合计、差值、容差）；超过 → 红「账本不一致：差 ¥X（Y%）」+「已归属 + 未归属比总花费多/少出 ¥X。这通常意味着重复计费，请查看 P1 修复进度。」。三个字段任一缺失（`Number.isFinite` 不过）→ **灰「无法计算」**，绝不把缺失当 0（否则「接口没给」会被误报成「账本一致」，灯就白装了） | 静态断言 9 条；`scripts/test-usage-ledger.mjs` 用 fixture 跑「一致 / 多 9% / 缺字段 / 0.01 边界 / 0.02」五种 |
| 用量只能看不能带走（对账、留档、贴给 A） | 同上，`#usageExportConv` / `#usageExportModel` | 两个按钮，纯前端 `Blob` 下载（带 UTF-8 BOM，Excel 双击不乱码），**不上传任何东西**。字段：会话/模型 · 调用次数 · cacheMiss · cacheHit · output · 费用。按会话取 `totals` 已聚合的 `conversations[]`，按模型取最近 500 条流水聚合（与「按模型」表同源）。`csvCell()` 对**逗号 / 双引号 / 换行 / 回车 / 首尾空格**加引号，内部双引号翻倍；行尾 CRLF | 静态断言 8 条；`scripts/test-usage-ledger.mjs` 逐条验 逗号 / 引号 / 换行 / 回车 / 空格 / 数字 / null / 整体拼装 |
| fixture 造不出「账本不一致」 | `scripts/console-ui-fixture.mjs` | 新增 `POST /__fixture/usage {inconsistent:true}`：把 `attributedCost` 抬到 `cost×1.09 - 0.02`（复刻实测那组），`unattributedCost` 仍 0.02 | 由 `scripts/test-usage-ledger.mjs` 覆盖：一致组 `diff=0` → 绿；不一致组 `多 9.1%` → 红 |

**踩到的坑（已修）**：`90 + 10.01 - 100` 在浮点里是 `0.010000000000005`，直接 `<= 0.01` 会把「刚好差一分」误判成不一致。现在先 `Math.round(abs * 100) / 100` 量化到分再比，测试里也钉了这条边界。

## 批次九：保存前 diff 预览 + 降级运维手册

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 运维在「二代仿真」表单里改了一堆，点保存时不知道会改动哪些字段（模型 id 写错那种事故就藏在这里） | `public/console.html` 的 `saveV2Config()` | 拆成 `buildV2ConfigBody()`（只组装）+ `postV2Config(body)`（只提交）+ `saveV2Config()`（比对 → 弹确认 → 提交）。新增 `flattenConfig` / `diffConfig`：把嵌套配置拍平成 `wake.batchWindowMs` 这种路径逐字段比较（数组当叶子，`JSON.stringify` 比较），**只返回真正变化的字段**。弹窗 `#configDiffOverlay` 逐行显示「路径 旧值 → 新值」（旧值带删除线、新值 accent 色），标题写「共 N 项变更」；**超过 20 项折叠**，给「显示其余 N 项」按钮展开 | 静态断言 10 条；`scripts/test-config-diff.mjs` 跑 10 条：拍平 / 无变化 / 单字段 / 布尔 / 数组 / 增删键 / 排序 / 可读化 / 真实形状 |
| — | 同上 | **没有变化时直接跳过提交**：提示「没有改动，未提交」+ info toast，不发请求。**确认按钮之后才 POST**；取消则什么都不发 | 断言「没有改动，未提交」分支与确认→`postV2Config` 链路 |
| 基线的选取（这条是本次的重点） | `loadV2Config()` | 基线是 `r.config`（**服务端读回来的原样对象**）深拷贝成 `v2ConfigBaseline`，**不是表单默认值**——否则就是重演「配置读取失败时用默认值覆盖 config.json」那次事故。`requireConfigLoaded('socialV2')` 仍在最前面；万一基线缺失（读取失败已被拦住，理论到不了），不假装有 diff，直接提交并提示「没有服务端基线，无法预览改动」 | 断言基线赋值取自 `r.config`、`JSON.parse(JSON.stringify(c))`；断言缺基线分支 |
| 降级态没人说得清怎么处理 | 新增 `docs/DEGRADATION.md` | 给值班的人看的手册：**模型降级 / 本地兜底接管 / 账本不一致** 三种，每种都按「怎么发现（界面哪里看）→ 代表什么 → 该做什么 → 什么时候叫醒 owner」写；含本地兜底的能力边界表（能做什么 / 不能做什么）、三种状态的组合速查表。不含代码细节 | 人工通读 |

## 批次十：失败分支回归网 + 可访问性收尾

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| fixture 只覆盖成功路径，「接口 500 / 超时 / 畸形 JSON 时界面会怎样」只能靠读代码 | `scripts/console-ui-fixture.mjs` | 加**故障注入**：`FIXTURE_FAIL="api/slang:500,api/sessions:badjson,api/status:timeout"`（也支持 `FIXTURE_FAIL_MODE` 默认值与 `FIXTURE_FAIL_DELAY_MS`）。命中按路径片段 `includes` 匹配，四种模式：`500`（500+JSON 错误）、`badjson`（200 但不是 JSON）、`empty`（200 空 body）、`timeout`（延迟后 504）。**注入优先级最高**，但跳过 `/__fixture/*`（否则测试脚本连服务都起不来） | 静态断言 8 条；`scripts/test-console-failpaths.mjs` 真跑 |
| 「失败可见」只是代码约定，没有回归测试 | 新增 `scripts/test-console-failpaths.mjs` | 起 fixture → 把 `console.html` 那段内联脚本**整体**跑在一套最小假 DOM 上（`getElementById`/`createElement`/`querySelector` 都可用、textContent 会聚合子节点文字）→ 逐个面板调用真实刷新函数 → 断言「不抛异常 + 错误文案真的出现在对应容器里」。覆盖 **会话列表 / 待审批 / 黑话 / 用量 / 状态条 / 自检** × **500 / 非法 JSON / 空 body / 超时** = 24 组，外加 api() 的三条错误措辞 | `node scripts/test-console-failpaths.mjs` → **51 项全过** |
| 图标按钮、状态条六格对读屏不友好 | `public/console.html` | `statusChip()` 每次更新时把「指标名：值」写进 `aria-label` 与 `title`（六格视觉上只有短词，读屏需要完整说法） | 断言存在该赋值、六格 id 齐全 |
| 弹窗只能用鼠标关 | 同上 | 全局 `keydown` 守卫：`Esc` 先关**开着**的 diff 弹窗（并把 `#v2ConfigMsg` 写成「已取消保存」），再关黑话弹窗；确认/取消都是真实 `<button>`（Enter/Space 原生可触发） | 断言 Esc 守卫与 `classList.contains('open')` 判断 |
| `ops.html` 没有显式焦点样式 | `public/ops.html` | 加 `:focus-visible { outline:2px solid #5aa9ff; outline-offset:2px }`；**不删默认焦点环**（断言里禁止 `outline` 归零） | 断言两个页面都有 `:focus-visible`、且都没有把 outline 置空 |
| 没人检查「按钮既没文字也没 aria-label」 | `scripts/test-console-static.mjs` | 新增正则扫描：抽出所有 `<button …>…</button>`，去掉标签后若无可见文字且无 `aria-label` 即失败（console / ops 两个页面都查） | 当前两边都是 0 个裸按钮 |

## 批次十一：上下文效率卡片（用量页）

背景：prompt token 中位数 207,183、输出中位数 152，约 **1300:1**——钱几乎全花在「把上下文塞进去」。施工 A 在调工具结果裁剪阈值（50K→20K），但改完有没有用只能手工跑脚本算。

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 看不出「成本在上下文还是在生成」 | `public/console.html` 用量页新增 `#ctxSummary` 卡片 | 四个指标：**平均 prompt**（`inputTokens ÷ steps`）、**平均输出**（`buckets.output ÷ steps`）、**比值**（`平均 prompt ÷ 平均输出`，显示成 `1363 : 1`）、**最近 20 轮 prompt 中位数**。一句话解读：比值 > `CTX_RATIO_ALERT = 500` → 红字「成本主要在上下文……检查是否需要更激进的裁剪（工具结果阈值 50K → 20K）」，否则绿字「在告警线以内」 | 静态断言 17 条；`scripts/test-context-efficiency.mjs` 19 条（真跑） |
| 均值会被长会话拉偏 | 同上 `median()` | 中位数实现：排序后**偶数个取中间两个的平均**、奇数取正中间；空/非数字/全非法返回 `null`（不是 0）。测试里专钉了「加一个 900 万极端值后中位数几乎不动、均值被拉爆」这条性质 | 中位数 7 条断言 |
| 7 天趋势没有图 | 同上 `ctxBlocks()` + `#ctxTrend` | 用字符方块 `▁▂▃▄▅▆▇█`（按 min/max 归一化，等值统一 `▄`），**不引入图表库**；下面一行写「最近 N 天：首日 值 → 末日 值」。趋势条带 `aria-label` | 方块 3 条 + 趋势 2 条断言 |
| 数据不够时容易「假装算出来了」 | 同上 | **数据源只有 `GET /api/tokens/summary`**。平均值与比值够用；**中位数**需要 `recentPromptTokens`（逐轮 prompt token 数组）、**趋势**需要 `daily`（`[{date, promptMedian}]`）——这两个字段 summary 目前**不返回**，所以卡片显示「无法计算」并写明「summary 未返回 recentPromptTokens / daily」，**绝不用平均值或 0 顶替** | 断言「无法计算」与具体缺失字段名 |
| 汇总接口挂了，卡片停在「读取中…」 | `renderContextEfficiencyError()` | `refreshUsage()` 的 catch 里调用：四项写「读取失败」、趋势清空、`#ctxVerdict` 写错误原因 | 故障注入回归里新增「上下文效率」面板（4 种故障 × 2 条断言） |

### ⚠️ 需要 A 补的两个字段（本批的硬阻塞项）

`/api/tokens/summary` 目前只有 `totals.{steps,turns,inputTokens,buckets.output}`，**没有逐轮明细、也没有按天的历史**，所以卡片上「最近 20 轮中位数」和「7 天趋势」现在恒为「无法计算」。要真正点亮这两个数，summary 需要多加：

1. `recentPromptTokens: number[]` —— 最近 N 次调用的 prompt token（= `cacheMiss + cacheHit + cacheWrite`），前端自己取最后 20 个算中位数；
2. `daily: [{ date: 'YYYY-MM-DD', promptMedian: number }]` —— 最近 7 天每天的 prompt token 中位数。

补充事实（供 A 判断实现成本）：**这两份数据在账本里已经存在且已有现成出口**——`recent(limit)` 每条 sample 都带 `time / turn / step / cacheMiss / cacheHit / cacheWrite / output`，`/api/tokens/recent` 已经在「按模型」表和 CSV 导出里用着。也就是说：要么给 summary 加这两个聚合字段（一次算好），要么允许前端改读 `/api/tokens/recent?limit=...`（本批按任务书「只看 summary」的要求没有这么做）。

## 批次十二：控制台「出图测试」面板

路由先核对再写：`grep` 确认是 **`POST /api/socialV2/draw`**（`src/bridge.js:7463`），请求 `{key, prompt}`，成功只回 `{ok, key, messageId, sent}`。

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 想试一张图只能去 QQ 里发指令 | `public/console.html` 新增 `#section-draw`（operations 页，紧跟「测试发送」） | 群/私聊 + 号码 + 提示词 + agent token → 「生成并发送」→ 直接 `fetch` 该路由（**不走 `api()`**，因为要拿 429 原始文案与状态码），结果行显示「HTTP 状态 ｜ 耗时 ms ｜ 响应字节数 ｜ 会话 ｜ messageId」 | 静态断言 21 条；`scripts/test-draw-panel.mjs` 12 条（真跑 fixture） |
| 429 只说「失败」，看不出要等多久 | 同上 | 429 单独分支：**服务端文案原样写进 `#drawMsg`**（`出图冷却中，请 37 秒后再试`），再用 `/请\s*([0-9]+)\s*秒/` 取秒数，`startDrawCountdown()` 每秒刷新按钮文案为「请 N 秒后再试」并禁用，到点恢复；冷却期内重复点击只提示、不发请求 | 429 断言 3 条 + 倒计时到期恢复 1 条（真等 3.4 秒） |
| 显示「图片」这件事本身不成立 | 同上 | 该路由把图**直接发到 QQ**，不回传图像数据——面板如实写「图片由桥接直接发到 QQ，浏览器端拿不到图像数据」，并把能证明「真发出去了」的三样摆出来：HTTP 状态 / 实际耗时 / 响应字节数 + `messageId` | 断言结果行含 `耗时 N ms`、`响应 N 字节`、`messageId` |
| provider 不知道从哪读 | `renderDrawProvider()` | 桥接没有暴露 `imagegen` 配置的接口（grep 确认 `cfg.imagegen` 只在出图内部使用），所以按要求写 **「未知」**，并注明「冷却 45 秒 / 每小时 10 张」是代码里的默认值 | 断言文案含「未知」与 `imagegen` |
| 面板发请求必然 403 | 新增 agent token 输入框 | 该路由要求 `x-agent-token`（`reserved2 模式出图必须携带 agent token`）。面板加一个 password 输入框，`change` 时写 localStorage、加载时回填；留空则把服务端 403 原因原样显示 | 403 断言 1 条 |
| 失败时白屏 | 复用第十批故障注入 | 500 / 坏 JSON / 空 body / 超时四种下：`发送失败：<服务端原因>` / `返回结构不认识（不是预期 JSON）：<片段>` / `返回结构不认识（不是预期 JSON）：（空响应）` / `发送失败：网关超时`，按钮恢复可点 | failpaths 新增「出图测试」面板（4 种故障 × 2 条断言） |

## 批次十四：体检卡（把四个健康信号合成一眼看板）

背景：判断「机器人现在好不好」要跑四个地方（状态条 / 用量页账本灯 / 一键自检 / 模型清单），今天两次事故都是「某一处红了但没人看」。

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 没有一处能一眼看完 | `public/console.html` 新增 `#section-health`（运行总览，状态条下方第一张卡） | 四个按钮式状态格（各一个绿/黄/红/灰状态点 + 一句话）：**模型**（`GET /api/model` 的 `provider/model`，`degraded=true` → 黄「正在降级」）、**账本**（`/api/tokens/summary` 的 `attributedCost + unattributedCost` 与 `cost` 之差，`|差| ≤ 0.01` 绿、否则红并给差值与百分比）、**本地兜底**（同 `/api/model`：`enabled=false` 灰「未启用」、待命绿、`active=true` 黄「接管中（已 X）· 成功 N / 失败 M」）、**网关**（`GET /api/dsh/models` 拿不到清单 → 红，写出 `source`） | 静态断言 23 条；`scripts/test-health-card.mjs` 16 条（真跑 fixture） |
| 一个接口挂了整卡白屏 | 同上，`refreshHealthModelAndLocal` / `refreshHealthLedger` / `refreshHealthGateway` | **三项并发、各自 try/catch**：任一个失败只把对应项标红并写出错误原文（`读取失败：HTTP 500 …`），其余照常。模型与本地兜底共用 `/api/model`（源相同，一起降级，这是数据源决定的） | `test-console-failpaths.mjs` 新增 3 个体检面板 × 4 种故障（500 / 坏 JSON / 空 body / 超时）；另有独立用例：`/api/model` 500 + `/api/tokens` 坏 JSON 同时发生，网关仍绿 |
| 阈值口径容易被误解 | `HEALTH_LEDGER_TOLERANCE = 0.01` | 注释写明「**浮点容差**（金额只到分，`90 + 10.01 - 100` 在浮点里是 `0.010000000000005`），不是业务阈值」；差值先 `Math.round(abs * 100) / 100` 量化到分再比，与用量页那盏灯同口径 | 断言常量 + 「浮点容差」注释 + 量化语句；用例里 8.8% 那组红、默认数据绿 |
| 每项点不进去 | 四个 `<button data-health-page data-health-section>` | 点击调 `setConsolePage(page, { focus:true, target })`：切页 + 滚到目标卡片（模型/兜底/网关 → `section-dsh`，账本 → `section-usage`）。用 `<button>` 所以 Tab/Enter 也走得通，`aria-label` 写「指标名：结论」 | 断言 `setConsolePage(... focus:true, target)` 与锚点属性 |
| 「最近一次自检」看不到历史 | `recordSelfCheck(failed,total)` + `renderHealthSelfCheck()` | `runSelfCheck()` 结束时把 `{at, failed, total}` 写 `localStorage['lastSelfCheck']`，体检卡底部一行显示「最近一次自检：16:28:59 · 2 / 6 项失败（结果只存在这个浏览器里：刷新页面还在，换台电脑就没了）」；没跑过就说还没跑过 | 用例覆盖「没跑过 / 2 项失败 / 全过」三种，并断言写进了 localStorage |
| 顺便限流 | `HEALTH_GATEWAY_INTERVAL_MS = 30000` | 网关探测会打上游，单独限到 30 秒；体检整体跟状态条同频（10 秒）但**不新开定时器**（页面已有「散装 setInterval ≤ 3」的约束） | 断言限流常量与「不新增 setInterval」；用例断言不 force 时不重复请求 |

## 批次十五：黑话批量操作的「预览 + 撤销」

背景：黑话库 200+ 条，批量确认 / 拒绝 / 删除是**一次性写盘**，点错（比如把「仅语境推断」筛出的 40 条全拒了）只能靠 `state/slang.json.bak-*` 手工回滚——普通运维不会做。

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 点下去就生效，不知道动了谁 | `public/console.html` 新增 `#slangBulkOverlay` + `startSlangBulk(opKey)` | 五个批量入口（批量确认 / 批量拒绝 / 批量删除候选 / 已确认 / 已拒绝）全部改走预览：弹层里写明**当前筛选条件**（`slangBasisFilterLabel()` + 搜索词）和「将确认 N 条候选词条」，并**列出将被影响的词条名**（前 `SLANG_PREVIEW_LIMIT = 20` 条，其余折叠成「……等 N 条（只显示前 20 条）」）。原来的 5 个原生 `confirm()` 随之去掉（静态断言的原生 confirm 数量从 20 降到 15） | 断言 5 个入口都走管线 + 预览文案 + 20 条折叠 |
| 删错了没法救 | `#slangUndoBtn` + `undoSlangBulk()` | 执行成功后把**操作前**的快照放进内存 `slangUndo = { label, kind, at, entries }`，**只存被影响的条目**（深拷贝，不是整个库）；消息区右侧出现「撤销上一次批量确认（2 条）」按钮，旁边注明「撤销只在本页内存里：刷新页面或再做一次批量操作就失效」。快照在**下一次批量操作开始时清空**（`slangUndo = null`） | 断言只有成功才武装快照、下一次批量操作清空、入口文案与提示 |
| 撤销用什么接口（不新造） | 同上 | 状态类（确认 / 拒绝）撤销：逐条 `PATCH /api/slang/:id { status: <原状态> }`（该接口本来就支持 `status`）；删除类撤销：`POST /api/slang` 重建，若原状态是 rejected 再补一次 `PATCH status=rejected`。**重建的代价如实写在结果里**：「被删条目已重建：新 id、source=manual，evidence 不会回来」 | 用例断言重建后内容/含义都在，且提示里写了代价 |
| 删错了最危险，要二次确认 | `#slangBulkDanger` / `#slangBulkTyped` | 删除类弹层多一块危险区：必须**输入要删除的条数**（`if (typed !== String(entries.length))` 直接拒绝执行并提示「请输入 N 才能确认删除」）。确认类不需要输入 | 用例：输错条数 → 一条都没删且未武装快照；输对 → 真删 |
| 撤销失败谎报成功 | `undoSlangBulk()` 的失败分支 | 逐条记录失败：只要有失败就写「❌ 撤销未完成：0/1 条已恢复，1 条失败（<内容>：<原因>）。可再点一次「撤销」重试」，**不写「已撤销」**、**不清理快照**、入口继续留着供重试；只有全成功才写「✅ 已撤销…」并清空快照 | `test-slang-undo.mjs` 场景三：PATCH 注入 500 / 超时 / 坏 JSON / 空 body 四种，每种都断言「有『撤销未完成』且没有『已撤销』、服务端状态未变、快照仍在」 |
| 撤销路径也要能被注入 | `scripts/console-ui-fixture.mjs` | 故障注入支持**方法维度**：`FIXTURE_FAIL="PATCH:api/slang:500"`（`parseFailSpec` 识别 `方法:路径:模式`），这样批量写入照常、只有撤销那一步失败 | 用例正是靠这个把「写入成功、撤销失败」造出来 |

## 批次十六：控制台前端异常自捕获（错误诊断条）

背景：控制台里一旦有未捕获异常 / 未处理的 Promise 拒绝，用户看到的是「点了没反应」或「只渲染了一半」，**界面上没有任何信息**，只能开 DevTools 看 Console——运维不会这么做。今天线上就踩过一次（接口 500 导致面板静默不更新，靠读代码才发现）。

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 报错了界面上看不到 | `public/console.html` 主脚本新增全局兜底（`window.addEventListener('error')` + `'unhandledrejection'`） | 两条 handler 都先 `console.error` **原始错误对象**（不吞错），再 `recordFrontendError()` 入队；页面底部出现可折叠诊断条 `#errorBar`：标题「⚠️ 前端错误 N 条」+「清空」，展开后每条显示**时间 · 当前面板 · 来源文件:行:列 · 类型**、错误消息、堆栈前 3 行（+首行），并有「复制」按钮（整段复制给维护者）。不用 alert、不遮挡操作、**不会自动消失**（与 toast 分开） | 静态断言 20 条；`scripts/test-error-bar.mjs` 15 条（真跑） |
| 循环报错会刷屏 | `ERROR_BAR_DEDUPE_MS = 30000` + `errorBarSeen` Map | 去重键 = **消息 + 堆栈首行**；30 秒内同一键只入队一次（但仍照常 `console.error`）。Map 超过 40 条时顺手清理过期键，避免无限增长 | 用例：连续两次同错 → 计数仍为 1、`console.error` 调到 2 次 |
| 兜底自己不能把页面搞崩 | `recordFrontendError` / `scheduleErrorBarFlush` / `flushErrorBar` | 三层都包 `try/catch`；调度优先 `requestIdleCallback(flush, { timeout: 800 })`，不支持则 `setTimeout(flush, 0)`——**不阻塞首屏渲染** | 用例：`handleWindowError(null)`、`handleWindowRejection({})`、传入循环引用对象，均不抛 |
| 条数无限堆下去 | `ERROR_BAR_LIMIT = 5` | 队列 flush 时逐条 `unshift`（保证新的在前），再 `slice(0, 5)`。**踩过的坑**：最初写成 `batch.concat(prev).slice(0,5)`，同一批 6 条同一毫秒时会把「最新的那条」丢掉——已改成 unshift 并钉了用例 | 用例：连发 6 条 → 只留 5 条，且保留的是最近 5 条（`批量错误 1..5`，最早的 `0` 被挤掉） |

### ⚠️ 待人工验证

自动化只能证明「error 事件进来后诊断条长对了」。**真实浏览器里是否真能弹出来**要人看一眼：

1. 打开控制台，在地址栏执行 `javascript:void(0)` 不行——用 DevTools Console 里跑 `throw new Error('测试兜底')`，页面底部应出现「⚠️ 前端错误 1 条」；
2. 再跑 `Promise.reject(new Error('测试拒绝'))`，应变成 2 条且第二条类型是「未处理拒绝」；
3. 点「复制」，粘到记事本应包含时间/面板/来源/消息/堆栈；
4. 用 fixture 起一个 500 的接口（`FIXTURE_FAIL=api/slang:500`）刷新页面，若某个面板的渲染路径真的抛了未捕获异常，应看到诊断条——**这条需要在真实浏览器里确认，假 DOM 覆盖不到**。

## 批次十七A：存储占用面板（依赖 A 的 `GET /api/storage/stats`）

背景：`state/` 占用完全看不见（messages.db 1.7MB、WAL 4.16MB 是主库 2.4 倍、sticker-files 35MB）。全库没有 `journal_size_limit` / `wal_checkpoint` / `VACUUM`，现在无害，但**没有地方能看见增长趋势**。

> ⚠️ **契约修正（用户 m01683）**：第一版是按任务书里一份**写错的草稿契约**实现的（`data.db.walBytes` / `data.items` / `logs` 是对象）。调线上真实接口后发现不一致，已按 `src/storage-stats.js` 的 `collectStorageStats()` **重写**。**以线上实际返回为准**。

### 真实 schema（实现见 `src/storage-stats.js`，前端只读这些字段）

```jsonc
{
  "ok": true,
  "generatedAt": 1792918038595,
  "stateDir": "…\state",
  "top": [{ "name": "sticker-files", "kind": "dir", "bytes": 35720793, "depthLimited": true }],
  "topTotal": 48321609,          // truncated=true 时是**下限**
  "truncated": false,
  "messages": {
    "db": { "pageCount": 417, "pageSize": 4096, "freelistCount": 88, "rows": 3442 },
    "dbBytes": 1708032,          // 主库
    "walBytes": 4161232          // WAL
  },
  "logs": [{ "name": "bridge.log", "bytes": 41400, "lines": 423 }],   // 数组
  "disks": [{ "dir": "…\state", "free": { "total": 233000000000, "free": 221000000000 } }]
}
```

**没有 `data.db`**（草稿里那个顶层 `db` 不存在）。前端不再读它，并有断言钉住。

| 现象 | 位置 | 修法 | 验证 |
|---|---|---|---|
| 看不见 state/ 有多大 | `public/console.html` 用量页「存储」卡 | 合计读 **`topTotal`**（`truncated` 时前面加「≥」）；列表读 **`top`**（name/kind/bytes），按大小倒序取前 `STORAGE_TOP_N = 10`，每行「名字 + 占比条 + 大小·百分比」；单项带 `depthLimited` 时名字前加「≥」 | 静态断言 28 条；`scripts/test-storage-card.mjs` **31 条**（真跑 fixture） |
| WAL 是不是太大 | `STORAGE_WAL_RATIO_WARN = 2` | 比值 = **`messages.walBytes / messages.dbBytes`**；> 2 时 `#storageWalHint` 加 `warn`（黄）并提示「WAL 偏大，可在空闲时段手工 checkpoint（本面板不自动做）」 | 用例：正常 0.1× 不黄；`mode:'wal'` 2.4× 黄且文案含「手工 checkpoint」「不自动做」 |
| 统计被截断却像精确值 | `truncated` / `depthLimited` | `truncated=true` → 合计显示「≥ X」、hint 与底部各写一句「统计被截断（目录层级或条目数限制）」；单个条目 `depthLimited` → 名字前加「≥」 | 用例：`mode:'truncated'` → 断言 `^≥ `、两处截断文案、`≥ deep-dir` |
| 数据库有碎片看不出来 | `STORAGE_FREELIST_WARN_RATIO = 0.1` | 用 **`messages.db.freelistCount / pageCount`**，≥ 10% 时在日志区上方插一行「messages.db 碎片 88 / 343 页（26%）· 可在空闲时 VACUUM」 | 用例：`mode:'freelist'`（88/343）→ 断言提示出现；正常数据（2/417）→ 断言**没有** VACUUM 字样 |
| 日志多大 | `logs` 数组 | 逐项渲染「日志 <name> + 占比条 + 大小 · N 行」（`lines` 为 null 时不显示行数） | 用例：两条日志，断言 `40.4 KB · 423 行` 与 `51 行` |
| 磁盘剩余 | `disks[].free.free` | 从 `dir` 里取盘符（`C:`），后面接 `formatBytes(free.free)`；`free` 为 null 时显示「未知」 | 用例：断言 `C: 206 GB` |
| 接口还没上线 | `refreshStorage()` 的 catch | 404/405 → 「**接口未提供（需要新版桥接）**」；其它失败 → 「读取失败：<原因>」。合计都显示 `—`、列表与日志清空，**绝不显示 0** | 用例：`mode:'missing'` + 500/超时/坏 JSON 三种注入 |
| 老桥接少字段 | `renderStorage()` 的防御 | 没有 `messages` 时不崩：WAL 显示 `—` 并写明「接口没返回 messages.walBytes / messages.dbBytes」 | 用例：直接喂 `{top, topTotal, truncated, logs:[], disks:[]}` |
| 数字格式化 | `formatBytes(bytes)` | `B/KB/MB/GB/TB`；**< 100 保留一位小数、≥ 100 取整**；`null/undefined/''/负数/NaN` → `—` | 12 个边界：`0→0 B`、`null→—`、`1023→1023 B`、`1024→1.0 KB`、`1048576→1.0 MB`、`204800→200 KB`、`233000000000→217 GB` 等 |
| 账本挂了会不会连带存储 | `refreshUsage()` | `refreshStorage()` 在账本 `try` 之外，独立请求、独立降级 | failpaths「存储」面板 × 4 种故障 |

## 批次十七B：出图双档交互（每张图先问用哪档）

> 编号说明：用户口径把这轮叫「第十七批」，但本文件已把「存储占用面板」记为十七。为免撞号，两者加 A/B 后缀：**十七A = 存储**、**十七B = 出图双档**。
>
> 交互变更史：一版是「下拉选档 + 一个按钮」，用户要求改成**每张图直接点档位按钮**，故重做。

背景：`config.json` 的 `imagegen.mode = "tiered"`：免费档 = 智谱 CogView-3-Flash（不限次、**图带水印**），高质量档 = 硅基流动 Z-Image-Turbo（付费、**每天 30 次**）。

| 需求 | 落地 |
|---|---|
| 两个按钮替代下拉 | `#drawRunFree`「生成（免费 · 带水印）」→ `tier: 'free'`；`#drawRunHigh`「生成（高质量 · 今天剩 N 次）」→ `tier: 'high'`。`DRAW_TIER = { param: 'tier', free: 'free', high: 'high' }`；旧的 `#drawTier` 下拉与单个 `#drawRun` 按钮**已删除** |
| 配额 0 置灰 | `applyDrawButtonState()` 只禁高质量按钮（免费不连坐）；`title` 写「今日 30 次已用完」，按钮文案「生成（高质量 · 今天剩 0 次）」 |
| 结果区三件事 | 「档位 免费（CogView）/ 高质量（Z-Image 付费档）」（**只认返回体 `tier`/`provider`，缺了写「未提供」**）、「耗时 X ms」、「水印：本图右下角有智谱水印」（免费）/「水印：无（付费档）」 |
| 高质量失败 | 服务端原文照显（如 `出图冷却中，请 3 秒后再试`），并在结果行补「（高质量档失败，可改用免费档重试）」；429 仍走倒计时禁用两个按钮 |
| 不许自动降级 | 代码里**没有任何**「失败后自动改用免费档重发」的调用（静态断言钉住）。档位只由用户点哪个按钮决定 |
| 配额接口未上线 | 显示「付费档今日剩余：未知（接口未提供，需要新版桥接）」，**高质量按钮仍可点**，`title` 提示「点下去由服务端判断」——不拿「未知」当 0 禁用来骗人 |

### 验证

- `node --check`（抽内联 script）→ 3/3
- `scripts/test-draw-panel.mjs` → **27 条全过**：免费按钮→「档位 免费（CogView）」+ 水印提示；高质量按钮→「档位 高质量（Z-Image 付费档）」+「水印：无」且配额 23→22；剩余 0→高质量置灰（title「今日 30 次已用完」）+ 免费仍可点 + 硬点被本地拦住；配额 500/404 →「未知」且高质量按钮仍可点；高质量 429 → 原文 + 「可改用免费档重试」且**没有**自动重发成功
- `scripts/test-console-static.mjs` → **364 项**
- `scripts/test-console-failpaths.mjs` → **107 项**（13 面板 × 4 种故障）

### 后端现状（未接）

`src/bridge.js` 里仍**没有** `GET /api/imagegen/quota` 路由、`/api/socialV2/draw` 也**还没读 `body.tier`**（只有 A 的纯逻辑模块 `src/imagegen-quota.js` + `scripts/test-imagegen-quota.mjs`）。部署前端后：配额显示「未知」，`tier` 被忽略，按原默认行为出图；A 接上路由后自动生效。

### 遗留

- 文档 `docs/OPERATING.md` 里对出图面板的描述还是「下拉选档」版本，需下次一并更新（本批未改，避免超范围）。

## 批次十八：`/api/socialV2/draw` 契约测试

背景：出图现在有两层约束——后端（A，已合）`tier` 必填、只认小写 `free`/`high`，其它或缺省一律 400（`src/bridge.js:7637-7641`）；前端两个按钮分别传 `free`/`high`。但**没有任何自动化测试锁住这个契约**：后端校验改松、或前端传错值，都不会被发现。

新增 `scripts/test-draw-contract.mjs`（全部打本地 fixture，不打真实出图源、不碰智谱/硅基流动）：

| 断言 | 说明 |
|---|---|
| 不带 tier → **400** 且 error 含 `tier` | 与后端文案一致（后端原话里就带 `tier 必填`） |
| `'auto'` / `''` / `'FREE'` / `'High'` / `'freebie'` / `'1'` → 全部 400 | **大小写敏感、不放过近似值** |
| `'free '` / `' high '` → 200 | 后端有 `String(...).trim()`，把「trim 后合法」也钉成契约，避免以后误改 |
| `free` → 200，`tier='free'`、`charged=false`、`watermarked=true`、`quota=null`、`url` 是 `data:image/…` | 免费档语义 |
| `high` → 200，`tier='high'`、`charged=true`、`watermarked=false`、`quota={used,limit,remaining}` 全是 number | 高质量档语义 |
| 四个字段的类型（`tier` ∈ {free,high}、`charged`/`watermarked` 是 boolean、`quota` 是 null 或数字对象） | **「若出现」才断言**：当前线上响应只有 `{ok,key,messageId,sent}`，A 的 `charged/watermarked/quota/url` 还没接；等接上自动生效，不需要改测试 |
| 老版本返回体（无这四个字段）→ 200 不崩 | 前端做缺省，测试不因字段缺失而失败 |
| 429 → 前端 `#drawMsg` **逐字等于**服务端原文 | 抓「自己编一句」的回归 |
| 前端实际发出去的 body：free 按钮 `tier='free'`、high 按钮 `tier='high'` | 用 fixture 记录的 `state.lastDraw` 断言真实请求体 |

### fixture 侧同步收紧

`scripts/console-ui-fixture.mjs` 的 `POST /api/socialV2/draw` 改成与后端同序同规则：token → 冷却/额度 → 参数 → `tier` 必填且只认小写 `free`/`high`（错误文案照抄后端那句）→ 成功返回 `{ok, key, messageId, sent, tier, provider, charged, watermarked, quota, url}`，并记录 `state.lastDraw` 供断言请求体。另加 `mode: 'legacy'`（模拟当前线上只回最少字段）与 `mode:'notier'`。

### 验证

`node scripts/test-draw-contract.mjs` → 全部通过；`test-draw-panel` 27 条、`test-console-static` 364 项、`test-console-failpaths` 107 项仍全过。

## 批次十九：文案纠正——「无水印」改「AI生成 标注」

背景：后端工具描述（`src/mcp-snowluma-safe.js:1568`）已改准：**两档都会带「AI生成」标注**；free=免费不限次，high=更高质量、每天 30 次。用户用真实 key 实测确认：两档都带「AI生成」角标（法规要求）。控制台面板此前的「无水印」「带水印」表述是**错的**。

| 位置 | 改前 | 改后 |
|---|---|---|
| 面板说明 | 免费档带水印，需要无水印请用高质量档 | 两档都会带「AI生成」标注（法规要求，角落小角标，不是大 logo）；免费档不限次、画质一般；高质量档画质更好、每天 30 次 |
| 免费按钮 | 生成（免费 · 带水印） | 生成（免费 · 带 AI生成 标注） |
| 高质量按钮 | 生成（高质量 · 今天剩 N 次） | 生成（高质量 · 画质更好 · 今天剩 N 次） |
| 结果区 | 水印：本图右下角有智谱水印 / 水印：无（付费档） | **AI生成 标注：有（两档均带「AI生成」标注（角落角标））** |
| provider 行 | 免费=CogView 带水印 | 免费=CogView 不限次，高质量=Z-Image 画质更好每天 30 张；两档均带「AI生成」标注 |
| 常量 | `DRAW_WATERMARK_NOTE` | `DRAW_AI_LABEL_NOTE` |

**防回退**：`public/console.html` 里已**不再出现「水印」二字**（grep 计数 0），并新增静态断言 `!/无水印/.test(html)` 与 `/「AI生成」标注/.test(html)`。

### 验证

- 抽内联 script `node --check` → 3/3
- `test-console-static` → **367 项**全过（含两条新防回退断言）
- `test-draw-panel` 27 条、`test-draw-contract` 全过、`test-console-failpaths` 107 项 → 无回退

## 批次十九：体检卡加「视觉能力」

背景：用户报「识图出问题」——当前模型 `workbuddy2api/deepseek-v4-pro`（`degraded: true`）可能**没有多模态能力**，降级后机器人其实"瞎了"，但界面完全看不出来：用户发图它照样回复，观感像看懂了。

| 需求 | 落地 |
|---|---|
| 体检卡第 5 项「视觉能力」 | `#healthVision`：能看图 → 绿「<模型> 支持图片输入」；不能 → 黄「当前模型不支持图片输入，发图会被忽略或误判」；拿不到能力信息 → **灰「未知」**（绝不默认成能看图） |
| 数据来源（临时口径） | 调 `GET /api/model` 取当前 `provider/model`，再在 `GET /api/dsh/models` 的清单里找同名项，看 `inputModalities` 是否含 `'image'`。判断抽成 `pickVisionSupport(modelInfo, listPayload)`，**A 的能力字段/接口定稿后只改这一处**；代码注释写明「临时口径」 |
| 降级叠加警告 | `appendDegradedVisionNote()`：`degraded === true` 且 `supports === false` 时，在「模型」那一项文案后追加「· 降级导致视觉不可用」（幂等，不重复加） |
| 不额外打接口 | 网关与视觉共用 `healthModelsCache`（`loadHealthModels(force)`，30 秒内复用）；`refreshHealth(force)` 把 force 透传给视觉项，避免"强制刷新后视觉项还是旧值"的竞态 |

### 验证

- `scripts/test-health-card.mjs` → **22 条全过**，新增四组：
  - `inputModalities: ['text','image']` → 绿 + 显示模型名；
  - 只有 `['text']` → 黄 + 「发图会被忽略或误判」；
  - 清单**没有** `inputModalities` → 灰「未知」，且断言**不出现**「支持图片输入」；
  - `degraded: true` + 不支持 → 模型项出现「降级导致视觉不可用」，且调用两次不会重复追加；
  - 模型清单 500（独立 fixture）→ 视觉项灰「未知」、不抛异常。
- `scripts/test-console-failpaths.mjs` → **115 项**（14 面板 × 4 种故障，新增「体检·视觉」）
- `scripts/test-console-static.mjs` → 全过（含 11 条专测视觉项）

### ⚠️ 待 A 定稿

`inputModalities` 目前**还没进** `/api/dsh/models` 的返回（`src/model-fallback.js` 的 `collectCatalogModels` 只回 `provider/model/label`）。所以在真实环境里这一项**现在显示「未知（模型清单没返回 inputModalities，能力字段待接入）」**——这是刻意的：宁可说不知道，也不能默认成能看图。A 把字段补上后自动生效，前端不用再改。

## 批次二十：视觉口径换成 `seesImages` + tier 被拒的可见提示

背景：批次十九按 `inputModalities` 含 `image` 判断视觉能力，**依据是错的**（DSH 的 modelCatalog 根本不返回能力字段，那套推断只是恰好蒙对）。实测探针 `scripts/probe-vision.mjs`（2026-10-25 19:44，6 个模型）证明：**只有 `deepseek-account/deepseek-flash` 能收图**，其余 5 个一律 `session/attachment-invalid: Model "..." does not support image input.`

### 1) 视觉项改读事实字段

| 改动 | 内容 |
|---|---|
| 判定依据 | `pickVisionSupport()` 只读 A 在 `/api/dsh/models` 每个模型项上给的 **`seesImages: boolean`**；**不再读 `inputModalities`**（代码里已无 `.inputModalities` 引用，仅注释保留说明） |
| 三态 | `true` → 绿「<模型> 支持图片输入」；`false` → 黄「当前模型不支持图片输入，发图会被忽略或误判」；字段缺失/接口没有 → **灰「未知（模型清单没返回 seesImages，能力字段待接入）」**，绝不默认成能看图 |
| 降级叠加 | `degraded === true && seesImages === false` → 模型项追加「· 降级导致视觉不可用」（幂等） |

### 2) tier 被桥接硬拒绝时的可见提示

A 的 tier 硬约束会拒绝「没先问用户选档」的出图调用，且禁止静默改 free。前端在 `runDraw()` 的非 2xx 分支里：

- `res.status === 400 && /tier|档位|选档|先问用户/i.test(error + code)` → 标题写「**档位缺失，桥接拒绝出图：**」，后面**原样透出**服务端 `error` 与 `code`（形如 `（tier-required）`），不二次改写；
- 结果行写明「**本次没有出图，也没有自动改成免费档。需要先问用户选哪档：免费档（带 AI生成 标注）或 高质量档（画质更好，每天 30 次）。**」；
- **不显示任何成功态/进度态**（无 `✅ 已发送`、无「生成中」、无「已按免费档出图」），按钮在 `finally` 里恢复可用；
- 代码里**不存在**自动降级到 free 的分支（静态断言钉住）。

### 验证

- 抽内联 script `node --check` → 3/3
- `test-health-card` → **22 条**（三组：`seesImages=true` / `false` / 字段缺失 + 降级叠加 + 接口 500）
- `test-draw-panel` → **32 条**（新增 5 条：档位被拒的标题、原文与错误码原样、操作指引、无成功/进度态、按钮不卡 busy）
- `test-console-static` → **385 项**（含 7 条 tier 拒绝断言、视觉项断言改为 `seesImages`）
- `test-console-failpaths` → 115 项；`test-draw-contract` / `test-storage-card` / `test-error-bar` → 全过

### 同步说明

`git merge --ff-only main` 报 `Not possible to fast-forward`（本分支带未合并提交），改用 `git merge main`；`public/console.html` 有一处文案冲突（两版「两档都会带 AI生成 标注」），已合并两边的信息，保留「角落小角标，不是大 logo」并补上「细节更多」。

## 批次二十一：群文件转存 + 观察学习（只读）

背景：施工 C 落地了文件台账（`src/file-archive.js`）与观察学习（`src/observe-learn.js`），但控制台看不到。本批把两块搬上用量页（存储卡下方），全部独立降级。

### 契约（先读实现再写，不照任务书猜）

| 路由 | 真实返回（`src/file-archive.js`） |
|---|---|
| `GET /api/files/stats` | `{ ok, generatedAt, retention{unclassifiedDays,classifiedDays}, files{active,activeBytes,classified,unclassified,due,dueBytes,deleted,deletedBytes,total}, byGroup[{groupId,files,bytes}], enabled, groups, dir, maxFileMb, nextCleanupAt }` |
| `GET /api/files?limit=` | `{ ok, files[{ id, groupId, fileName, storedName, relPath, bytes, category, archivedAt, cleanupAt, uploader, ... }] }` |
| `POST /api/files/cleanup` | `{ ok, checkedAt, deleted, bytes, missing, failed }` |
| `POST /api/files/category` `{id,category}` | `{ ok, id, category, cleanupAt }`（后端重算清理时间） |

### 实现

| 需求 | 落地 |
|---|---|
| 转存概览 | `#filesSummary` 三个指标：已转存 / 占用 / 下次清理（`fileDateText` 显示成本地日期）；按群明细放 `<details>` **默认折叠**，每行「群号（N 个）+ 占比条 + 大小」 |
| 空态 | `active === 0` 时 hint 写「还没有转存文件（白名单群上传后自动保存）」，**不把 0 B 当故障** |
| 失败态 | stats 挂了 → 三项都写「未知」，hint 写「未知，接口不可用」；列表挂了 → `#filesMsg` 写「台账列表：未知，接口不可用」。两块各自 try/catch，互不影响 |
| 数字格式 | 复用存储卡的 `formatBytes`（B/KB/MB/GB，<100 一位小数、≥100 取整） |
| 台账列表 | `FILES_LIST_LIMIT = 50`（接口上限 1000，不全量渲染），容器 `max-height:46vh` 可滚；每行：文件名 / 群·大小·转存日期 / 分类输入框 / 保存 / 清理时间 / 提示 |
| 改分类 | 保存 → `POST /api/files/category`，成功用**后端返回的 `cleanupAt`** 就地更新该行（不自己算），并提示「已保存 · 清理时间已按新分类重算」；失败显示真实错误 |
| 立即清理 | 两次 `confirm()`（第二次确认）→ 按钮禁用 → `POST /api/files/cleanup` → 成功写「✅ 删除 N 个文件，释放 X」（有 missing/failed 时附在括号里且变红字）；失败只写「清理失败：<服务端原文>」，**没有任何假成功**；`finally` 恢复按钮 |
| 观察学习（只读） | `#observeSummary` 两项 + 说明「只看不说：不唤醒、不回复、不扣额度，只收集词汇与表情包」。**桥接没有暴露 observe 配置接口**（grep 过 `src/bridge.js`，`cfg.observe` 只在内部用），所以开关/白名单如实写「未知」，并注明「待桥接提供 observe 配置接口」，不猜、不探不存在的路由 |

### 验证

- 抽内联 script `node --check` → 3/3
- `test-console-static` → **412 项**（新增 27 条：13 个 id、四处接口调用、limit、空态、失败态、无假成功、两次确认、就地更新 cleanupAt、观察学习只读）
- `test-console-failpaths` → **131 项**（16 面板 × 4 种故障，新增「文件转存」「观察学习」）
- **真实接口手核**：用运行实例的 `state/console-token` 直接请求 `GET /api/files/stats` → 200，字段与本批实现一致（`retention.unclassifiedDays=60 / classifiedDays=120`、`files.active=0` → 走的正是空态分支）

### 补丁：observe 两格点亮（同批）

后端补了只读 `GET /api/observe/config`（main `74de150`）后，前端把「未知」换成真实数据：

| 格 | 规则 |
|---|---|
| 开关 | `enabled === true` → 绿「已启用」+ `description`；`false` → 灰「未启用（只学习不发言的能力当前关闭）」。**`description` 在未启用时是 `null`，显示「未启用」而不是「未知」** |
| 观察群 | `groups.join(', ')`；空数组 → 「未配置」。未启用但 groups 有值时注明「已配置，当前未启用，不会生效」 |
| 学习项（新增第三格） | `词汇 ✓ / 表情包 ✓`，某项 `false` 显示 ✗ |
| 失败态 | 独立降级「未知，接口不可用」，并在 `#observeMsg` 写明「其它卡片不受影响」 |

手核渲染（fixture 驱动，两种状态）：

- 未启用：`未启用｜未启用（只学习不发言的能力当前关闭）`、`100000001｜已配置，当前未启用，不会生效`、`词汇 ✓ / 表情包 ✓`
- 已启用：`已启用｜观察学习白名单：100000001,123456789（…不会唤醒/回复/发消息）`、`100000001, 123456789｜这些群只学习不发言`、`词汇 ✓ / 表情包 ✗`

验证：`test-console-static` → **419 项**（新增 8 条：真实调用 `/api/observe/config`、null 语义、groups 拼接、未启用注记、✓/✗、失败态）；`test-console-failpaths` → **131 项**（观察学习面板在 4 种故障下仍「未知」不抛）。

### 原待办（已解决）

- `observe` 需要后端暴露只读接口（例如挂到 `/api/status` 或新增 `GET /api/observe`），前端拿到后把两格从「未知」改成真实开关/白名单即可（位置已留好 `#observeEnabled` / `#observeGroups` / `#observeMsg`）。

## 批次二十二：转存面板跟上新口径 + 分类下拉 + 可访问性

背景：转存范围收窄为**图片 + 压缩包**（表情包一律不转存、其它类型也不转存），单文件上限 200MB → **2500MB**（字段仍是 `maxFileMb`），台账 `category` 会出现 `image` / `archive`。

| 改动 | 内容 |
|---|---|
| 单文件上限 | **动态读 `stats.maxFileMb`**（不写死 200/2500），显示「2500 MB」+ hint「单文件超过上限不转存」。**刻意不换算成 GB**：2500 MB 按二进制会显示「约 2.4 GB」，与用户口径（2.5 GB）打架 |
| 范围说明 | 新增一行「自动转存：**图片、压缩包**（zip/rar/7z/tar/gz…）；**表情包不转存**」 |
| 占用显示 | 复用 `formatBytes`：2.5 GiB 量级显示 `2.5 GB`，不会出现 `2560.0 MB` |
| 容量提示位 | `#filesWarn`（`role=status` + `aria-live`）：`files.activeBytes > FILES_WARN_BYTES`（**50 GiB 常量**）时显示红字「本地转存占用已超过 50 GB（…），请检查清理策略」；阈值先写前端，后端加字段后再换 |
| 分类下拉 | 选项 `未分类('')` / `image` / `archive` / `其它…`；选「其它…」才出现自由输入并自动聚焦，回车提交。**当前值不在枚举里时**下拉多一项「当前值：<原值>」，不显示成「未分类」误导 |
| 改分类 | 仍 `POST /api/files/category {id, category}`，成功后用**后端返回的 `cleanupAt`** 就地更新该行 |
| 可访问性 | 新面板控件可见 `:focus-visible` 轮廓（`outline:2px solid var(--accent)`）；改分类结果 / 清理结果 / 台账提示都是 `aria-live="polite"`；「立即清理」改成 **`role="dialog"` 弹层**：打开时焦点移到「确认清理」、`Esc` 取消、点遮罩取消、关闭后焦点归还原按钮；每行 `role="row"`；分类控件都有 `aria-label="为 <文件名> 设置分类"`；沿用全局 `prefers-reduced-motion` 规则 |

**注意**：清理不再是 `confirm()` 两次，而是一个真正的对话框（`#filesCleanupOverlay`），因为 `confirm()` 挡不住「焦点没移过去 / 键盘取消不了」这两个可访问性问题。

### 验证

- 抽内联 script `node --check` → 3/3
- `test-console-static` → **432 项**（本批 +20：maxFileMb 动态、范围说明、FILES_WARN_BYTES、50GB 提示、下拉三态、未知值兜底、自由输入、aria-label、aria-live×3、dialog、焦点移入/归还、Esc、focus-visible）
- `test-console-failpaths` → **131 项**（16 面板 × 4 故障，无回退）
- `test-storage-card` 31 / `test-health-card` 22 / `test-draw-panel` 32 → 无回退
- fixture 手核：
  - `maxFileMb=2500` → 显示 `2500 MB`；`activeBytes=5MB` → `5.0 MB`、`#filesWarn` 隐藏；
  - `mode:'huge'`（60 GiB）→ `#filesWarn` 显示「本地转存占用已超过 50 GB（60.0 GB），请检查清理策略」；
  - 台账 4 行，首行「会议纪要.docx｜群 123456789 · 0.2 MB · 转存 2026/10/25」，含一条未知分类 `历史遗留分类`（下拉显示「当前值：历史遗留分类」）。

### 待办

- 50GB 阈值目前是前端常量；后端加字段（如 `stats.warnBytes`）后可换成动态。
- 分类枚举若与 C 落盘值不一致（C 现在写的是中文「图片/压缩包」），下拉会把它们显示成「当前值：图片」——等 C 切到 `image/archive` 后自然一致；这两套值都能正常保存。

## 批次二十三：文件面板筛选 / 错误文案 / 可访问性收尾

### 1) 台账可筛可选

顶部新增一行筛选：**按群**（选项由当前列表的 groupId 动态生成）、**按分类**（全部分类 / 未分类 / image / archive / 已分类任意）、**文件名搜索**。

- 过滤实现是**隐藏行**（`row.hidden = !ok`），不是重建 DOM —— 所以行内正在编辑的分类输入框内容不会被清掉；
- 计数文案固定写出上限：「显示 X / 共取回 N 条（只取回了最近 N 条，更早的记录需要翻页；接口正在补 offset）」——在拿到 `total` 之前，**不会让用户以为这就是全部**。

### 2) 错误文案统一（不再出现「未知」）

新增 `filesApiFail(label, method, path, error, payload)`，所有文件面板失败分支都走它，输出：

```
台账列表读取失败：GET /api/files?limit=50 — HTTP 500 Internal Server Error：{"ok":false,"error":"内部错误"}
转存统计读取失败：GET /api/files/stats — HTTP 200，返回的不是 JSON：{ "ok": true, <<< …
分类保存失败：POST /api/files/category — HTTP 503：消息库不可用
清理失败：POST /api/files/cleanup — HTTP 500：…
```

四个分支（stats / list / category / cleanup）各自独立降级，互不影响，也不影响存储卡与账本。failure 时数值显示 `—` 而非「未知」。

### 3) 可访问性收尾

- **skip link** 已有（`.skip-link` → `#mainContent`「跳到主要内容」），本批加了断言防回退；
- **全局 `:focus-visible`** 已存在（`outline:3px solid var(--focus-ring)`，对所有 `button,a,input,textarea,select,summary` 生效），不是只有文件面板有；
- 状态变化（改分类成功/失败、清理完成、筛选计数）都是 `aria-live="polite"`；
- 标题层级：全站 1 个 `h1`，卡片 `h2`，用量页内分块 `h3`（h1→h2→h3 无跳级），本批加断言；
- 分类控件 `aria-label="为 <文件名> 设置分类"`；清理是 `role="dialog"` 弹层（焦点移入/`Esc` 取消/关闭归还焦点，批次二十二已做）。

**对比度核算**（`--muted` 文本，WCAG 4.5:1 阈值）：

| 主题 | 前景 | 背景 | 对比度 |
|---|---|---|---|
| 浅色 | `--muted #5d6878` | 卡片 `#ffffff` | **5.65 : 1** |
| 浅色 | `--muted #5d6878` | 页面 `#f5f7fb` | **5.27 : 1** |
| 深色 | `--muted #8d98ac` | 卡片 `#161b24` | **5.94 : 1** |
| 深色 | `--muted #8d98ac` | 页面 `#0d1016` | **6.55 : 1** |

全部 ≥ 4.5:1，无需调整。

### 验证

- 抽内联 script `node --check` → 3/3
- `test-console-static` → **444 项**（本批 +12：筛选控件 ×4、隐藏行过滤、计数上限文案 ×2、`filesApiFail` 构造与格式、失败分支全覆盖、无「未知，接口不可用」、skip link、h1 唯一与不跳级、全局 focus-visible、aria-live）
- `test-console-failpaths` → **131 项**（16 面板 × 4 故障；文件面板失败文案现在必须含 `/api/files`，已改为断言接口名）

### 踩坑记录

`FILES_LIST_LIMIT` / `FILES_WARN_BYTES` / `FILES_CATEGORY_OPTIONS` 原本是 `const`，但页面启动时 `refreshUsage()` 会**同步**调到 `refreshFiles()`，那一刻这几个 `const` 还没初始化 → `ReferenceError: Cannot access 'FILES_LIST_LIMIT' before initialization`，整个脚本首屏就崩。已改成 `var` 并写明原因（TDZ）。

## 批次二十四：表情注释页「图片已失效」修复

### 复现与根因（先查数据再改代码）

读了运行实例的 `state/stickers.json`：**82 条，其中 5 条没有 `md5`、20 条的 `url` 带 `rkey`**（QQ CDN 的 rkey 会过期）。控制台 `ops.html` 原来的逻辑是：

```js
img.src = '/api/stickers/thumbnail?id=' + id;   // 桥接内部：先读 state/sticker-files/<MD5>.img，再联网
img.onerror = () => { 写一句「图片已失效」 };
```

没有 md5 的条目**根本进不了本地缓存分支**，只能拿会过期的 CDN URL；CDN 401/403 时桥接回 502 → `onerror` 只写一句「图片已失效」，既没说明原因，也没告诉用户能怎么办。

> 后端那半边由施工 C 的 `c7789f1` 解决（id 唯一化 / 缩略图逐候选 / md5 回填 + `POST /api/stickers/repair`）。本批只做前端，且**按 C 的真实路由写**：`GET /api/stickers/thumbnail?id=`（200 图片 / 404 找不到 / 502 全候选失败）、`POST /api/stickers/repair {apply}`（默认预演，返回 `repaired/dead/failed/total`）。

### 前端修复

| 项 | 实现 |
|---|---|
| 三级兜底 | `buildStickerThumb(e)`：① `GET /api/stickers/thumbnail`（桥接先读本地缓存，再联网并回填 md5）→ ② 失败后**只试一次** `e.url` 直连（便宜兜底，多数已过期）→ ③ 仍失败则移除 `<img>`、换成占位 div「**缩略图不可用（可用「重新拉取」）**」。全过程 `onerror` 驱动，**不会出现浏览器默认碎图标** |
| alt | `img.alt = e.localNote || e.desc || '表情缩略图'`；占位 div 也有 `title` 说明原因 |
| 重新拉取（单卡） | 每张卡多一个「重新拉取」按钮 → `POST /api/stickers/repair {apply:true}`（后端只有批量接口）→ 成功显示「已重新拉取：修复 N ／ 失效 M ／ 失败 K」（用服务端计数）并重新加载列表；失败显示「重新拉取失败：POST /api/stickers/repair <状态> — <服务端原文>」，**无任何假成功** |
| 重新拉取（批量） | 工具栏「批量重新拉取」：进行中文案 + 按钮禁用，完成后显示服务端计数；失败同样透出接口与状态 |
| 列表失败文案 | `loadStickers` 改成先读文本再解析，失败抛「GET /api/stickers?count=500 <状态> — <原文>」，不再是含糊的「加载失败」 |

### 验证

- 抽内联脚本 `node --check` → console/ops 共 3 段全过
- `test-console-static` → **458 项**（本批 +14：兜底构造函数、thumbnail 优先、CDN 仅兜底一次、占位文案、旧「图片已失效」已移除、onerror 兜底、alt、单卡/批量入口、repair 路由、成功计数、失败含接口与状态）
- `test-console-failpaths` → **139 项**（原有 16 面板 + 新增「表情注释」面板 4 种故障：404 / 空列表 / 坏 JSON / 超时，全部「不抛异常 + 文案含接口名与状态」）
- `scripts/test-sticker-thumbs.mjs`（新增）→ **19 项**：兜底链三级顺序、占位与移除 img、alt、repair 成功/失败/批量、列表 404 与空列表、坏 JSON、超时
- fixture 新增 `/api/stickers`、`/api/stickers/thumbnail`（1×1 PNG / 502 模式）、`/api/stickers/repair` 与 `/__fixture/stickers` 控制口

### 修前 / 修后对照

| 场景 | 修前 | 修后 |
|---|---|---|
| 有 md5、缓存存在 | 正常显示（走本地缓存） | 同左（仍优先本地） |
| 无 md5、CDN 已过期 | `onerror` → 「图片已失效」，无解释无操作 | 占位「缩略图不可用（可用「重新拉取」）」+ 按钮可修复 |
| CDN 偶发 401/403 | 同上，且不知道是链接过期 | 先回落原始 URL 试一次，再给占位与原因 |
| 桥接接口还没上线 repair | 点了没反应/报错 | 明确「重新拉取失败：POST /api/stickers/repair 404 — …」 |

### 未做（等后端合入）

`scripts/test-sticker-smoke.mjs` 之类的**真实调用 smoke** 暂未加：本工作树的 `src/bridge.js` 里还没有 `/api/stickers/repair`（`grep` 计数 0），跑起来只会得到 404。C 的 `c7789f1` 合进 main 后可补一条带 console token 的 200 smoke。

## 批次二十五：表情注释页「重复卡片 + 图片已失效」两件事一起修

用户截图：4 张一模一样的重复卡片 + 2 张「图片已失效」，计数 `共 92 / 可发 35 / 不可发 57 / 未注释 58`。我复读运行实例数据确认：**不是文件丢了**（`state/sticker-files/` 里 `*.img` 齐全），而是面板拿 `entry.url`（`p.qpic.cn` 的临时链，带 rkey）当 `img.src`，过期就裂。

### 已完成（前端，`public/ops.html`）

| 项 | 实现 |
|---|---|
| 面板侧去重 | `dedupeStickerEntries()`：按 `md5`（无则 `id`）分组，`mergeStickerEntries()` 合并——**备注取最长非空、desc/usage 取首个非空、tags 取并集、policy 冲突时保留「可发」**（不丢人工设置），`__mergedCount` 记录合并条数 |
| 计数 | 顶部改为「**共 N（唯一）｜合并掉 M 条重复**｜可发 X｜不可发 Y｜未注释 Z｜本页 K」 |
| 来源链（顺序固定） | `stickerThumbChain()`：**`/api/stickers/thumb?md5=` → `/api/stickers/thumbnail?id=`（桥接内部再查缓存/联网并回填 md5）→ QQ CDN URL → 占位**；`onerror` 逐级推进，最终移除 `<img>` 换占位，**不出现碎图标** |
| 占位与重取 | 占位文案「**缩略图不可用（本地缓存缺失/损坏，可用「重新拉取」）**」；单卡/批量「重新拉取」调 `POST /api/stickers/repair {apply:true}`，成功用服务端计数，失败透出接口 + 状态 + 原文 |
| 仅看失效 | 筛选新增「仅看失效（缩略图不可用）」，用 `STICKER_BROKEN_IDS` 记录 |
| 合并重复按钮 | `#sticker-dedupe` → `POST /api/stickers/dedupe`；接口未就绪时显示「合并重复失败：POST /api/stickers/dedupe 404 — …」，成功显示「已合并 M 条重复（before → after）」并刷新 |

### 实测数据（改完后按现场数据算的预期）

现场 `state/stickers.json`：**82 条原始 / 81 条唯一（多出 1 条）/ 77 条有 md5 且本地 `.img` 齐全 / 4 条无 md5**。
修完后：**81 条唯一表情里，77 条可从本地缓存直接显示**；剩 4 条（无 md5）走 thumbnail 联网并回填 md5，链接仍过期的话显示占位 + 「重新拉取」。

### 待后端落地（需求清单，只改 `wt-backend`/`wt-feature`）

1. **`GET /api/stickers/thumb?md5=<MD5>`**（新的本地缩略图路由）
   - 200：直接吐 `state/sticker-files/<UPPER(MD5)>.img` 字节，`Content-Type: image/*`（按魔数判定）、`Cache-Control: public, max-age=86400`
   - 400：`md5` 为空或不是合法 hex（**必须校验 hex，防 `../` 路径穿越**）
   - 404：`{ ok:false, error:'本地缓存里没有这个 md5' }`
2. **`POST /api/stickers/dedupe`** → `{ ok:true, merged, before, after }`
   - 按 `md5` 分组（无 md5 按 `id`）；合并规则：`localNote` 取最长非空、`desc`/`usage` 取首个非空、`tags` 并集、`policy` 冲突保留 `usable`；保留被合并条的 `createdAt` 最早者
   - 幂等：第二次调用 `merged === 0`
3. **`GET /api/stickers/dedupe?dryRun=1`** → 同样的 `{ merged, before, after }`，只算不写
4. **写入时去重**：`collectSticker` / 收藏 / 同步三条入口落库前按 `md5`（无则 `id`）查重，已存在则合并字段、不新增条目
5. 现有 `GET /api/stickers/thumbnail?id=` 与 `POST /api/stickers/repair` 保持（前端已按它们写，repair 默认预演语义不变）

前端对以上接口**全部按「未就绪则降级」**实现：thumb 404 时自动落到 thumbnail → CDN → 占位；dedupe 404 时按钮给出精确错误，面板侧去重仍然生效。

### 测试

- `scripts/test-sticker-dedupe.mjs`（新）→ **8 项**：92→84、备注/标签不丢、可发优先、**幂等（第二次 merged=0）**、dedupe 接口 404 与成功两态
- `scripts/test-sticker-thumb.mjs`（新）→ **14 项**：`thumb` 200（content-type/cache-control/字节数与文件一致）、404、400；来源链四级顺序；thumb 404/超时下链照常推进且不抛
- `test-console-static` → **471 项**（本批 +13：去重函数、合并规则、计数文案、合并按钮与路由、来源链顺序、无 `p.qpic.cn` 写死、仅看失效、占位文案）
- `test-console-failpaths` → **143 项**（表情面板 4 种故障 + 缩略图全失败显示占位不抛）
- `test-sticker-thumbs.mjs`（上一批）同步更新到三级链，**20 项**全过

### 未做

- 真实调用 smoke：本树没有 `/api/stickers/dedupe` 与 `/api/stickers/thumb`，等后端合入后补带 console token 的 200 smoke（同批次二十四）。

## 批次二十六：表情页接后端失效标记（thumbStatus=missing）

后端已把数据修完（`GET /api/stickers?limit=500` → **total=84**，82 条有本地缓存，**2 条已标记 `thumbStatus:"missing"`**）。前端这轮只做兜底与失效标记，接口仍用现成的 `GET /api/stickers/thumbnail?id=&token=`。

| 项 | 实现 |
|---|---|
| 取图 | 仍走 `/api/stickers/thumbnail?id=&token=`（桥接内部顺序：`sticker-files/<MD5>.img` → `entry.url` → OneBot get_image）；`onerror` 逐级兜底后换灰底占位，**不出现碎图标** |
| 失效条目 | `thumbStatus === 'missing'` 时**不再发请求**，直接占位「**缩略图不可用 · 源链接已过期**」（`title` 带后端 `thumbError`），并显示一句「可重新采集：群内发『/收藏』或让 AI 再偷一次」+「**删除该条**」按钮（调 `POST /api/stickers/remove`，成功/失败都透出接口与状态） |
| 只看失效 | 筛选项改为「**只看失效**」，判定 `isStickerBroken(e) = thumbStatus==='missing' || 加载失败过` |
| 计数 | 顶部改「**共 84**（合并掉 N 条重复）｜**其中失效 2 条**｜可发…｜不可发…｜未注释…｜本页…」；`共 N` 用接口返回的 **`total`**，不再本地算 |
| 去重 | 面板侧仍按 md5 折叠（后端已去重，这里作为兜底），合并逻辑不变 |

### 对照：84 条里能显示几张

- **82 / 84 能正常显示**（本地 `.img` 命中，走 thumbnail 第一优先级）；
- **2 / 84 显示失效占位**（`thumbStatus:"missing"`，源链接 HTTP 400 且采集时未落盘，无法恢复）——卡片上有「删除该条」与重新采集提示。

### 测试

- `test-console-static` → **479 项**（本批 +8：识别 thumbStatus、占位文案「源链接已过期」、删除按钮与 remove 路由、重新采集提示、「其中失效 N 条」、共 N 用 total、URL 带 token、missing 时不发网络请求）
- `test-console-failpaths` → **143 项**（不变；thumb 404/500 下仍「不抛异常 + 显示占位」）
- `test-sticker-thumb` → **20 项**（新增：missing 直接占位且无 `<img>`、title 带 thumbError、删除成功/失败两态、`total=84` 读取）
- `test-sticker-thumbs` 20 / `test-sticker-dedupe` 8 → 全过

### 后端（已就绪，无需新接口）

本轮**没有**新增后端需求；前端只用现成的 `GET /api/stickers/thumbnail?id=&token=`、`POST /api/stickers/remove`、`POST /api/stickers/repair`、`GET /api/stickers?limit=500`。

## 批次二十七（用户口径第二十六批）：按群分组明细 + 台账真分页 + 观察学习接真接口

用户截图：控制台「文件转存」里「按群分组明细」打开是空的、台账写着「接口正在补 offset」，而「观察学习」三格全是「未知 · 未知，接口不可用」。实测后端（main cf62f75，带 console token）：

```
GET /api/files?limit=3&offset=0 → { ok, files:[…], total:11, offset:0, limit:3 }
GET /api/files/stats            → { …, byGroup:[{groupId,files,bytes}], accept:{…}, maxFileMb:2560 }
GET /api/observe/config         → { enabled:true, groups:["100000005"], learnSlang:true,
                                    learnStickers:true, description:"…", source:"config.json" }   ← 注意：没有 ok 字段
```

**根因两条**：
1. `observe/config` 线上**不返回 `ok`**，前端按 `r.ok !== true` 判失败 → 好好的数据被当成「接口不可用」；
2. 台账还在用「只取回最近 N 条 + 接口正在补 offset」的旧口径，`byGroup` 只认数组、且折叠标题写死「默认折叠」。

| 位置 | 修法 |
|---|---|
| 按群分组明细 | `byGroup` 兼容**数组 / 单个对象 / 缺失**三种形态（A 的契约文档定为数组）；标题动态写「按群分组明细（N 个群）」；每行「群号（N 个）· 占比条 · 格式化占用」；空（`[]`/缺失/空对象）显示「还没有转存文件（白名单群上传后自动保存）」，不把 0 B 当故障 |
| 台账分页 | 改成**真 offset**：`GET /api/files?limit=<20/50/100>&offset=<n>`，用返回的 `total/offset/limit` 渲染「第 X / Y 页　显示 A–B / 共 N 条」，上一页/下一页在边界禁用、页码越界夹住；`limit` 给 20/50/100 选择器；计数行改「本页筛出 M 条 ｜ 显示 A–B / 共 N 条」，**删除「接口正在补 offset」** |
| 观察学习 | 以「`enabled` 是布尔」判定有效响应（不再要求 `ok`）；`enabled=true` → 绿「已启用」+ `description`；`false` → 灰「未启用（只学习不发言的能力当前关闭）」+ 白名单照实显示并注「已配置，当前未启用，不会生效」；学习项 `词汇 ✓/✗`、`表情包 ✓/✗`；**只有请求真失败**才写「观察学习配置读取失败：GET /api/observe/config — <状态/原因>」 |
| 独立性 | 两块各自 `try/catch`，互不影响；`refreshFiles()` 内部两个请求也各自降级 |

**踩坑**：`filesPager` 用 `var` 提升后在启动那轮 `refreshUsage()` 里仍是 `undefined`（读 `.limit` 直接抛），已把初始化提前到脚本前部；同时补回了被替换掉的 `rebuildFilesGroupOptions()`。

### 真实接口渲染验证（假 DOM + 真桥接 127.0.0.1:3100）

```
折叠标题 : 按群分组明细（1 个群）
分页文案 : 第 1 / 1 页　显示 1–11 / 共 11 条
台账计数 : 本页筛出 11 条　｜　显示 1–11 / 共 11 条
观察开关 : 已启用 | 观察学习白名单：100000005（…不会唤醒/回复/发消息）
观察群   : 100000005 | 这些群只学习不发言
学习项   : 词汇 ✓ / 表情包 ✓
```

### 测试

- `test-console-static` → **486 项全过**（新增：byGroup 三态、折叠标题带群数、分页控件与真 offset、不再出现「接口正在补 offset」、空态文案、观察学习 `enabled` 判据、失败文案带接口名）
- `test-console-failpaths` → **156 项全过**（新增数据形态组：byGroup 数组/单对象/缺失/空、台账分页文案与按钮边界、观察学习未启用时的白名单与「不会生效」）
- fixture 同步：`/api/files` 支持 `limit&offset&total`（120 条假数据）、`/api/files/stats` 的 `byGroup` 可按 `array|object|missing|empty` 变形、`/api/observe/config` **去掉 `ok` 字段以对齐线上**

### 未做

- A 的 `docs/api-contract-files.md` 里还将加 `observe.effectiveGroups`；前端目前只用 `groups`，等字段落地后再决定是否显示「实际生效群」。

## 批次二十八（用户口径第二十七批）：文件转存改 BOOTH 风格「卡片库」页面

用户对原来的「一行行文字」转存面板明确不满意，要求做成 BOOTH Library Manager 那种卡片库。新增独立页 **`public/library.html`**（控制台顶栏加 ▦ 入口，新窗口打开，token 沿用 `localStorage.consoleToken` 或 `?token=`）。

### 页面结构

| 区域 | 内容 |
|---|---|
| 左侧栏 | **Home**（共 N / 占用 / 待补抓 / 未分类）、**Lists**（分类+计数，点分类跳回 Library 并筛选）、**Notify**（角标 = `pendingEnrich + failed`，点进去是待补抓/未分类清单）、**Library**（全部卡片）、**Settings**（上限/保留期/占用只读占位） |
| 顶栏 | 标题、搜索（输入防抖 300ms，回车立即）、Filter（分类多选 / 店铺 / 状态三选）、排序（最新 / 最早 / 标题 / BOOTH 号）、刷新、导出 JSON / CSV |
| 卡片网格 | `repeat(auto-fill,minmax(200px,1fr))`；缩略图 `aspect-ratio:4/3` + `loading="lazy"` + `onerror` 换「无缩略图」；标题两行省略；店铺名；左下分类徽标；右上状态点（`enrichStatus`：ok 绿 / pending 黄 / 无 booth 灰） |
| 分页 | 每页 24/48；「第 X / Y 页 · 共 N 件」；上一页/下一页，页码越界夹住 |
| 详情抽屉 | 标题/店铺/价格/标签/BOOTH 链接（新窗口）/本地路径/大小/转存/清理/`meta.json` 预览；**重新抓取**（`POST /api/files/enrich`）、**改分类**（`POST /api/files/category`）、删除按钮**没放**（后端无删除接口，等接口再加） |
| 空/失败态 | 空数据「还没有转存文件（白名单群上传后自动保存）」；失败「读取失败：GET /api/files — HTTP 500：…」；侧栏/卡片区/详情各自独立降级 |

### 接口与兼容

- 已存在并用到的：`GET /api/files`（`limit/offset` → `total/offset/limit/files`，字段含 `boothId/boothUrl/boothTitle/boothShop/boothPrice/boothTags/enrichStatus/thumbUrl/metaUrl/relPath`）、`GET /api/files/thumb?id=`、`POST /api/files/enrich`、`POST /api/files/category`、`GET /api/files/export?format=`、`GET /api/files/meta?id=`。
- **还没上线**的 `GET /api/files/lists`、`/api/files/notify`、`/api/files/item`（A 的 msg-a52）：前端**先用本地数据现算**（`deriveLists` / `deriveNotify`），接口一旦可用自动切换，不报错、不显示「未知」。
- 服务端筛选参数 `q/category/shop/status/sort` 尚未支持：当前一次取最多 1000 条后**本地筛选/排序/分页**（注释里写明，接口就绪后把 `loadAll` 换成带参请求即可）。

### 测试

- `test-console-static` → **525 项**（新增 39 条：library.html 存在、12 个控件 id、5 个导航、6 个接口调用、网格/懒加载/4:3、分页文案与边界、空态、失败文案带接口名、状态点与分类徽标、抽屉两按钮、target=_blank+noopener、token 传递、无「未知」、console 入口链接）
- `test-console-failpaths` → **166 项**（新增 10 条：库页 404 / 坏 JSON / 超时 / 空列表，各自「不抛异常 + 文案带接口名与状态」，并断言侧栏不崩）
- fixture：`/api/files` 每条补 BOOTH 字段与 `thumbUrl`、`enrichStatus`；新增 `/api/files/{lists,notify,item,export,enrich}`；故障注入新增 **404 模式**
- 渲染自检（fixture 120 条假数据，打印 DOM 文本）：
  - 侧栏 `Home 120 / Lists 3 / Library 120 / Notify 角标 19`
  - Home：`共转存 120 占用 7.1 MB 待补抓 17 未分类 30`
  - Lists：`3D衣装 40 / image 40 / 未分类 40`
  - Notify：`待补抓 17 抓取失败 2 未分类 30` + 待补抓清单
  - Library：卡片 24 张/页，分页「第 1 / 5 页 · 共 120 件」

### 未做

- 删除按钮（后端无删除接口）；Settings 真实编辑（只读占位）；`/api/files/{lists,notify,item}` 就绪后把本地推导换成请求（结构已对齐）。

## 批次二十九（用户口径第二十八批）：库页改成「商品卡片」，图片不再当卡片

用户定规则：**库页只出现按 BOOTH 商品聚合的压缩包卡片**；图片只有在与商品同 BOOTH 号时作为素材出现在详情的缩略图网格里；对不上号的（压缩包或图片）统一进「未分类」。

| 项 | 改法 |
|---|---|
| 数据源 | 改用 A 的 `GET /api/library/items`、`/api/library/item/:id`、`/api/library/unclassified`、`/api/library/item-thumb?boothId=`；**删掉** `/api/files` 平铺列表与文件级导出（不再把图片当卡片） |
| 商品卡片 | 方形缩略图（`aspect-ratio:1/1`、`loading="lazy"`）取 `coverUrl`，没有则 `/api/library/item-thumb?boothId=`；**onerror / 无号 → 「封面缺失」占位**（不出碎图标） |
| 卡片信息 | 标题两行省略 + 店铺 + 右下「N 个文件 · X MB」+ 左下分类徽标 + 右上状态点（ok 绿 / pending 黄 / 缺封面灰） |
| 点击 | 开右侧**详情抽屉**（不是直接跳 BOOTH）：标题/店铺/分类/「在 BOOTH 打开」/文件数；压缩包逐条列文件名·大小·时间；**同号图片以缩略图网格显示（素材）**；meta 摘要；按钮「重新抓取」→ `POST /api/files/enrich` |
| 未分类 | 左侧栏新增「未分类」（与 Library 并列，带计数）：两栏「压缩包 / 图片」，每条填分类 + 「归类」→ `POST /api/files/category`，成功即从列表移除并 toast |
| 筛选/排序 | 分类多选、店铺、状态（已归类/待补抓/封面缺失）；排序 最新入库/标题/BOOTH 号/大小；搜索匹配标题·店铺·BOOTH 号·文件名 |
| 分页 | 24/48，「第 X / Y 页 · 共 N 件」，页码越界夹住 |
| 空/失败 | 商品空：「还没有归档的压缩包（白名单群上传带 BOOTH 号的压缩包后自动归类）」；未分类空：「没有待分类的压缩包。」「没有待分类的图片。」；失败「读取失败：GET /api/library/items — HTTP 404：…」，boards 与未分类各自独立 |

**接口未上线时**（`/api/library/*` 当前 404）：库页直接显示带接口名的失败文案，**不回退**到 `/api/files`（避免又出现「图片当卡片」）；未分类同样独立失败，不拖垮商品区。

### 测试

- `test-console-static` → **527 项**（库页断言重写：4 个 library 接口调用、**不存在** `/api/files?limit=`、**不存在**把 `/api/files/thumb` 当封面、未分类入口、封面占位与 onerror、方形缩略图、抽屉「在 BOOTH 打开」、同号图片、归类接口、两条空态、两条失败文案、`images/meta` 从顶层取）
- `test-console-failpaths` → **168 项**（库页：items 404 / 坏 JSON / 超时、unclassified 500、封面 onerror 占位、无 boothId 直接占位、未分类空态）
- fixture：新增 `/api/library/{items,item/4123456,unclassified,item-thumb}`（1 商品 = 2 压缩包 + 2 同号图；未分类 1 压缩包 + 1 图片；`4000001` 的封面 404）+ `/__fixture/library` 控制口
- 渲染自检（fixture，打印 DOM 文本）：
  - 侧栏：`商品 2 / 分类 1 / 未分类 2 / Notify 角标 1`
  - 卡片：2 张，`演示衣装 套装 · 演示店铺 · 2 个文件 · 15.0 MB · 3D衣装`
  - 详情：`压缩包（2）demo-4123456.zip 10.0 MB / demo-4123456-2.zip 5.0 MB`、`同号图片（素材，2）`、`在 BOOTH 打开`
  - 未分类：`压缩包（1）无号压缩包.zip 200 KB 归类 / 图片（1）无号截图.png 4.0 KB 归类`
  - 空态：`还没有归档的压缩包（白名单群上传带 BOOTH 号的压缩包后自动归类）`

### 未做

- 商品级「下载 / 收藏 / 文件夹」没有做（后端无对应接口；先保证归类与抓取闭环）。
- `/api/library/item-thumb` 上线前，卡片封面会一直显示「封面缺失」；接口一旦可用无需改前端。

## 批次三十：高峰期本地模型可见（运维面板一块 + 控制台一行）

高峰期群聊已交给本地 `qwen3:8b`，但面板里看不出「当前是不是本地模式、用了哪个模型、最近回了什么」。

| 位置 | 内容 |
|---|---|
| `public/ops.html` 高峰期卡片 | 新增「高峰期本地模型」块：状态（**● 本地模式 / ● API 模式**）、模型名、窗口（09:00–12:00、14:00–18:00）、**最近 1 小时本地回复次数**、**平均耗时**、**最后一条回复（截断 60 字 + 时间）** |
| 数据源 | `GET /api/peak/status`（enabled/schedule/windows/inWindow/active）+ `GET /api/status` 的 `peakLocal{enabled,model,repliesLastHour,avgMs,lastReplyAt,lastReplyText}`（A 正在加，**缺失时全部写「后端未提供」**，模型名缺失时只注明「本地模型通常为 qwen3:8b」，不冒充当前值） |
| 错误态 | 任一接口 404/500/超时/坏 JSON → 状态行写「读取失败：GET /api/peak/status HTTP 500（模型信息：来自 /api/status）」，另一路能拿到的字段照常显示、拿不到的写「后端未提供」；该块独立，不影响其它面板 |
| `public/console.html` 用量页 | 指标卡下方一行小字：**「高峰期：本地 qwen3:8b（管理员+所有人）｜空闲：API ｜ 当前：本地模式」**；`/api/peak/status` 与 `/api/status` **都拿不到就整行隐藏**（默认 `hidden`），不显示「未知」 |

### 测试

- `test-console-static` → **547 项**（新增：ops 6 个字段 id、`/api/peak/status` + `/api/status` 两个数据源、「本地模式/API 模式」两种文案、「后端未提供」常量、qwen3 兜底说明、`loadPeakLocal` 轮询、最后回复截断 60、失败文案带接口名；console 的 `#peakLine` 默认 hidden、`refreshPeakLine`、两接口、文案片段、qwen3 兜底、全挂时隐藏）
- `test-console-failpaths` → **181 项**（新增：peak/status 404/500/坏 JSON/超时 四态各自「读取失败 + 状态」；peakLocal 缺失时模型/回复/最后一条都「后端未提供」而窗口照常；控制台一行有数据时文案正确、两接口全挂时隐藏）
- fixture：新增 `/api/peak/status`（09:00-12:00 / 14:00-18:00）、`/api/status.peakLocal`（qwen3:8b / 12 次 / 1830 ms / 示例回复）、`/__fixture/peak` 控制口（`localMissing`）

### 渲染自检（fixture）

```
状态 : ● 本地模式
模型 : 模型：qwen3:8b
窗口 : 09:00–12:00、14:00–18:00
回复 : 12 次
耗时 : 1830 ms
最后 : 这首《夜に駆ける》我也很喜欢，副歌那段转音真的很上头…（13:10:00）
控制台一行: 高峰期：本地 qwen3:8b（管理员+所有人）｜空闲：API ｜ 当前：本地模式
```

### 未做

- 不做写操作（没有「切回 API / 关本地模型」按钮）：本批只读；开关仍走 config。
- `/api/status.peakLocal` 上线前，面板显示「后端未提供」，窗口与模式仍可从 `/api/peak/status` 得到。

## 批次三十一（二十九批补）：高峰模型口径改为 agent + MiMo

高峰期不再用本地小模型，改成走 DSH agent、模型强制 `xiaomi-mimo/mimo-v2.6-pro`。面板跟着改口径，并清掉所有 qwen 文案。

| 位置 | 改动 |
|---|---|
| `public/ops.html` | 块标题「高峰期模型（agent）」；模式文案 **`● 高峰 · agent` / `● 空闲 · API`**；模型读 `/api/status.peakLocal.model`（A 补齐后就是 agent 的 provider/model），`peakLocal` 为空时显示 **「模型：读取中（等后端补 agent 模型）」**；窗口/近 1 小时回复/平均耗时/最后一条不变，仍缺失写「后端未提供」 |
| `public/console.html` | 用量页一行改为 **「高峰期：MiMo（保留识图/语音/画画）｜空闲：API」**；`/api/peak/status` 与 `/api/status` 都拿不到时整行隐藏 |
| 文案清理 | 源码里不再出现 `qwen` / 「本地小模型」/「本地模式」；`/api/peak/status` 的暂停开关保持原样（未动） |
| 错误态 | 不变：任一接口 404/500/坏 JSON/超时 → 「读取失败：GET /api/peak/status HTTP 500（模型信息：来自 /api/status）」；该块独立 |

### 测试

- `test-console-static` → **548 项**（新增/改写：「高峰 · agent / 空闲 · API」两种文案、模型缺失写「读取中」、块标题 agent 口径、**断言 ops 与 console 源码里都没有 qwen / 本地小模型**、console 文案整句为 MiMo 版）
- `test-console-failpaths` → **181 项**（peak 4 种故障原样；`peakLocal` 缺失时模型显示「读取中」、回复数与最后一条仍「后端未提供」；高峰线有数据时文案为 MiMo 版、两接口全挂时隐藏）
- fixture：`peakLocal.model` 由 `qwen3:8b` 改为 `xiaomi-mimo/mimo-v2.6-pro`（与线上一致）

### 渲染自检（fixture）

```
状态 : ● 高峰 · agent
模型 : 模型：xiaomi-mimo/mimo-v2.6-pro
窗口 : 09:00–12:00、14:00–18:00
回复 : 12 次
耗时 : 1830 ms
最后 : 这首《夜に駆ける》我也很喜欢…（13:10:00）
控制台: 高峰期：MiMo（保留识图/语音/画画）｜空闲：API
```

### 备注

- 后端 `peakStatusView()` 目前仍从 `peakPause.localModel` 取 `model`，所以真实 `/api/status.peakLocal.model` 可能还是旧的本地模型名；前端**照实显示接口返回值**，等 A 改成 agent 的 provider/model 后自动正确，不会显示编造值。
- `console.html` 里另有「本地兜底接管中」的模型提示，属于 DSH 本地兜底功能，与高峰模型无关，未改。

## 批次三十二（三十批）：运维面板「模型切换」升级为六 scope 可视 / 可切 / 可清

原来「模型切换」只有一个下拉（等于全局 main）。现在按 A 的 msg-a56 契约拆成 6 行：

| scope | 说明 | 默认值 |
|---|---|---|
| `main` | 主模型（空闲期默认，**不可清**） | `deepseek-account/deepseek-flash` |
| `peak` | 高峰期模型 | `xiaomi-mimo/mimo-v2.6-flash` |
| `media` | 视觉/带图模型 | `deepseek-account/deepseek-flash` |
| `group` | 群聊模型（modelByKind） | 未设置 |
| `private` | 私聊模型（modelByKind） | 未设置 |
| `override` | 临时覆盖（仅本次运行，重启失效） | 未设置 |

顶部提示：**「切换对下一轮生效，不重启桥接；除 override 外都会写入 config.json。」**

- 每行：说明 / 当前值 / 下拉（`provider/model`，带 `label`）/ 「应用」/ 「清除」（main 无清除）/ 行内结果。
- 下拉保留未知当前值：不在清单里时显示「当前：x/y（不在清单）」并可选保留。
- 「应用」→ `POST /api/model {scope, provider, model, persist:true}`；「清除」→ `DELETE /api/model?scope=`。
- 成功：绿字「**已切换 → provider/model（已落盘）**」/「已清除 → 恢复默认」；失败：红字显示后端 `error` 原文（如「失败：模型 x/y 不在可用清单里」）。
- 防连点：`opsBusy`（页面已有机制）+ 最短 1 秒占用窗口。
- 只读区：何时生效（下一轮）、当前是否有降级覆盖、`dsh.modelFallbacks` 降级链（来自 `GET /api/model` 的 `fallbacks`，只读）。
- 错误态：`GET /api/models` 失败 → 整块「读取失败：GET /api/models HTTP 500」，表格不出半套；`options` 为空或 `scopes` 缺失 → 下拉/按钮禁用，并注明「六 scope 接口未就绪（等 A 的 msg-a56），现在只读」——**不把旧后端的 main 写入当成 peak/media 切换**。

### 测试

- `test-console-static` → **564 项**（六 scope key、`/api/models`、POST/DELETE、无需重启提示、已落盘文案、main 无清除、opsBusy+1s、未就绪只读提示、未知值「不在清单」）
- `test-console-failpaths` → **193 项**（`/api/models` 404/500/坏 JSON/超时 各「读取失败 + 状态」且 rows 为空；POST 400 行内红字带后端 error；六个 scope 行齐全；DELETE 成功「已清除 → 恢复默认」；main 无清除按钮）
- fixture：`/api/models`（带 `scopes`/`options`/`catalog`/`note`）、`POST /api/model`（scope + persist + 400 注入）、`DELETE /api/model`（main 拒绝）、`/__fixture/models` 控制口

### DOM 文本样例

```
main    主模型         空闲期默认，不可清   deepseek-account/deepseek-flash
peak    高峰期模型      默认 xiaomi-mimo/mimo-v2.6-flash   xiaomi-mimo/mimo-v2.6-flash
media   视觉/带图模型    默认 deepseek-account/deepseek-flash  deepseek-account/deepseek-flash
group   群聊模型        modelByKind（群聊）   workbuddy2api/deepseek-v4-pro
private 私聊模型        modelByKind（私聊）   未设置
override 临时覆盖       仅本次运行，重启失效   未设置
只读区：何时生效：下一轮（无需重启）｜当前覆盖：无｜降级链（dsh.modelFallbacks）：deepseek-official/deepseek-pro
成功：已切换 → xiaomi-mimo/mimo-v2.6-pro（已落盘）
失败：失败：模型 x/y 不在可用清单里（fixture 注入）
清除：已清除 → 恢复默认
```

### 未做

- 后端 `GET /api/models` 目前还没有 `scopes` 字段（A 的 msg-a56 未落地），所以真实页面此刻是**只读**并注明「六 scope 接口未就绪」；接口上线即自动可切。
- 后端 `POST /api/model` 当前只改 `cfg.dsh`（main），且没有 `DELETE`；前端已按契约写好，等 A 落地。

## 批次三十三（三十一批）：高峰期与模型合并成一块（空闲/高峰/降级/禁用全可控）

用户原话：「把高峰期暂停群聊和模型切换这两个板块并在一起，直接在面板上决定高峰期用哪个模型，空闲期用哪个模型（可以选择禁用项），然后再决定如果当前选择的模型不可用，应该降级用哪个。」原先「高峰期暂停」+「高峰期本地模型」+「模型切换六 scope」三块卡片合成 **一块 `#routing-card`「高峰期与模型」**。

| 区块 | 内容 |
|---|---|
| 高峰期开关 | `启用高峰期` 复选框（→ `peakPauseEnabled`）+ 只读窗口「09:00–12:00、14:00–18:00（当前在时段内）」/「暂停生效中」 |
| 空闲期模型 | 下拉（`options`，显示 `label（provider/model）`）+ 当前值 |
| 高峰期模型 | 下拉 + 当前值（`xiaomi-mimo/mimo-v2.6-flash` 等） |
| 降级候选（有序，最多 5 个） | 每项下拉 + ↑ / ↓ / ✕；「添加降级候选」 |
| 禁用项 | 每项下拉 + ✕；「添加禁用项」 |
| 底部 | `当前实际使用：provider/model（来源：高峰/空闲/视觉/降级/默认）` + 「保存」+ 行内结果 + 未保存提示 |
| 只读统计 | 近 1 小时回复数、平均耗时、最后一条（来自 `/api/status.peakLocal`，拿不到就隐藏） |

交互与容错：
- 所有改动先落 `routingDraft`（页面会显示「有未保存修改」），点「保存」一次性 `POST /api/model-routing {idle, peak, fallback[], disabled[], peakPauseEnabled}`；成功「已保存（下一轮生效）」；失败显示后端 `error` 原文（`保存失败：…`）。
- `options` 为空 → 下拉/保存禁用 + 「DSH 清单不可用，可稍后刷新」。
- `GET /api/model-routing` 404/500/坏 JSON/超时 → 整卡 `读取失败：GET /api/model-routing HTTP 500`（`#routing-body` 隐藏，不显示半套），其余面板不受影响。
- 防连点：`opsBusy` + 1 秒占用窗口。轮询 30 秒刷新，**但本地有未保存修改时不覆盖草稿**。
- 删除旧的 `/api/models` 单下拉与六 scope 卡片；「高级：临时覆盖」未保留（后端 routing 已含禁用/降级能力）。

### 测试

- `test-console-static` → **555 项**（`model-routing` 两个方法、四区块 id、无需重启、当前实际使用、`fallback` 上限 5、失败原文、清单不可用提示、`opsBusy`+1s、**不再调用 `/api/models`**、旧只读高峰块已移除）
- `test-console-failpaths` → **181 项**（routing GET 404/500/坏 JSON/超时 → 整卡隐藏 + 文案；正常加载 fallback/disabled 各 1 条 + 来源「高峰」；POST 400 → 「保存失败：…不能为空」；保存成功 → 「已保存（下一轮生效）」；`options` 空 → 下拉禁用）
- fixture：`GET/POST /api/model-routing`（带 peakPause/routing/effective/options）、`/__fixture/routing` 控制口（`postFail` / `emptyOptions`）

### 卡片文本样例（fixture）

```
窗口：09:00–12:00、14:00–18:00（当前在时段内）
空闲：deepseek-account/deepseek-flash ｜ 高峰：xiaomi-mimo/mimo-v2.6-flash
降级候选：workbuddy2api/deepseek-v4-pro
禁用项：workbuddy2api/glm-5.3
当前实际使用：xiaomi-mimo/mimo-v2.6-flash（来源：高峰）
保存：已保存（下一轮生效）
失败：保存失败：provider 与 model 都不能为空（fixture 注入）
```

### 未做 / 后端现状

- `/api/model-routing` 还没上线（A 的 msg-a57），真实页面此刻整卡显示「读取失败：GET /api/model-routing HTTP 404」；接口落地后无需改前端。
- 旧「立即暂停群聊」按钮随合并卡片删除，暂停改由「启用高峰期」+ 保存控制；`/api/peak/status` 仍被 `/api/model-routing` 的响应覆盖（窗口/是否在时段内）。

## 批次三十四（三十批补）：表情库重复的根因、修复与线上清理

用户反馈「表情包库里又出现重复的表情包」。先实测 `state/stickers.json`（只读统计）：

```
条数 164 ｜ md5 重复 0 组 ｜ emojiId 重复 0 组 ｜ url 重复 1 组（93 条共用 multimedia.nt.qq.com.cn/download 路径，属正常）
dhash 重复 1 组（2 条）｜ 缺 md5 0 条 ｜ thumbStatus=missing 0 条
缓存目录：179 个 .img，按内容 MD5 无重复（说明磁盘上没有重复图片，重复只发生在台账层）
```

重复组明细（唯一的真重复）：

```
dhash 589c96589c98e0e0 ×2
  100000007_…_18502EFD5D28C35D2A3091E6F4E763B0_0_0   md5 18502EFD…  localNote「一般用在围观、旁观」
  100000007_…_2E997EFEB6AB15A6B46F518C6C1DCA60_0_0   md5 2E997EFE…  无备注
```

### 根因（4 个口子，按影响排序）

1. **同一张图两次采集 md5 不同**（CDN 重编码/尺寸变体）→ md5 去重天然失效，只有 `dhash` 能认出是同一张图；
2. **url 键没剥 query**：QQ 图片链接带会过期的签名参数，同一张图两次采集 URL 不同；md5 还没回填时（先收图、后算 md5）就会被当成两条；
3. **`emojiId` 没被归一化**：`normalizeStickerEntry` 白名单里没有它，QQ 收藏重复收藏同图（emoji_id 不同）会丢字段、只能按 id 各存一条；
4. **`saveStickerStore` 写盘前不去重**：只有 `loadStickerStore` / `mergeStickerLibrary` 去重，任何一处「load → push → save」（收藏同步、群聊收集、观察群采集、md5 回填、`/api/stickers` 写操作）都能把重复重新写回盘里，且并发两次 read-modify-write 会丢更新。

### 修复（`src/sticker-lib.js`，全部幂等）

- `dedupeStickerEntries` 键优先级改为 **md5 → emojiId → id/resId → url(去 query)**；
- 追加 **dhash 第二轮**：dhash ≥ 8 位且相同、md5 不同 → 合并（保留信息最丰富的一条，合 tags/localNote/usage/useCount）；
- `normalizeStickerEntry` 保留 `emojiId`；
- `saveStickerStore` **写盘前统一 dedupe**（所有写入口一致）；
- `mergeStickerLibrary` 先 dedupe 现有与 fetched 两份输入。

### 清理线上

```
备份：state/stickers.json.bak-dedupe-2026-10-26T09-14-13-541Z（135,709 字节）
前：164 条 → 后：163 条（合并 1 条 dhash 重复；合并后保留有备注的「围观/旁观」那条）
thumbStatus=missing：本次 0 条（当前库里没有不可恢复条目，无需特殊保护）
```

### 测试

- `scripts/test-sticker-dedupe.mjs` → **15 项全过**（原 8 项 UI 用例 + 新增 7 项 lib 用例：同 md5 合并保 cache/备注/tags、幂等、同 emojiId 合并、同 dhash 不同 md5 合并、dhash 过短不合并、`saveStickerStore` 写盘前去重、url 去 query 合并）
- `test-sticker-thumb` 20 / `test-sticker-thumbs` 20 / `test-console-static` 全过 / `test-console-failpaths` 181 → 无回退

### 怎么防止再发

1. 所有写路径最终都过 `saveStickerStore`，现在它在落盘前强制去重 —— 新入口只要走这个函数就不会写入重复；
2. 同图不同字节（重编码）由 dhash 兜底；新增采集路径请务必带上 `dhash`（`sticker-files` 里已有图可直接算）；
3. md5 回填后不必手动合并：下次 load/save 会自动折叠；
4. 定期跑 `node scripts/dedupe-stickers.mjs --file <state/stickers.json>` 看报告（带 dhash/md5/url 重复组明细），`--apply` 才会备份并写回。

## 批次三十五（三十一批补）：保存后「高峰期与模型」下拉全空——复现与真修

用户反馈：保存完模型路由后，两个下拉直接变空。用 fixture + 假 DOM 复现（`public/ops.html` 真实脚本）：

| 场景 | 复现前 | 复现后（本批修复） |
|---|---|---|
| A. 保存 POST 成功，紧接着 `GET /api/model-routing` 404 | `idle options=5`（保留）但 **`#routing-body` hidden=true → 整卡空白**，符合用户「选项栏直接空了」 | options 7/7、未禁用、`bodyHidden=false`、选中值保留、顶部黄色提示「显示的是上次成功读取的数据」 |
| B. GET 正常但 `options: []`（后端清单探测失败） | 依赖 c2e6e74 的「保留旧选项」才不空；首次加载就空清单则 select 0 项 | 不清旧选项；若从没好过，用 routing 里引用的值合成「（不在清单）」项保证可显示，且下拉仍按「清单不可用」禁用 |
| C. 正常保存 | 正常 | 正常（7/7，选中值不变） |

### 真正根因

`loadRouting()` 里只要这一次 GET 失败就把 `routingData = null`，随后 `renderRouting()` 走 `if (!routingData) { body.hidden = true; ... }` —— **保存后紧接着的那次刷新一旦失败/变慢，整块卡片被隐藏**，表现为「下拉全空」。

次因（叠加放大）：
- `options` 只在 GET 成功时赋值，GET 失败/空清单时下拉没有可选项；
- POST 响应里带的 `routing` 被忽略，保存后完全依赖下一次 GET。

### 修复（`public/ops.html`）

1. **刷新失败不再清数据**：已成功加载过就保留 `routingData` 与草稿，只显示黄色提示「读取失败：… （显示的是上次成功读取的数据）」；首次加载失败才整卡报错。
2. **POST 响应就地生效**：保存成功若返回 `routing/peakPause/effective`，直接更新 `routingData` + `routingDraft` 并立即重绘，不等 GET。
3. **清单兜底**：`options` 为空且从未拿到过清单时，用 routing 中引用的值合成「（不在清单）」项，保证 select 至少显示当前值；但用 `routingHasCatalog` 单独控制「可编辑」，清单不可用时下拉仍禁用并提示。
4. **缓存**：核对 `src/bridge.js` 的 `SECURITY_HEADERS` —— **已经有 `Cache-Control: no-store`**，`/`、`/ops`、`/library` 都走它，HTML 缓存不是本次根因（尝试加重复头后已回退，后端零改动）。

### 测试

- `test-console-failpaths` → **186 项**（新增「保存后」回归：fixture options 7 条 → 保存时把 GET 打成 404 → 断言 `select.options.length === 7`、未 disabled、`#routing-body` 不隐藏、警告文案存在、选中值保留 `idle=deepseek-account/deepseek-flash`、`peak=xiaomi-mimo/mimo-v2.6-flash`）
- `test-console-static` → 全过（无回退）
- fixture：routing options 增至 **7 条**（对齐线上）

### 保存后 DOM 证据

```
[保存后·初始]      idle options=7 peak options=7
[保存后·GET404]    idle options=7 peak options=7 disabled=false bodyHidden=false
[保存后·选中值]    idle=deepseek-account/deepseek-flash peak=xiaomi-mimo/mimo-v2.6-flash
```

## 已知未覆盖

- `test-console-ui.mjs` 需要 Playwright，本机没装（按约定不装不跑），所以以上都是 L1/L2 静态与片段级验证，**真实浏览器行为未经自动化验证**。
- 静态断言是文本级/结构级检查，不执行 DOM；`renderPreservingScroll` 的实际滚动效果、`busy()` 的真实禁用时序需要人工在浏览器里点一遍。
- **窄屏适配没有截图验证**：四个断点只保证「CSS 规则存在且方向正确」，1280/1024/768/420 下的真实观感（是否仍有个别表格/工具条重叠）需要人工拉窄窗口确认一次。
- **一键自检的失败分支没有真跑过**：正常路径依赖桥接在线（L3），失败路径（401 / 500 / 非 JSON）只在代码层保证「每项独立捕获、显示状态码与片段」，需要一次断网或改端口的人工演练。
