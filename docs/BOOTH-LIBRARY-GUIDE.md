# BOOTH 素材库使用手册

面向：把素材放进归档目录、想让系统自动认号 / 找号 / 绑定 / 下载的人。
文中阈值都标了代码位置（`文件:行`）；界面显示与代码不一致时，以界面为准。

## 1. 它能干什么

| 能力 | 你怎么用 | 结果落在哪 |
| --- | --- | --- |
| 认号 | 什么都不用做，打开「文件库」页 | 卡片显示 BOOTH 号或「未认号」 |
| 找号 | 卡片「找号」，弹窗里看排名、点「绑这个」 | `state/booth-binds.json` |
| 批量找号 | 批量栏「批量找号」/「全部重找」/「清空结果」 | `state/booth-batchfind.json` |
| 绑定 / 解绑 | 卡片「绑这个」/「解绑」 | 同上绑定表 |
| 抓封面 | 卡片「抓封面」/「换封面」 | 本地封面缓存 |
| 写说明 | 卡片「写说明」 | 素材目录下的 `素材说明.md` |
| 已购/免费下载 | 下载弹窗：保存 Cookie → 载入已购清单 → 下载 | `<fileArchive.dir>/<BOOTH号>/` |
| 认号可信度 | 不用操作，卡片自己标（verified / 候选 / 没号，见第 17 节） | 视图层，不落盘 |
| 一键认号 | 顶栏「待确认」筛选 + 卡片「就是这件」 | `state/booth-binds.json`（同手动绑定） |
| 解压压缩包 | 卡片「解压」，或下载完自动解压（第 18 节） | `<fileArchive.dir>/<号>/<解压目录>/` |
| 下载中心 | 顶栏「下载中心」：看队列、暂停/恢复、重试（第 19 节） | `state/booth-downloads.json` |
| 重复素材 | 左栏「重复素材」：四类规则分组，看多占多少体积（第 20 节） | 只读，不改盘 |
| 素材集 | 把几件素材攒成一个集子（第 21 节） | `state/library-collections.json` |
| 包内信息 | 详情抽屉「包内信息」：包里的号/标题/密码候选（第 22 节） | 只读，不写盘 |
| 只读访客 | 设置页生成访客链接，对方只读浏览 | — |

## 2. 第一次用

1. 放素材：归档目录由 `config.json` 的 `fileArchive.dir` 决定，当前是 `E:/qq-project/booth-inbox`（`config.json:622`）。
2. 目录结构：`simpleMode: true`（`config.json:633`）时按 `<群号_群名>/<7位号>/` 分（`src/file-archive/paths.js:228-233`）——一件素材一个二级目录，同号文件聚在一起；认不出号的按 `<群号_群名>/<YYYY-MM>/` 放。
3. 打开「文件库」页：顶部显示共 N 件、体积、有号/有封面的数量、散文件、台账里有但盘上没了的数量，以及扫描是否被截断。
4. 卡片上能点的按钮：找号、绑这个 / 解绑、抓封面 / 换封面、写说明、打开。批量栏：已购下载、批量找号、全部重找、运行中的「停止」、有失败项时的「重搜还没号的 N 件」、「清空结果」。

## 3. 认号的四个来源与优先级

| 优先级 | 来源 | 例子 | 依据 |
| --- | --- | --- | --- |
| 0 | 说明文本里的商品链接 | `booth.pm/ja/items/9013048` | `src/library-asset.js:37,143` |
| 1 | 文件名/目录名以号打头 | `9013048_xxx.zip` | `src/library-asset.js:39,148` |
| 2 | 上层目录名就是号 | `<群>/9013048/...` | `src/library-asset.js:40` |
| 3 | 名字里任意位置夹着号 | `【PB】xxx 9013048.zip` | `src/library-asset.js:41,158` |
| 4 | 压缩包内前三层 readme 里写的 | readme 中提到 `items/9013048` | `src/library-asset.js:42,161` |

- 只认 **5~8 位纯数字**，`20261027`、`202610` 这类日期/年月不认（`src/library-asset.js:105-118`）。
- 高优先级来源压过低优先级：同一个号在链接里出现，就不会再按「目录名」记一遍。
- 卡片显示「未认号」= 所有来源都没找到号；补号的办法：改名/加说明文件后重扫，或直接「绑这个」。

## 4. 找号怎么工作

- 搜索词：由标题、主文件名、目录名生成，最多 4 个，实际只用前 **2** 个（`src/booth-search.js:225`、`src/bridge/console/library-find.js:528`）。
- 搜索限速：每个词至少间隔 **900ms**（`src/bridge/console/library-find.js:18`）；单次搜索 12 秒超时、结果页最大 3MB（同文件 `:15-16`）。
- 评分权重：标题 **55%** / 封面 **30%** / 店铺 **15%**（`src/booth-search.js:229-231`）。
- 没有本地封面时无法比对封面指纹，按 **85 / 0 / 15** 归一化（`src/booth-search.js:251-253`），即无封面时总分天花板 = **0.85 × 标题分**。
- 封面指纹：dhash，汉明距离 ≤ 10 才算同一张图（`src/booth-search.js:21`）。
- 自动勾选按三条优先级判定（`src/booth-search.js:287-306`）：
  1. 前两名总分差 **< 0.05** → 一律人工确认（绑错号的代价比多点一下大）；
  2. 封面指纹命中，且标题相关 **≥ 20%** 或指纹距 **≤ 4** → 直接自动勾选（指纹是最强证据）；
  3. 否则按总分：有封面 **≥ 0.62**（`src/booth-search.js:23`）、无封面 **≥ 0.82**（同文件 `:24`）才自动。
- 无封面时的 0.82 = 需要标题分 ≥ 0.82 ÷ 0.85 ≈ **96.5%**，标题必须几乎一模一样才过得去。这就是「没有封面的素材很难自动勾选」的原因，**先抓封面再找号**会好很多。
- 候选数量：粗排最多 6 个，其中前 4 个抓远程封面后重排（`src/library-find.js:5`、`src/bridge/console/library-find.js:17`）。
- 结果缓存 10 分钟；页面素材列表缓存 20 秒，卡片上的「建议 #号 · 分数」就是缓存里算出来的。

## 5. 批量找号

- 进度落盘到 `state/booth-batchfind.json`（`src/library-batch.js:5-9`），桥接重启后还能接着看。
- 单次最多 **60** 件（接口上限 200，`src/bridge/console/library-find.js:272`）；运行中可停，失败的项不会记成「已找到」。
- 失败后再怎么继续，分两种情况（`src/library-batch.js:90-97`）：**限流 / 超时**这类「根本没搜成」的失败，下一轮批量会自动再试；**没候选 / 没短语**这类「搜过但没有」的，要手动点批量栏的「全部重找」或「重搜还没号的 N 件」。
- 已经有号的卡片默认跳过，除非「全部重找」（强制）或识别规则版本升级（`BATCH_RULES_VERSION`，`src/library-batch.js:12`）——规则一升级，旧结果自动作废重跑。
- 每件要搜 2 个词再抓封面，按 900ms 限速算，100 件大约几分钟，属于正常。

## 6. 绑定表

- 表在 `state/booth-binds.json`；每条记录带 `source: manual`。
- 手动绑定**优先于**自动认出的号（`src/library-binds.js:67-84`，自动号存在 `autoBoothId` 里，见 `:80`）；点「解绑」后卡片回退到自动号（没有就回到「未认号」）。
- 绑定成功会在后台异步补 BOOTH 资料和本地封面（`src/bridge/console/library-find.js:185-187`），所以刚绑完卡片可能还是旧图，几秒后刷新即可。

## 7. 已购 / 免费下载

- Cookie 只存本机 `state/booth-cookies.json`，权限 0600、原子写（`src/bridge/console/library-download.js:82,96-98`）；页面只显示尾 4 位（`src/booth-download.js:104`）；不进日志、不进 `state/` 的定时备份（备份白名单不含它，`src/bridge/state-backup.js:32-54`）。
- 步骤（旧方式，仍然可用）：下载弹窗粘贴 Cookie → 「保存 Cookie」→「载入已购清单」（最多 20 页；页码由 BOOTH 决定，我们只发 `?page=N`，`src/booth-download.js:132`）→ 勾选后「下载」。**更省事的方式是点「登录 BOOTH 自动同步」**（第 16 节）：弹一个独立浏览器窗口，你登录完 Cookie 自动写入，不用再手动复制字符串。
- 断点续传：磁盘上已有 `.part` 且已收字节记录匹配时，从断点发 Range 续传（`src/booth-download.js:149-161`）；服务器回 416 则从头重下（同文件 `:164-175`）。
- 重试：每次请求最多 3 次，退避 600ms × 次数（`src/booth-download.js:146-147`）；45 秒没有任何字节判卡住（同文件 `:146`），请求本身还有 90 秒硬超时（`src/bridge/console/library-download.js:144`）。
- 落盘：`<fileArchive.dir>/<BOOTH号>/<文件名>`，先写 `.part` 再改名（≤3GB，`src/bridge/console/library-download.js:11`）。
- 状态：排队 / 下载中 / 完成 / 失败；前端每 1.5 秒轮询 `GET /api/library/download/status`（`src/bridge/console/library-download.js:401`，轮询间隔见 `client/03-sessions.js:2414`）。失败的单子在弹窗里点「重试」会调 `POST /api/library/download/retry`（同文件 `:382`）。
- 服务重启后「下载中」的单子会丢——任务表只在内存（`src/bridge/console/library-download.js:127`），但已下载的字节还在，重新下载会续传。

## 8. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 卡片没有缩略图 | 本地没封面，也没抓过 | 点「抓封面」；「绑这个」后也会自动补 |
| 找号分数低 / 没候选 | 标题太怪、文件名无号、无封面指纹 | 先「写说明」补标题或「抓封面」，再找号；实在不行人工「绑这个」 |
| 找号变成「暂停」 | BOOTH 回 429 会暂停 10 分钟；403 暂停 30 分钟（`src/booth-pause.js:12-15`，上限 6 小时；商品页与封面抓取共用这份暂停） | 等倒计时；或在管理端 `POST /api/library/search-pause` 提前解除 |
| 批量很久没动静 | 每件 2 个词 + 抓封面 + 900ms 限速 | 正常，可停；下次接着跑 |
| 重启后下载「中断」 | 任务表在内存里，重启即丢 | 重新点下载，自动续传 |
| Cookie 过期 | 页面登出/换号 | 点「登录 BOOTH 自动同步」重新登一次（推荐，第 16 节）；或重新复制 Cookie 保存 |
| 封面预览打不开 | 单张封面 > 12MB 被拒（`src/bridge/console/library-view.js:231`） | 换封面或重新抓 |
| 打开图片/详情提示「路径不存在」或「读取失败」 | 文件被移走/删了，或读盘权限不够（`ENOENT`/`EACCES`） | 先确认文件还在档案目录里。**访客端只会看到「路径不存在 / 读取失败」**；管理员端会带**相对**路径与错误码（如 `路径不存在：sub/a.jpg`、`EACCES：…`），接口绝不回本机绝对路径（`src/library-fs-error.js:1-44`、`src/bridge/console/file-library.js:12-29`、`src/bridge/console/library-view.js:652-656`） |

## 9. 定期体检（`library-audit.mjs`）

素材库是慢慢长出来的，隔一阵跑一次只读体检，能提前发现「认错号 / 没封面 / 台账和盘面对不上」。

- 跑法：`node scripts/library-audit.mjs`；`--json` 只输出一个 JSON（人话摘要走 stderr，方便脚本接）；`--limit 200` 只分析前 N 件（默认 500，接口上限也是 500）。
- 它做什么：读 `state/console-token`，调本机桥接的 `GET /api/library/assets`，只读——不发写请求、不动素材文件。桥接没跑 / 令牌是旧的会直接打印人话并 `exit 1`，不会抛堆栈。
- 字段含义：
  - `count` / `total`：返回件数 / 库内总件数（截断时两者不同）；`truncated` 标出是否截断。
  - `withBooth` / `noBooth`：认没认出 BOOTH 号；`withCover`（本地缩略图或 BOOTH 封面任一）/ `noCover`。
  - `bound`：手动绑定数；`suggested`：批量找号给出「建议」但还没点绑定的件数。
  - `missingOnDisk`：台账里有、归档目录里找不到的文件（被移走/改名了）。
  - `duplicateBoothIds`：同一个号被多件素材共用，列 id + 各件的 key/title/体积。
  - `totalBytes` 与 `largest`（最大 5 件）；`byDir` 按一级目录给件数/体积/占比，用来发现 `2026-10` 这种混装目录。
- 看到这些数字该怎么处理：
  - **无号** → 卡片「找号」或批量栏「批量找号」；先「写说明」补标题，命中率更高。
  - **无封面** → 先「抓封面」或「绑这个」——绑一次会顺带补 BOOTH 资料和本地封面，之后自动勾选才可能过线。
  - **重复号** → 人工看是不是误认（同名不同版本、或文件名里带了别人的号）；确认误认就「解绑」再手动绑。
  - **missingOnDisk** → 文件被移走/改名了；确认已移走就清掉台账对应条目，别让「有号但没文件」一直挂着。
  - **byDir 里混装目录占比高** → 说明还没整理，新下载/新转存会继续堆在那，建议尽快按号归位。

## 10. 已购库同步（把 BOOTH 清单拉进来）

- 它解决什么：不用再一件件「载入已购清单」，直接按页抓 `https://accounts.booth.pm/library`，把买过的商品写进 `state/booth-purchases.json`，已购页和对账都基于它。
- 前提：先有可用 Cookie——推荐点「**登录 BOOTH 自动同步**」（见第 16 节，弹窗口登一次就行）；也可以在下载面板贴 Cookie（旧方式，见第 7 节）。Cookie 失效（登录页 / 401）会明确告诉你要重新登录/重贴，不会静默当「没有已购」。
- 接口：`POST /api/library/purchases/sync`，请求体 `{ dryRun?, maxPages? }`；`GET /api/library/purchases/sync/status` 看上次同步时间与结果（没同步过 `lastSyncAt: 0`）（`src/bridge/console/library-purchases-sync.js:18-19`）。台账与同步结果分别落在 `state/booth-purchases.json`、`state/booth-purchases-sync.json`（同文件 `:31-32`），这两个文件都在 state 备份白名单里。
- 真实清单地址就是 `accounts.booth.pm/library`（`src/bridge/console/library-purchases-sync.js:24`）；旧写法 `/ja/library` 已经 404，别再照着老教程拼。
- 节奏：`maxPages` 默认 20、上限 50（`src/bridge/console/library-purchases-sync.js:34-35`）；每页之间至少 900ms（同文件 `:29`），所以一次同步慢是正常的，别连点。
- `dryRun: true` 只在内存里算「会变几件」，一个字节都不写盘（同文件 `:326-327`、`:402`）；字段是幂等 upsert，只补空字段，**不会覆盖你人工改过的标题/店铺**（同文件 `:348`）。
- 错误怎么读：
  - 缺 Cookie → **400**，`needCookie: true`（`:380-390`）；
  - 命中登录页 / 401 → **401**，`needCookie: true`，返回里带已抓到的页数（`:411-419`）；
  - 被 BOOTH 限速（429/403）→ **200 `ok:true`**，`stopped: 'rate_limited'`，已抓到的部分保留并返回（`:417`），过一阵再点一次即可；
  - 其它停止原因：`max_pages`（到页数上限）、`no_items`（这一页没解析出商品，可能是页面改版）、`error`。
- 计数是分项的：`added / updated / unchanged / failed`，失败条目进 `errors[]`，不会一条失败整批回滚（`:407-432`）。报告里看分项，不要只看「成功/失败」。

## 11. 打开商品页（`POST /api/open-url`）

- 用途：控制台里点封面/标题，让**系统默认浏览器**打开 BOOTH 商品页（桌面壳和浏览器控制台都适用），不用自己复制链接。
- 只放行 `https://` + `booth.pm` / `booth.pximg.net` 及其子域（`src/bridge/console/open-url.js:16`）。`http://`、`127.0.0.1`、`booth.pm.evil.com`、`evil-booth.pm` 这类一律 **400**，不会把本机暴露给任意链接（校验在 `src/bridge/console/open-url.js:56-75`，host 判断在 `:23-31`）。
- 端口只允许默认端口（不写端口或 `:443`，`:8443` 这类一律 **400**）；host 末尾带点（`booth.pm.`）会被归一到同一域名，属允许行为（DNS 等价，回显与日志里都归一成 `booth.pm`）。
- 智能体（带 agent 头）调这个接口 → **403**：这是管理端操作，不给模型开（`:99-101`）。
- 链接最长 1000 字符（`:14`）；日志写到 `state/open-url.log`（`:17`），只记时间 + host + 脱敏后的路径，查询串里 token/session/sig 一类参数会打码（写日志在 `:44-54`，脱敏规则在 `:19`）。
- 入口：素材详情抽屉里的「商品页」（`client/07f-library-purchases.js:36`）；后端不可用时前端降级为复制链接（同文件 `:50`）。

## 12. 对账与补下（已购 ⇄ 素材库）

- 只读对账：`GET /api/library/reconcile`，一个字节都不写；加 `?deep=1` 会多给分组展示字段和可执行 `actions`（`src/bridge/console/library-reconcile-routes.js:8-9`）。
- `actions` 四类，按件给：`bind`（能绑号）/ `download`（买了但库里有缺，可补下）/ `forget`（从已购清单删掉）/ `review`（待人工确认，默认不勾）（`src/library-reconcile.js:165/178/191/212`）。
- 写接口（管理端）：`POST /api/library/reconcile/sync`（`{dryRun, decisions?}`）、`/reconcile/bind`（`{boothId, keys?}`，别名 `/api/library/purchases/bind`）、`/reconcile/download`（`{boothId}`）、`/reconcile/forget`（`{boothIds:[]}`）（`src/bridge/console/library-reconcile-routes.js:11-15`）。
- 界面三个入口（`client/07n-library-sync.js:31/37/39`）：
  - **「同步（N 件待处理）」**：按号把本地素材和已购清单对起来，能绑的绑、缺的补下、日期目录归位；N 是待处理件数，处理完变「已同步」；
  - **「绑定另一件（N）」**：同一个号的多件素材绑到同一件已购（含手动上传的）；
  - **「补下（N）」**：买了但素材库里没有，按 BOOTH 链接补下。
- 点按钮后会先弹确认框列出「将动手」的件，确认才执行；「待定」默认不勾（`client/07n-library-sync.js:76`）。对账视图里还会提示「缺少 N 件，去补」（`client/07l-library-reconcile.js:48`）。
- 安全边界：对账的写接口只给管理员；访客链接是只读的，点这类按钮会 403。

- **只读访客**：设置页生成的访客链接（`state/console-guest-token`）只能读：首页健康状态、素材卡与封面、文件清单与占用、单件找号结果、BOOTH 限速暂停状态，以及文件库的**单件详情（不含本机绝对路径）、封面补齐进度、合并组、工程使用统计（仅工程名）、识别规则、分类计数（facets）、收藏列表（只读）、重复素材报告、素材集（只读）、解压进度**（`/api/library/facets`、`/api/library/favorites`、`/api/library/duplicates`、`/api/library/collections`、`/api/library/extract/status`；全部在 `src/console-guest.js` 的 `GUEST_ALLOWED` 里，共 23 条）。看不到：花费账本、人设/记忆、白名单、日志、会话明细、**已购清单与对账、回收站、下载中心队列、包内信息（包里的标题/解压密码候选是私人信息）**；也不能改任何设置、绑定、下载、写说明、解压、改素材集、调用「打开商品页」或 OCR。以下这几类**对访客完全不开放（GET 也不给）**，一律 403：**手动标签/分类/备注**（`/api/library/manual-meta`，备注是私人内容）、**截图导入 OCR**（`/api/library/purchases/ocr` 是 POST 算力接口，`/ocr/status` 会泄露本机语言包）、**包内信息**（`/api/library/archive-info`）、**解压写入口与下载中心**（`/api/library/extract`、`/api/library/downloads`、`/downloads/pause|resume`）、**素材集写接口**（`/collections/update|remove|members`）、**一键认号确认**（`/bind-suggestion/accept`）、**密码本**（`/api/library/passwords`）。

## 13. 截图导入（OCR，只读预览）

BOOTH 已购页只给截图、不给清单时用这条：贴一张截图 → 认出商品号/标题 → 逐条预览，**确认无误再点「导入这件」**（真正入库仍走 `POST /api/library/purchases/import`，本接口不写台账）。

| 接口 | 干什么 | 关键约束 |
|---|---|---|
| `POST /api/library/purchases/ocr` | 识别截图，返回候选商品 | body 给 `{image: "data:image/png;base64,…"}` 或 `{path: "工作区内的图片路径"}`（`src/bridge/console/library-ocr.js:566-601`）；图片 8MB 上限（`:5`，请求体放宽到 12MB `:9`）；支持 png/jpg/webp；**垃圾 base64 直接 400**（解不出内容 `:580`，解出来不是 png/jpg/webp 的真图片 `:582-583`） |
| `GET /api/library/purchases/ocr/status` | 探活：这台机器能不能跑 OCR | 返回 `available`（能不能用）、`langs`（装了哪些语言包）、`engine`（实际用的语言标签）、`checkedAt`；缺依赖时 `available:false` + `reason:"no_deps"`（`src/bridge/console/library-ocr.js:603-622`） |

**它怎么认号**：先按行 OCR 文本抽 `boothId` / 商品页链接 / 标题，最多解析 20 个号（`src/bridge/console/library-ocr.js:12`）；再并发 **4** 路抓商品页补资料，单号 6 秒、整段 **7 秒** 预算（`:16-18`），超预算的条目留在 `errors` 里、标题仍保留截图里的版本（`enriched:false`）。OCR 单次调用 20 秒超时（`:6`）。

**返回什么**（`src/bridge/console/library-ocr.js:626-725`）：

- `items[]`：`boothId`、`title`、`shopName`、`priceText`、`itemUrl`、`coverUrl`、`coverRemote`、`ocrTitle`（截图里认出来的原标题）、`enriched`（是否抓到了商品页）、`correctedFrom`（被纠正过才有，见下）、`uncertain`（号不可靠、要人工确认，见下）。
- `hints`：`{ids, urls, titles}` —— 从截图里抽到的原始线索，方便人工核对。
- `errors[]`：`{boothId, error}`，逐条给出没补上的原因（超时/限速/抓页失败）。
- `lines[]`：最多 40 行 OCR 文本预览（`:13`），排查「为什么没认出来」用。
- 命中 BOOTH 限速暂停时额外带 `paused:true` + `error`，此时不会硬等，直接回预览结果。
- 一个号都没认出来但读到了标题时，带 `message: "没认出 BOOTH 号，先把标题填进解析框试试"`。

**「6 被认成 5」的近邻号纠正**（`src/bridge/console/library-ocr.js:19-22`、`:289-302`、`:304-346`、`:393-445`）：OCR 实测会把商品号里的 `6` 认成 `5`（真机两例：`7547699→7547599`、`9006622→9006522`）。做法是：

1. 先把 OCR 认到的号当候选；只有**商品页没抓到**，或**页面标题与截图标题对不上**，才进入纠正；截图里只读到链接、或标题本身是 OCR 噪声（归一化后 <4 字、且不足 4 个拉丁字母与 2 个假名/汉字，`:304-319`）时不作判断，只保留页面结果；
2. 按 `5`/`6` **互替、每次只改一位**生成近邻号（最多 6 个，`:289-302`），逐个抓页面；
3. 标题比对用**归一化相似度**：全角转半角、去装饰/空白/大小写，并把易认错的字符互认（`0/o`、`1/l`、`3/e`、`5/s`、`8/b`），只留字母数字/假名/汉字；归一化后**一方包含另一方**，或**最长公共子串 ≥ 短标题的 60%** 才算同一件（`:304-346`）——不再用「前 6 字相同」（日文标题前几个字常是符号/系列名，只比前缀会误纠正）；
4. 采纳后 `boothId` 换成新号、响应带 `correctedFrom: <原号>`，旧号不再出现在预览里；
5. 单个近邻号校验 **3 秒**、整段纠正 **6 秒**封顶（`:20-22`）；抓页限速暂停时直接跳过纠正。

**什么时候标 `uncertain`（前端要二次确认）**：纠正没成功、且满足任一条才标——① 某个近邻号**真是商品**（说明 OCR 可能认错了数字）；② 校验时**出错没结论**（非 404 的失败/超时）。近邻号全是 404 说明号本身没歧义，不打扰用户（`src/bridge/console/library-ocr.js:434-443`）。另外 `enriched:false`（没抓到商品页）的行，前端在导入前也会再确认一次（`client/07f-library-purchases.js:293-300`、`:423` 的 `data-guess`）。

**依赖**：不用装 tesseract，走系统自带的 Windows OCR（WinRT `Windows.Media.Ocr`），脚本是 `scripts/lib/ocr-image.ps1`（**UTF-8 带 BOM**：PS5.1 不认无 BOM 的中文，`:11` 显式把输出设成 UTF-8，否则 `ConvertTo-Json` 出 ANSI、Node 侧 `JSON.parse` 直接失败）。引擎顺序 **ja → ja-JP → 用户配置语言 → en-US**（`scripts/lib/ocr-image.ps1:60-78`）；都建不起来就报「这台机器没有可用的 OCR 语言包」（`src/bridge/console/library-ocr.js:271-290`）。想要中文识别效果，在 Windows「设置 → 时间和语言 → 语言」里装 **en-US / zh-Hans-CN / ja-JP** 任一语言包的 OCR 组件（系统自带，不需要联网商店 app）。

**排障**：

| 现象 | 原因 | 处理 |
|---|---|---|
| 按钮点了没反应/提示「截图识别没接上」 | 运行环境没注入 `runPowerShell`/`Buffer`（接线问题，不是缺语言包） | 重启桥接；`GET /api/library/purchases/ocr/status` 看 `reason:"no_deps"` |
| 「这台机器没有可用的 OCR 语言包」 | 系统没装 OCR 语言组件 | Windows 设置里装任一中/英/日语言包（含 OCR 组件），再探活 |
| 12 秒以上还没结果 / 「识别太久了（超过 60 秒）」 | 截图太大或页面被限速 | 裁掉外框、只截商品列表部分；前端对**长边 ≤1600 的 PNG/JPEG 直传原图**（canvas 重编码会掉 OCR 精度），只有超长边或 webp 才缩到长边 1600 / JPEG 0.95（`client/07f-library-purchases.js:338`、`:347-370`） |
| 认出的号不对 | OCR 把 6 认成 5 | 看条目有没有 `correctedFrom`；没有说明标题对不上、纠正未采纳，手动改正后导入 |
| 「图太大了，裁一下再传」 | 图片超过 8MB（HTTP 413） | 裁图或降分辨率重截 |
| 「截图格式不对（base64 解出来不是 png / jpg / webp 图片）」 | 传的不是真图片（改了扩展名/坏文件/纯 base64 文本） | 换一张真实截图；接口会按文件头校验（`src/bridge/console/library-ocr.js:582-583`） |

**边界**：只读预览——不写已购台账、不落封面、不碰 `state/booth-purchases.json`（真机验证：调用前后条数与 mtime 一致）；截图临时文件落在 `state/ocr-tmp/`（`:7`），识别完即删；访客链接**不给**这两个接口（OCR 是 POST 算力接口，status 会泄露本机语言包情况），一律 403。

## 14. 边界与风险

- **限速**：搜索 900ms/词；BOOTH 商品资料 1 秒/次（`config.json:639` `rateLimitMs: 1000`）；下载 1.2 秒/件（`src/bridge/console/library-download.js:12`）。别同时开多个下载/批量任务。
- **429 惩罚是全局的**：任何一条 BOOTH 请求（找号搜索、商品页资料、封面抓取、已购清单同步）吃到 429 就停 10 分钟、403 停 30 分钟，上限 6 小时，`Retry-After` 优先（`src/booth-pause.js:12-15`，状态文件沿用 `state/booth-search-pause.json`）；**商品页抓取与封面抓取也受同一份全局暂停约束**，暂停中接口返回 `status:'paused'`（补封面/同步接口回 409 `paused:true`），一个请求都不发。所以「没反应」先看暂停状态，别反复点按钮。
- **暂停的影响面**：暂停期间 `GET /api/library/covers` 会带 `paused/pauseText/retryAfterMs`；`POST /api/library/covers/backfill` 与 `POST /api/library/purchases/sync` 直接 409；单件「抓封面」与素材资料刷新也只是快速返回 paused。暂停文件可以手动删（等于立刻解除），或在管理端 `POST /api/library/search-pause` 解除。
- **外网依赖**：BOOTH 改版会导致解析失败，表现是「找不到候选 / 分数异常 / 已购清单为空」，此时先确认浏览器里能正常打开。
- **Cookie 安全**：只存本机、0600、不写日志、不进备份；访客链接只读，不给 Cookie。
- **封面指纹（dhash）来自扫描期缓存**：算力在后台补算（启动 8s 后第一轮、之后每 5 分钟），结果落 `state/booth-dhash-cache.json`（键 = 文件体积+mtime，LRU 5000 条）；图片只有扫描时才顺手算，**cloud 素材不下载远程图，所以不参与封面近似去重**（`src/library-dhash.js`）。
- **许可**：素材版权归原作者，按各商品页的使用条款与署名要求使用；抓取的封面仅本机预览用。

## 15. 手动标签 / 手动分类

素材库 Pro：给任意一件素材手动打标签、归到自定义分类、写备注。只写本机台账 `state/library-manual-meta.json`（原子写），**不改磁盘文件/目录名、不改 contentKey、不改 BOOTH 绑定、不改收藏**。

| 接口 | 干什么 | 关键约束 |
|---|---|---|
| `GET /api/library/manual-meta` | 带 `?key=<contentKey>` 读这一件的标签/分类/备注；不带 key 读全局统计 `{entries,tagged,categorized,noted}` | 只读；访客 403（备注是私人内容） |
| `POST /api/library/manual-meta` | 写一件：body `{key, tags?, category?, note?, clear?}` | 只收管理员；素材不存在 404；三字段全空即删条目 |

路由 `src/bridge/console/library-manual-meta.js:49-131`（agent 令牌 403 `:53-56`、访客 403 `:57-60`、素材不存在 404 `:104`）；规则 `src/library-manual-meta.js:14-19`、`:78-86`。

**限制**（`src/library-manual-meta.js:14-19`）：

- 标签：最多 **12** 个，每个 **≤20 字**（去重、去首尾空白；超过上限只留前 12 个）。
- 分类：**≤20 字**的自定义分类名。
- 备注：**≤200 字**。
- 三个字段都不给（或给空值）＝删除这条记录，不留空壳；`clear:true` 一次清掉三字段。
- 改名/撤销改名时台账跟着走，响应里带 `manualMetaMigrated`（`src/library-manual-meta.js:165-175`；调用方 `src/library-rename.js:335`、`:399`）。

**界面上能看到什么**：

- 素材卡/详情：`tagsAll`（BOOTH 解析标签 ∪ 手动标签）、`categoryFrom: "manual"`（这件用的是自定义分类）、`manualNote`（备注）。
- 顶部统计：`counts.manual`、`counts.manualTagged`（`src/bridge/console/library-view.js:531-532`）。
- 分类筛选点自定义分类时**精确优先**：先精确匹配某件已有的 `category`，再按规范映射归并（`src/library-assets-query.js:156-161`、`:122-125`）。
- 分类计数（facets）：标签计数用 `tagsAll`（同口径），手动分类那行带 `fromManual: true`（`src/library-facets.js:56-58`、`:64-73`）。

**排障**：

| 现象 | 原因 | 处理 |
|---|---|---|
| 写完标签卡片没变 | 前端没刷新（后端已写） | 刷新页面；`GET /api/library/manual-meta?key=<key>` 能看到就是写成功了 |
| POST 回 404「素材不在库里」 | `key` 不是现有素材的 contentKey | 从素材详情复制 `key`，别用 BOOTH 商品号 |
| 访客页看不到标签/备注 | 设计如此：manual-meta 两个方向都不给访客 | 用管理员令牌或本机窗口看 |
| 不带 key 的 GET 回 400「缺少 key」 | 跑的是旧桥接（stats 视图是后加的，本版已可用） | 重启桥接；新版不带 key 返回 `{ok:true, stats:{entries,tagged,categorized,noted}}` |

**边界**：访客与 agent 令牌一律 403；只写 `state/library-manual-meta.json`（该文件已列入 `state/` 备份白名单，丢了能找回）；删除素材不会顺手删台账（换回同 contentKey 的素材仍能看到原标签）；没写过的 key 用带 key 的 GET 读会回 `{ok:true, key, entry:null}`（不是 404）。

> stats 口径随本批上线（本版已可用）：不带 key 的 GET 返回 `{ok:true,stats:{entries,tagged,categorized,noted}}`，四个计数分别是在台账里有记录 / 有标签 / 有分类 / 有备注的素材件数。

## 16. 登录 BOOTH 自动同步（弹浏览器窗口登一次）

**为什么有这个**：以前只能在下前面板手动贴 Cookie 字符串（第 7 节），贴错、过期都得自己试。现在点一次按钮：桥接开一个**独立 profile 的浏览器窗口**（自动探测 Edge / Chrome，profile 目录 `state/booth-login-profile`），你在窗口里正常登录 BOOTH，桥接通过 CDP 读 `booth.pm` 域的 Cookie，先拿 `https://accounts.booth.pm/library` 验证「能进已购页」才落盘，然后前端自动跑一遍已购同步（第 10 节）。登录窗口和你日常浏览器的登录态完全隔离，不会互相影响。

| 接口（管理端） | 干什么 | 关键约束 |
|---|---|---|
| `POST /api/library/purchases/login/start` | 打开登录窗，开始等登录并抓 Cookie | 已有窗口在跑时返回当前状态，不会开第二个 |
| `GET /api/library/purchases/login/status` | 轮询进展与结果 | 只读；只给 `maskedCookieKey`（Cookie 前 8 位），不回明文 |
| `POST /api/library/purchases/login/stop` | 关掉登录窗、放弃这次登录 | 已结束再调也当成功 |

**状态机（五态）**：`launching`（起浏览器）→ `waiting`（等你登录）→ `succeeded` / `failed` / `cancelled`。全程上限 **300 秒**，超时记 `failed`；你自己把窗口关掉也记 `failed`（半登录态、没验过已购页，一律不写盘，不会把你现有 Cookie 弄坏）。成功后写 `state/booth-cookies.json`，前端看到 `succeeded` 会自动触发一次已购同步。

**安全**：

- Cookie 明文**永不**进响应、永不进日志；状态接口只回 `maskedCookieKey`（前 8 位）。
- `state/booth-cookies.json` **永不进定时备份**（凭据原文，`src/bridge/state-backup.js` 的 `STATE_BACKUP_NEVER`）。
- `state/booth-login-profile/` 是浏览器数据（含登录态），不进备份、不进安装包（`state/` 本来就被排除）；想清掉直接删这个目录。
- 访客链接对这三条接口一律 **403**（登录态是管理端操作），`GUEST_DENIED_SAMPLE` 里已列。

**局限**：

- 本机必须装了 **Edge 或 Chrome**（自动探测），都没有就 `failed` 并提示去装。
- BOOTH 要求验证码 / 两因素时，需要你在弹出来的窗口里手动过，桥接只负责等你。
- Cookie 有有效期，过期后要再点一次登录（同步报 `needCookie` 时就是该重登了）。

**排障**：

| 现象 | 原因 | 处理 |
|---|---|---|
| 提示找不到浏览器 | 没装 Edge/Chrome，或装在非标准路径 | 装一个（Edge 系统自带，坏掉的话重装）；或回退到第 7 节贴 Cookie |
| 点了按钮窗口没弹出 | 被安全软件拦进程，或已有登录窗没关 | 看状态是否停在 `launching`；关掉旧窗口再点一次，必要时点「停止」 |
| 登录了但状态是 `failed` | 已购页验证没过（半登录态、弹了二次验证、页面改版） | 状态里的 `error` 会写原因；重新点一次并在窗口里走到已购页能看到列表 |
| 登录成功但同步 429 | 和找号/补封面共用 BOOTH 全局暂停闸（第 14 节） | 等 10 分钟再点同步，别连点 |

> 后端已落地：`src/bridge/console/booth-login.js`（状态机说明 `:5-13`、profile 目录 `:17`、超时 `BLOGIN_TIMEOUT_MS = 300000` `:21`、三态路由 `GET login/status` `:323` / `POST login/stop` `:328` / `POST login/start` `:340`、`maskedCookieKey` 前 8 位 `:196`/`:296`）。重启桥接后这三个接口即生效（旧进程会 404）。

## 17. 认号可信度：verified / candidate / none（v2.2）

卡片上「这个号可不可信」现在有明确状态；标题和封面都按状态显示，不会把候选号当真。

| `boothStatus` | 含义 | 判定 | 卡片标题 | 封面 |
|---|---|---|---|---|
| `verified` | 号已核实 | 号在已购台账里，或你手动绑过（`src/library-bind-match.js:186-198`） | 台账里的商品名 | 允许 BOOTH 远程封面 |
| `candidate` | 只是候选 | 有 `bindSuggestions`（号/标题相似）但没核实（`:186-198`） | `? ` + 候选标题（`displayTitleOf` `:203-217`） | 只显示本地缩略图 |
| `none` | 没号 | 认号来源全空（第 3 节） | 洗过的文件名 | 本地缩略图 |

- 视图层给每张卡补状态：`annotateBindStatus`（`src/bridge/console/library-bind-view.js:66-88`），`verifiedIds` 来自台账 + 绑定表，非 verified 的卡最多带 2 条候选（`:88`）。
- **封面只对 verified 生效**：未核实的号不抓远程商品图（`src/bridge/console/library-cover.js:144`、`:156`、`:258`），避免把别人的图挂到你的素材上。
- `counts` 各项口径（`GET /api/library/assets` 的 `counts`，`src/bridge/console/library-view.js`）：`withBooth` 只算 verified（`:584`）；`bindStats:{verified,candidate,none}` 按摘掉解压产物后的最终卡算（`:348`、`:590`）；`duplicated` 是**属于重复组的卡片数**、`duplicateGroups` 是组数（`:598`）；`extracted` 是解压产物件数（`:599`，这些卡默认不进列表，见第 18 节）。

### 一键认号

| 接口 | 干什么 | 约束 |
|---|---|---|
| `GET /api/library/bind-suggestions?limit=&minScore=` | 列出所有候选（按分数倒序；`minScore` 默认 `BIND_MIN_SCORE`） | 只读；agent 令牌 403（`src/bridge/console/library-bind-view.js:159-162`） |
| `POST /api/library/bind-suggestion/accept` | 采纳一条候选，body `{key, boothId}`，写进现有绑定表（等同手动绑定） | 只收管理员；访客 403（`:207`） |

- 候选怎么来（`src/library-bind-match.js:139-162`）：① 素材里自带的号正好在已购台账 → 分数 **1.0**、`source:'id'`；② 否则按标题相似度算分排序。只有非 verified 的卡才有候选。
- 接线：`src/bridge/console/library-view.js:502`（路由）→ `handleBindSuggestionRoutes`（`src/bridge/console/library-bind-view.js:149-183`）；采纳后卡片立刻变 verified，并按第 6 节异步补资料与封面。

## 18. 解压压缩包（v2.3）

下载下来的包想直接能用就解压：**永不删原 zip**、目标已存在同名文件就加 `.1`/`.2` 不覆盖、路径穿越条目直接跳过不写盘、只认压缩包内的相对路径（`src/bridge/console/library-extract.js:1-10`）。

| 接口 | 干什么 | 关键约束 |
|---|---|---|
| `POST /api/library/extract` | 解一件：body `{key}` 或 `{boothId}`，`dryRun:true` 只算不写 | 管理端；`dryRun` 只认 true/false（字符串也行，`:166`）；加密包回 200 带中文提示（`:261`、`:15`） |
| `GET /api/library/extract/status` | 看进度：`{ok, running, active, items}`，`items` 只留最近 **20** 条（`:12-14`、`:277-280`） | 只读；访客也能看 |

- 解压目标：`<fileArchive.dir>/<BOOTH号>/<包名去掉扩展名>/`；`library.extractKeepZip` 默认 **true**（解完留原 zip，`src/bridge/config-load.js:82-84`，`:447` 负责把 `config.json` 里的 `library.*` 搬进运行期）。
- 自动解压：`library.autoExtract: true` 时下载完成自动解（也兼容老字段 `fileArchive.autoExtract`，`src/bridge/console/library-download.js:301-306`）；解压结果回填下载台账的 `job.extract {state,files,bytes,error}`（`:309-320`、`:570`），失败不影响下载本身的完成状态。
- 解压产物**默认不进素材列表**：父件卡片补 `extracted:{dirRel,dirs,files,bytes,count}` 摘要，想看子目录用 `GET /api/library/assets?view=extracted`（`src/library-assets-query.js:320-359`、`src/bridge/console/library-view.js:564-566`；`extracted` 也是合法 view 名，`src/library-assets-query.js:240`）。
- 认父子的前提是**父件名字对得上子目录名**：主件是压缩包时用包名去扩展名（`6985553.zip` ↔ 目录 `6985553`）；原包被移走/备份走、父件只剩缩略图时，用封面名兜底（`6985553.thumbnail.png` → `6985553`，`src/library-assets-query.js:292-318`）——所以**主件一定是压缩包，缩略图不算**：只剩缩略图的目录认成 `kind:'image-only'`、主件留空，绝不会把缩略图当 `mainName`（`src/library-asset.js:220-252`、`:330-348`）。
- zip 能力与上限（`src/zip-extract.js:24-29`）：流式落盘（300MB~1GB 不进内存）、总解压量上限 **8GB**、条目上限 **20000**；坏条目只记 `skipped` 不影响其它条；ZIP64 不支持，AES 加密直接拒绝并提示走 7-Zip 手动解（`:275-277`）。
- 加密包现状：解压层本身支持传统 **ZipCrypto** 与密码本（`password`/`passwords`，最多试 **10** 个，`ZIP_EXTRACT_MAX_PASSWORDS`，`src/zip-extract.js:26-27`、`:280-300`），但**素材库的解压路由目前没有把密码传进去**（`src/bridge/console/library-extract.js:251`），所以现在遇到加密包只会提示 `这个压缩包有密码，控制台还没接解压密码`。密码本 `state/booth-passwords.json` 的后端还没落地——**这个文件属于凭据，已进备份黑名单（永不备份）**。

## 19. 下载中心闭环（v2.3）

| 接口 | 干什么 | 关键约束 |
|---|---|---|
| `GET /api/library/downloads` | 队列 + 汇总：`{ok,running,paused,pausedAt,boothPaused,pauseText,retryAfterMs,jobs,summary}`（`src/bridge/console/library-download.js:657-671`） | 只读；访客 403（队列是本机信息） |
| `POST /api/library/downloads/pause` | 暂停队列（已在跑的跑完，不再启新任务） | 已暂停再点 → **409**（`:676`） |
| `POST /api/library/downloads/resume` | 恢复队列 | 没暂停再点 → **409**（`:685`） |
| `POST /api/library/download/retry` | 重试失败单 | 暂停中 → 409（`:716`、`:726`） |
| `POST /api/library/download/clear`（别名 `/downloads/clear`） | 清掉已完成/失败的记录 | 管理员（`:739`） |

- `summary` 计数：`queued / downloading / done / failed / interrupted / total / needsScan / extracted / skipped`（`:276-284`）。
- `needsScan`：下载完成后盘上有新文件但还没被扫描进素材库时置位（`:86-87`）；界面提示你去点「刷新 / 扫描」，扫描侧处理后会自己清掉。
- 队列暂停与 BOOTH 全局限速是两件事：队列暂停只是不启新任务；BOOTH 429/403 的暂停闸见第 14 节（暂停中要下载会 409 `paused:true` + `retryAfterMs`）。
- 台账 `state/booth-downloads.json`（最多 50 条，`:17-18`），已列入 `state/` 备份白名单；重启后「下载中」会显示为 `interrupted`，重新下载会断点续传（第 7 节）。

## 20. 重复素材检测（v2.3）

左栏「重复素材」= 只读报告，不改盘、不删文件。四类判据（`src/library-duplicates.js:1-17`）：

| # | 判据 | 说明 |
|---|---|---|
| 1 | 同 BOOTH 号 | 不同 key 的卡共用同一个号（人工合并过的卡不算） |
| 2 | 同名同大小 | 主件体积相同、主件名（去扩展名、忽略大小写与 `_1`/`(1)` 这类复制后缀）相同 |
| 3 | 封面指纹相同 | `dhash` 非空且相同；没 dhash 的卡不参与，不拿别的字段猜 |
| 4 | 标题近似 + 体积差 < 5% | `TITLE_BYTES_TOLERANCE = 0.05`（`:13`） |

- 接口：`GET /api/library/duplicates`（`src/bridge/console/library-duplicates.js:87`，路由接线 `src/bridge/console/library-view.js:512`，访客可读）。
- 返回：`{ok, groups[], totalExtra, totalExtraBytes, summary:{groupCount,extraCount,extraBytes}}`；每组带 `reason`、`keys`、`keepKey`（建议保留的那件）、`boothId`、`bytes`、`extraBytes`、`title`、`members[{key,title,dir,bytes,hasCover,dhash}]`（`buildDuplicateReport` `:31-70`）。
- `keepKey` 怎么选：与「合并」同一套规则（`src/library-merge.js` 的 `betterCard`，本文件注释 `:7-8`）——有封面 > 非日期名的独立目录 > 体积大 > key 小。别在这里另发明规则。
- 只出建议不动盘：清理由 `planDuplicatesCleanup`（`:246-...`）产出「该进回收站的 key」，`keepKey` 永不进 trashKeys，真正删除走 `/api/library/trash`。
- 封面对比用的是**扫描期算好的 dhash 缓存** `state/booth-dhash-cache.json`（键 = 体积+mtime，LRU 5000 条；后台启动 8s 后第一轮、之后每 5 分钟补算，`src/library-scan.js:202-234`、`:252`、`src/library-dhash.js`）。这个缓存可再生，**不进备份**。`cloud`（只是台账记录、本地没文件）的卡片不参与重复检测。
- 「合并同号」动作本身走已有的合并能力（第 6 节 / 顶部工具条），本报告只负责告诉你「哪些可能是同一件、多占了多少」。

## 21. 素材集（v2.3）

把几件素材攒成一个集子（比如「这个月的素材」「某个店铺全套」），只写本机台账 `state/library-collections.json`，不动磁盘文件。

| 接口 | 干什么 | 关键约束 |
|---|---|---|
| `GET /api/library/collections` | 列全部集子（补 `count`/`missingKeys`/`coverUrl`，`src/library-collections.js:180-194`）；带 `?key=` 只回这件素材属于哪些集 | 只读；访客可读 |
| `POST /api/library/collections` | 新建：`{name, note?, coverKey?, keys?}` | 管理员 |
| `POST /api/library/collections/update` | 改：`{id, patch}` | 管理员；不存在 404 |
| `POST /api/library/collections/remove` | 删：`{id}`（只删台账，不删素材） | 管理员 |
| `POST /api/library/collections/members` | 加/减成员：`{id, add?, remove?}` | 管理员 |

- 实现：`src/bridge/console/library-collections.js`（路由常量 `:19-23`、处理器 `:105-233`；agent 403 `:108`；坏 JSON 当空表 `:54-63`）。
- 素材集里的 key 不存在的会体现在 `missingKeys`（文件被移走/删了），不影响集子本身。
- 访客只读：`GET` 放行、写四个方向全 403（`/collections/update|remove|members` 已进 `GUEST_DENIED_SAMPLE`）。

## 22. 包内信息（v2.3）

详情抽屉里「包内信息」：直接读压缩包/`.unitypackage` 里的元数据，比文件名靠猜准得多。

- 接口 `GET /api/library/archive-info?key=<contentKey>`（`src/bridge/console/library-archive-info.js:10`、`:24-98`）：`?key=` 必填（缺 400、超 200 字或带控制字符/`..` 也 400 `:44-48`）；素材不存在 404；只允许 GET。
- 返回 `{ok, key, coverSource, probed:{packageName,bytes}, info:{boothIds,itemUrls,titleCandidates,passwordCandidates,scanned,truncated}, text}`（形状说明 `:21-22`）。`scanned/truncated` 告诉你读到哪、有没有读全。
- 限制：只读不写、不自动绑定；主件不是 zip/unitypackage 时 `info:null` 只回一段说明；包超过 **256MB** 不读；读取失败回 500 + 中文原因。
- **访客不给**：`titleCandidates`/`passwordCandidates` 属于私人信息，`/api/library/archive-info` 已进 `GUEST_DENIED_SAMPLE`，访客 403。

