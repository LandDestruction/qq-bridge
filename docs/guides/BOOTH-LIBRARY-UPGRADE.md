# 把转存系统升级成「BOOTH 素材库」：现状盘点与路线

> 依据：`<本机路径>\Downloads\VRChat 素材库实现笔记.md`（Oct 26, 2026 · 前任在 NAS 上的 Go 实现记录）。
> 本文只做两件事：① 对照那份笔记盘点我们现在有什么、缺什么；② 给出分阶段路线与需要拍板的点。
> 代码位置一律写清，方便直接开工。
>
> 使用者视角的操作说明（认号/找号/批量/绑定/下载/已购同步/打开商品页/对账补下/排障）见 **[../BOOTH-LIBRARY-GUIDE.md](../BOOTH-LIBRARY-GUIDE.md)**。

## 0. 一句话结论

我们已经有的是一套**「QQ 群文件 → 分类落盘 → SQLite 台账 → 控制台查看」的转存管道**；
那份笔记描述的是一套**「以目录为准、能自己认素材、能找 BOOTH 号、能下载已购、能分权限」的素材库**。

差距不在「能不能存」，而在四件事：

1. **认不出件**：现在以台账行为单位（一个压缩包一条），笔记是以「素材」为单位（压缩包 + 同预览图 + 说明 = 一件）。
2. **认不出号**：只有「文件名开头 7 位数字」一条路；笔记有 5 条路（文件名/说明/网页链接/压缩包内 readme/日期排除）。
3. **不会自动补全**：BOOTH 只抓了能直接拿到号的商品；没有「搜索 → 候选 → 封面指纹比对 → 人工确认绑定」这条主链。
4. **不跟着素材走**：笔记把商品资料写回素材自己的「下载说明」，应用数据丢了也能从盘上读回来；我们只存在 `state/` 缓存里。

## 1. 现状盘点

### 1.1 已经有的能力

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 群文件自动转存 | 白名单群文件落到 `fileArchive.dir`，`simpleMode` 下是 `<群号_群名>/<7 位号>\|<YYYY-MM>/` | `src/file-archive/storage.js`、`paths.js:simpleArchiveDir` |
| 台账 | SQLite `state/messages.db` 的 `file_archive` 表：`rel_path / booth_id / category / sha256 / content_key / 各规则版本 / meta_rel / thumb_rel` | `src/file-archive/db.js` |
| 去重 | `contentKey`（首个压缩包名小写 + 大小）、sha256 同内容、按 contentKey 分组 | `common.js:contentKeyFor`、`db.js:findDuplicateGroups` |
| 规则版本号 | `IDENTIFY_RULES_VERSION / CATEGORY_RULES_VERSION / BOOTH_RULES_VERSION`，可检测旧行并重跑 | `common.js:RULES_VERSIONS`、`db.js:reconcileRuleVersions` |
| BOOTH 抓取 | 商品页/JSON → 标题/店铺/价格/标签/封面/分类；全局 1s 限速、成功缓存 30 天、404 缓存 7 天、失败收敛成 status | `src/booth-meta.js` |
| BOOTH 分类 | 日文分类 → 固定目录名映射，未知进「未分类」 | `src/booth-classify.js` |
| 封面缓存 | `state/booth-cache/<id>/cover.jpg`（≤512、≤200KB），`/api/files/cover/<id>` | `src/booth-cover.js` |
| 压缩包目录读取 | 只读文件名表（ZIP 中央目录优先，RAR/7z 后置），区分「加密」与「损坏」 | `src/file-archive/media.js` |
| 缩略图 | 有并发信号量、超大图不缩 | `media.js:thumbSemaphore` |
| 回收站 | 删除 = 移进隐藏目录 `<批次>/<原相对路径>`，可列出/还原/彻底删 | `src/file-archive/recycle.js` |
| 外部改动检测 | 记录各分类目录 mtime，`shouldRescan / diffDirMtimes` | `db.js:indexDirMtimes` |
| 库页面 | 按 boothId 聚合商品、封面、详情、未分类、分类移动、导出 CSV | `src/library-items.js`、`src/bridge/console/file-library.js` |
| 感知哈希 | dHash（ffmpeg 缩 9×8 灰度 → 64 位），已有同步/异步版 | `src/image-hash.js` |
| 文件夹入口 | 控制台「在电脑上的文件夹」点开资源管理器（只读列目录 + 安全校验） | `console/file-library.js:listLibraryFolders` |

### 1.2 缺的能力（按笔记的章节对齐）

| 笔记章节 | 现状 | 缺口 |
| --- | --- | --- |
| 扫描与识别 | 台账为准，一条压缩包 = 一条记录 | 没有「素材」概念：同名预览图、说明文件不归成一件事；没有叶子文件夹判定、模型名/资源种类例外、解压文件夹识别 |
| 商品号从哪来 | 只认文件名开头 7 位（`simpleBoothId`） | 5–8 位、`Booth-号`、说明文件、`booth.pm/items/号` 链接、压缩包内前三层 readme、8 位日期排除 |
| `contentKey` 稳定标识 | 有（首个压缩包名 + 大小） | 还没有「手动绑定表」用它当键 |
| 增量刷新 | 有目录 mtime 比对 | 没有「导入进行中延迟重扫」「扫描与文件操作互斥」（现有 `fileOpsMu` 只保文件操作） |
| 读压缩包 | ZIP 全量；RAR/7z 仅识别格式 | 没有真正的 RAR/7z 文件表读取（用于找说明文件与判重） |
| BOOTH 资料 | 有商品页抓取 | 没有**搜索页**解析（`item-card` 的 `data-*`）、没有全局暂停（429/403 → `pausedUntil`）、没有「写回下载说明」、没有「补预览图」 |
| 找 BOOTH 号 | 已有（**P3 已完成**，见 §3.8） | 搜索页解析、候选排序、封面 dHash 比对、批量找号、绑定表都已落地；说明文件/包内 readme 这几路仍走 P1 的识别 |
| 绑定/改名/更新提醒 | 绑定表已有（P3，见 §3.8）；改名与更新提醒仍缺 | 换绑清理、绑定后改名（含挂起 2 分钟）、版本号/30 天复查两种更新信号 |
| 已购与免费下载 | 已有（**P4 已完成**，见 §3.8） | Cookie 槽位、清单翻页、登录失效识别、断点续传、下完入库都已落地；低速换线未做 |
| 以图搜源 | 无 | Vision / Lens 浏览器组件 / GPT 三引擎，候选存设置、必须人工确认、SSRF 防护 |
| 账号权限 | 只读访客已有（**L6 已完成**，见 §3.8）；三角色仍缺 | 三角色 + 路由→权限表、CSRF 头、可见范围过滤（含成人内容） |
| 文件操作 | 有：分类移动、回收站、清理 | 没有分块上传、新建/删除分类、整件移动（预览图/说明一起走）、撤销 |
| 网络 | 直连 | 没有代理回退、没有 HTTPS/ACME |

## 2. 路线（按「投入产出」排序，不按笔记章节顺序）

### P1 素材化（1~2 天）——先把「一件」认对
- 新增纯函数模块 `src/library-asset.js`：给一组台账行（或一次目录列举），按笔记规则判「分类 / 素材」：
  - 同名配对（`A.zip` + `A.jpg`）、压缩包名多后缀（空格/下划线/连字符/括号前的基名）、`(1)` 浏览器编号、`-下载说明`；
  - 叶子文件夹含压缩包 + 预览图/说明且同名配对 < 2 组 → 一件；
  - 顶层与「单模型适配/<模型>/<资源种类>」永远是分类；
  - 解压开的 Unity 工程（`.prefab/.fbx/.mat/.meta` 或 `Texture/Prefab/Materials`）整棵算一件；
  - 空目录记 `EmptyDirs`。
- 商品号多路提取（同一个模块，纯函数）：文件名 5–8 位、`Booth-`/`booth_`、说明文件、`booth.pm/.../items/<号>`、压缩包内前三层 readme；8 位日期排除。
- 验收：`test-library-asset.mjs` 用「造目录树 + 假台账行」跑真规则；库里现有 27 个文件跑一遍，人工核对识别结果。

### P2 资料跟着素材走（1~2 天）
- 写回下载说明：把 BOOTH 资料以带日期的区块追加进素材自己的说明文件（CRLF），重写只替换自己的区块。
- 扫描时从说明里读回资料（应用数据丢了也能恢复）。
- 补预览图：无图素材用商品首图，命名 `名字 [BOOTH-02].jpg`（标记可删）。
- 全局 BOOTH 暂停：429/403 → `pausedUntil` + 原因，所有 BOOTH 任务一起等；单图 403/404 只跳过这一张。

### P3 找号主链【已完成 · 2026-10-29】——这是「好用」的分水岭

> 落地细节（入口 / 接口 / 状态文件 / 三条硬约束）见 §3.8；下面是当初的设计口径，实现与它一致。

- 搜索页解析（`item-card` + `data-product-id/price/title/shop/data-original`）、`rel=next`、「対象商品 N 件」。
- 搜索词生成（最多 4 个：精简标题 / 拆驼峰 / 带模型名 / 店铺名）。
- 候选排序（整体标题分 vs 逐词分取高、店铺命中、包含、OSA 编辑距离 ≤1–2）。
- **封面指纹**：复用 `image-hash.js:dhashFromBufferAsync`，本地图 vs 候选图汉明距离 ≤10 判同图，非正方形再算一个居中正方形哈希取较小值。
- 批量找号：`batchfind.json` 存「找过哪些 / 结果」，规则版本号 + 「全部重找」+「跳过了多少」；封面一致且标题命中 ≥60% 默认勾选，仍由人一键确认。
- 绑定表：`contentKey → boothId`（`state/booth-binds.json`），扫完覆盖自动识别结果；绑定后排队补资料/补图/写说明；换绑清理旧图与旧区块。

### P4 已购与免费下载【已完成 · 2026-10-29】

> 落地细节（入口 / 接口 / 状态文件）见 §3.8。

- Cookie 按账号隔离（单独文件、不进备份、不回传页面）、三个清单页翻页（防「页码超出返回同一页」死循环）、跳 `sign_in`/401/登录表单判失效。
- 断点续传（临时目录独立、Range + ETag/Last-Modified、416/忽略 Range/变更时从头）、有限重试、45s 无数据超时、低速换线。
- 跨域跳转自动去 Cookie（Node 的 `fetch` 默认行为要显式确认）。

### P5 权限与以图搜源（按需，不着急）
- 三角色 + 「路由 → 权限」表（未登记的写操作默认只给管理员）、CSRF 头、可见范围过滤。
- 以图搜源三引擎（Vision / 浏览器组件 / GPT），全部只产出候选，必须人工确认；SSRF 防护（只 https、解析域名拦内网、这类请求不走代理）。

## 3. 和现在这套架构的取舍

- **不需要照搬「不建数据库」**：笔记的扫描式索引是为 NAS 上 1.5 万件资源设计的；我们有 SQLite 台账，查询/分页/去重都更省事。要借的是**识别规则与稳定键**，不是存储方式。
- **扫描仍然要做**，但用途变了：不是「建索引」，而是「**对账**」——磁盘上有、台账里没有的（手工放进去的素材），和台账里有、磁盘上没的（被外面删了）。这决定库页面能不能信。
- **素材化可以完全在纯函数里做**，先不碰数据库结构；等 P1 稳定后，再把「一件 = 多行」的聚合视图接进库页面。

## 3.6 L2 素材卡（2026-10-29 完成）

库页面（文件库）多了一块「素材（按件）」，把盘上的文件按「一件素材」摊开：

- 后端 `src/library-scan.js`：走一遍转存根目录（跳过 `.thumbnails`/`desktop.ini` 等），
  按目录喂给 `library-asset.js` 认件，再与台账对账（`inLedger` / `notInLedger` / `missingOnDisk`）。
- 新接口 `GET /api/library/assets`（缓存 20 秒，`?fresh=1` 强制重扫，`?limit=` 截断返回条数）
  与 `GET /api/files/raw?rel=`（素材卡封面，只回图片、只允许档案根目录内、>12MB 拒绝）。
- 前端：`client/03-sessions.js` 的 `libraryAssetsHtml()` 画卡片（封面/标题/商品号/文件数与体积/
  在文件夹里看），头部报「共 N 件 · 体积 · 有号 · 有封面 · 散文件 · 台账有盘上没了」。
- 实测真实库：17 件 / 29 文件 / 2.21 GB，有号 12 件、有封面 11 件、散文件 1、台账有盘上没了 2。
- 单测 `scripts/test-library-scan.mjs`（真实临时目录 fixture）+ `test-client-ui` 11 条断言。

## 3.5 进度（2026-10-29）

用户已拍板：**L1=A（P1+P2）· L2=A · L3=要（P4 已购下载，Cookie 存本机）· L4=A（先免费找号）· L5=A（手动改名）· L6=B（做只读访客）**。

**P1 已完成识别内核**（`src/library-asset.js`，43 条单测 `scripts/test-library-asset.mjs`，已进 regression-all）：

- 名字归一（全角/编号/下划线）、扩展名分类、缩略图与 `.meta.json` 的归属；
- BOOTH 号五路提取：说明里的 `booth.pm/items/<号>`（最可信）→ 名字以号打头 → 目录名是号 → 名字中间夹号 → 包内前三层 readme；8 位 `YYYYMMDD` 与 6 位 `YYYYMM` 一律排除；
- 一件的判定：单包+图+说明+元数据 = 一件；一目录多包按号/名字配给最像的那件，配不上留散文件；解压开的 Unity 工程整棵算一件；空目录不产件；
- 与台账对账：一件对多行（包/预览图/说明各一行）也算对上，能分出「盘上有台账没有」与「台账有盘上没了」。

拿真实库（`E:\qq-projectooth-inbox`，27 行台账 / 13 个目录）跑一遍：**17 件 / 28 个文件 / 12 件带号 / 8 件有预览图**，对账报出 2 行「台账有、盘上没了」（真被删了），0 件「盘上有、台账没有」。

剩余 P1 尾巴：把识别结果接进库页面（L2 的素材卡视图）、明细日期目录里 `md5.jpg` 这类无名图先留散文件，等 P3 找号后再归位。

## 4. 需要拍板的点

| 编号 | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| L1 | 第一步做哪个 | A 素材化+商品号多路（P1+P2） / B 直接上找号主链（P3） / C 先做对账扫描 | **A**：识别不对，后面全部白做 |
| L2 | 库页面要不要改成「素材卡」而不是「文件行」 | A 改（一眼看一件：封面 + 名称 + 文件清单） / B 保持文件行、只加分组 | **A**，但排在 P1 之后 |
| L3 | 要不要已购下载（P4） | A 要（你提供 Cookie，本地保存） / B 先不做 | 看你需求，风险在「Cookie 存本机」 |
| L4 | 找号要不要接付费引擎 | A 只做 BOOTH 自带搜索 + 封面比对（免费） / B 加 Google Vision / C 加 GPT 联网找 | **A** 先跑通，B/C 作为可选开关 |
| L5 | 绑定后要不要自动改名 | A 手动点「改名」 / B 绑定即改名 | **A**：改名不可逆风险高，先人确认 |
| L6 | 要不要多账号/权限（P5） | A 不做（本机单人用） / B 做只读访客 | 取决于是否给别人看 |

## 5. 下一步

等你拍 L1（以及 L2~L6 里你在意的），我就按 P1 开工：先写 `src/library-asset.js` + 单测，再拿库里现有文件跑一遍人工核对。

> 2026-10-29 追记：L1~L6 均已拍板并落地（L1=A、L2=A、L3=要、L4=A、L5=A、L6=B），进度见 §3.5 / §3.6 / §3.7 / §3.8。

### 3.7 P2「资料跟着素材走」已完成（2026-10-29）

L3 = 要「资料写回素材自己的说明 / 缺封面时补一张能认出是哪件东西的展示图」，这一条已经落地：

| 能力 | 落地方式 | 说明 |
|---|---|---|
| 把 BOOTH 资料写回素材目录 | `POST /api/library/asset/note {boothId, dir}` → `素材说明.md` | 内容为标题/店铺/价格/标签/商品页/商品号/资料日期；**只替换本工具写的那段**（`<!-- booth-library:begin/end -->`），文件里用户自己写的正文一个字都不动；全篇 CRLF，记事本打开不会挤成一行 |
| 缺封面补一张 | `POST /api/library/asset/cover {boothId}` → 缓存进 `state/booth-cache/covers/`，页面走 `/api/files/cover/<id>` 显示 | 与商品页抓取共用同一套 1 秒限速 / 30 天缓存；抓不到就如实报错，不假装成功 |
| 卡片上直接看 BOOTH 资料 | `GET /api/library/assets` 每件多带 `meta`（有缓存时）与 `coverUrl` | 卡片标题优先用 BOOTH 商品名，副行显示「店铺 · 价格」，封面优先级：本地预览图 → 缓存的 BOOTH 展示图 → 「无预览」 |
| 三处代码拆分 | `src/library-notes.js`（说明文档合并，纯函数）、`src/bridge/console/library-view.js`（文件夹入口 / 素材卡 / 抓封面 / 写说明的路由）| file-library.js 从 840 行回到 544 行，回到 800 行规模闸以内；说明合并规则有单测 `scripts/test-library-notes.mjs` |

实测（真实库 17 件）：`9013048` 写说明 → `<本机路径>\booth-inbox\100000001_扣1复活牢大\9013048\素材说明.md`（498 B，CRLF，二次写 `replaced:true` 且只有一段注释块）；`9038753` 抓封面 → 70,246 字节入库并显示；`GET /api/library/assets` 变成 `withCover:2 / withMeta:1`。

## 3.8 P3 找号主链 / P4 已购与免费下载 / L6 只读访客（2026-10-29 完成）

三块的共同点：**页面只负责「看一眼、点一下」**，所有判定规则都放在纯函数里（能离线单测）；
桥接模块只做三件事——抓页面、读写状态文件、路由。

### 3.8.1 入口（都在文件库页面）

| 入口 | 位置 | 说明 |
|---|---|---|
| 「找号」按钮 | 每张素材卡底部（`public/client.js:4528`） | 按标题去 BOOTH 搜索，列出候选（封面 / 店铺 / 价格 / 订阅数）；人点「绑这个」才真的写绑定表 |
| 「批量找号」按钮 | 文件库工具栏（`public/client.js:4545`） | 后台串行把「还没认号」的素材搜一遍，进度轮询显示；可中途停（`/stop`）、可清结果（`/clear`） |
| 「已购下载」按钮 | 文件库工具栏（`public/client.js:4543`） | 贴一次 BOOTH Cookie → 列出已购/免费清单 → 断点续传到转存目录 |
| 「只读访客链接」 | 设置页（`public/client.js:7011`） | 生成 `http://127.0.0.1:3100/client?guest=<令牌>`，复制给别人后只能看素材库 |

### 3.8.2 接口清单

**P3 找号 / 绑定**（`src/bridge/console/library-find.js`；管理端专用：带 `x-agent-token` 或 `x-agent-call` 的请求一律 403）

| 接口 | 说明 |
|---|---|
| `GET /api/library/find?key=<contentKey>&fresh=1` | → `{ok,key,title,phrases[],localHash,coverChecked,candidates[],pick,auto,reason,summary,errors}`；候选按标题相似度 + 店铺 + 封面 dHash 汉明距离排序；结果缓存 10 分钟，`fresh=1` 跳过缓存 |
| `GET /api/library/binds` | → `{ok,table,summary,count}`（已绑定的号） |
| `POST /api/library/bind {key,boothId,title?}` | → `{ok,key,boothId,count,summary}`；`POST /api/library/unbind {key}` → `{ok,key,count,summary}` |
| `POST /api/library/batchfind {keys?, force?, limit?}` | 起一轮批量找号：不传 `keys` 时挑「没号/号可疑且没找过」的素材，`limit` 默认 60、上限 200；已有任务在跑 → 409 |
| `GET /api/library/batchfind` | → `{ok,running,job:{startedAt,finishedAt,total,done,lastError},progress,text}`（页面按这个轮询） |
| `POST /api/library/batchfind/stop` · `POST /api/library/batchfind/clear` | 停止当前任务 / 清空结果（已绑定的号不受影响） |

**P4 已购 / 下载**（`src/bridge/console/library-download.js`，同样只给管理端）

| 接口 | 说明 |
|---|---|
| `GET /api/library/booth-cookie` | → `{ok,...槽位摘要,downloads[]}` |
| `POST /api/library/booth-cookie {cookie,note?}` | 保存一个 Cookie 槽位（按账号隔离）；不合法的 Cookie → 400 并说明原因 |
| `POST /api/library/booth-cookie/remove {key}` · `POST /api/library/booth-cookie/current {key}` | 删除槽位 / 切换当前用哪个 |
| `GET /api/library/owned?page=&seen=` | → `{ok,page,at,ids[],hasNext,next:{stop,reason,page}}`；登录失效 → 401 `signedOut:true`；其它抓取失败 → 502 |
| `POST /api/library/download {boothId,url}` | → `{ok,queued,job}`；`boothId` 必须 5~9 位数字，`url` 取清单页里的 `/dl/` 链接；后台下载（单件 ≤3GB） |
| `GET /api/library/download/status` | → `{ok,jobs:[{boothId,state,bytes,total,name,error,startedAt}]}` |

**L6 只读访客**（路由 `src/bridge/console/guest-access.js`；规则 `src/console-guest.js`）

| 接口 | 说明 |
|---|---|
| `GET /api/console/guest` | → `{ok,token,link,scope,rulesVersion}`；令牌还没生成时 503（重启桥接会自动生成） |

访客判定是**白名单 + 默认拒绝**：只有 `GUEST_ALLOWED` 里列出的 GET（素材库、文件只读、封面/缩略图、状态、metadata）放行，
其它一律 403；写接口连 GET 也不放行。新增接口忘了登记，结果只是访客看不到，不会变成访客能改东西。

### 3.8.3 状态文件

| 文件 | 谁写 | 内容 |
|---|---|---|
| `state/booth-binds.json` | 找号/绑定（纯规则 `src/library-binds.js`） | `contentKey → {boothId,title,source,at}`；扫到后覆盖原来自动识别的结果；**进定时备份白名单** |
| `state/booth-batchfind.json` | 批量找号（`src/library-batch.js`） | 这一轮跑过哪些 key、各自结果、开始/结束时间；规则版本变了可「全部重找」；进备份白名单 |
| `state/booth-search-pause.json` | 找号（`src/bridge/console/library-find.js`） | 遇到 429/403 的全局搜索暂停时段；进备份白名单 |
| `state/booth-downloads.json` | 已购下载（`src/bridge/console/library-download.js`） | 下载队列/进度，重启后接着跑；进备份白名单 |
| `state/booth-cookies.json` | 已购下载 | 按账号隔离的 Cookie 槽位 + 当前用哪个；**`STATE_BACKUP_NEVER` 显式排除、永不进备份，页面也只看到槽位与尾号（不回传原文）** |
| `state/console-guest-token` | 启动时生成（`src/bridge/config-io.js:loadOrCreateGuestToken`） | 48 位访客令牌；想作废就删掉它，重启后自动生成新的 |

### 3.8.4 代码位置与测试

| 层 | 文件 |
|---|---|
| 纯规则（可离线测） | `src/booth-search.js`（搜索页解析 / 排序 / 封面比对）、`src/library-binds.js` + `src/library-find.js`（绑定表 / 候选裁剪）、`src/library-batch.js`（批量进度）、`src/booth-download.js`（清单解析 / 翻页 / 续传计划 / 文件名 / 登录失效）、`src/console-guest.js`（访客白名单 / 角色判定） |
| 桥接模块（vm 裸执行） | `src/bridge/console/library-find.js`、`library-download.js`、`guest-access.js` |
| 单测 | `test-booth-search` 86 项 · `test-library-find` 25 · `test-library-batch` 32 · `test-library-binds` 28 · `test-booth-download` 63 · `test-library-download` 26 · `test-console-guest` 33（全部通过，均已进 `regression-all.mjs` 的 `AI_CORE`） |

`test-console-guest` 的「真机」半边需要活桥接 + `state/console-guest-token`；桥接没起时只跑纯函数部分。

### 3.8.5 三条硬约束（加新接口 / 新规则时照这个来）

1. **桥接模块被 vm 裸执行，不能 import。** `src/bridge/console/*.js` 由 `scripts/bridge-source.mjs` 用
   `vm.runInContext` 执行，文件里出现 `import` 直接 SyntaxError（审计与回归会全挂）。要用的模块符号
   必须由 `src/bridge.js` 通过 `deps` 注入；顶部也不要出现和 `src/bridge.js` 同名的 `const/let`
   （VM 里共用一个全局词法作用域）。
2. **纯规则靠 `deps.*Pure` 注入。** 例如 `deps.boothSearchPure` / `libraryBindsPure` / `libraryFindPure` /
   `libraryBatchPure` / `boothDownloadPure` / `consoleGuestPure`。纯规则文件本身可以正常 `export`
   （`src/booth-*.js`、`src/library-*.js`、`src/console-guest.js` 不在 VM 模块列表里），单测里塞假 deps 即复现同一口径。
3. **`// @bridge-function` 标记必须顶格，路由函数必须叫 `handleConsole*` 且在 manifest 里。**
   `bridge-source.mjs` 用 `'// @bridge-function <名>:start\n'` 精确匹配——缩进一格就抽不到函数体，
   静态断言会报 `Missing function markers: <名>`；`handleConsole*` 才会被当成控制台 handler 展开；
   函数还要登记进 `src/bridge/manifest.json` 的 `functions` 与 `dependencies`
   （`test-bridge-modules` 会逐项比对，VM 里缺依赖则是 ReferenceError）。

## 6. 已知限制

1. **BOOTH 搜索只有一种 URL 形状可用**：`https://booth.pm/ja/search/<词>`（翻页 `?page=N`）。
   `/ja/search?q=<词>` 这种 query 形式全部 404 —— 所以搜索词必须编码进**路径**
   （`encodeURIComponent`），不能拼成 query 参数；`buildBoothSearchUrl()` 就是干这个的。
2. **真实清单需要用户自己的 Cookie**：已购/免费清单（`https://booth.pm/ja/library`）只有登录后才返回条目。
   本仓库测试只用 fixture HTML（`scripts/` 里的假页面），**不存任何账号数据**；
   `state/booth-cookies.json` 只在用户自己机器上、由用户自己粘贴。
3. **免费下载依赖清单页给出的 `/dl/` 链接**：下载请求必须带「清单页里解析出来的 dl 地址」；
   清单页解析不到链接时无法下载，也不会凭商品号去猜地址。

### 状态备份覆盖（`state/backups/`）

桥接启动后每 2 小时把 `state/` 下的**白名单**文件备份到 `state/backups/`（每文件留最近 24 份 + 每日首份留 14 天）。
BOOTH 这批里 `booth-binds.json`（人工认号结果，最贵）、`booth-batchfind.json`、`booth-search-pause.json`、
`booth-downloads.json` 都在白名单里；`booth-cookies.json` **永不备份**（凭据原文，备份目录会被整包拷走/上报，进了备份等于把会话抄一份到处放）。
手动恢复：`node scripts/backup-state.mjs --list` 找到目标备份，再 `cp state/backups/<源名>.<时间戳>.json state/<源名>.json` 覆盖回去（覆盖前先停写）。
覆盖清单改动时必须同步改测试 `scripts/test-state-backup-coverage.mjs`（它锁死「这 4 个进、cookies 不进」）。

下一步：P3/P4 的剩余打磨按 §6 的三条限制走（搜索形状、Cookie、dl 链接）；P5（三角色 + 以图搜源）按需再开。

## 3.9 L1–L6 收口（2026-10-30 凌晨）

拍板的六项（L1=A、L2=A、L3=要、L4=A、L5=A、L6=B）现在**全部落地**，逐项契约测试与真机证据如下。

| 项 | 落地能力 | 关键入口 | 测试证据 |
| --- | --- | --- | --- |
| L1 / P1+P2 | 素材识别内核、资料写回（`素材说明.md` 只替换本工具注释块）、补封面、批量补封面 | `src/library-asset.js`、`POST /api/library/asset/note`、`POST /api/library/asset/cover`、`GET/POST /api/library/covers[/backfill|/stop]` | `test-library-asset`、`test-library-notes`、`test-library-covers` 48/0 |
| L2 / 素材卡视图 | 一眼看一件：卡面封面、格式/大小/文件数/分类胶囊、解压码/RJ/类型标签/来源 chip、有号/无号/无封面/待确认/手动绑定筛选、搜索排序分页 | `GET /api/library/assets`（`q/filter/sort/offset/limit`、`counts`）、`client/07d`、`07i` | `test-library-scan`、`test-library-assets-filter` 113/0、`test-client-ui` 1533/0 |
| L3 / P4 已购与下载 | Cookie 槽位（本机、永不备份）、清单翻页、断点续传、台账/重试/clear、**BOOTH 已购自动同步**（`https://accounts.booth.pm/library`） | `GET/POST /api/library/download*`、`POST /api/library/purchases/sync`、`client/07f` | `test-booth-download`、`test-library-download` 70/0、`test-library-purchases`、`test-library-purchases-sync` 67/0 |
| L4 / P3 找号主链 | 搜索（`/ja/search/<词>` 路径形）、封面 dHash 比对、绑定表（导出/导入）、批量找号、**以图搜源**、手动改名（保号/撤销）、同号合并/拆分、**归位**（日期目录搬回群目录） | `GET /api/library/find`、`POST /api/library/find-by-image`、`POST /api/library/rename[/preview|/undo]`、`POST /api/library/merge[/split]`、`POST /api/library/relocate[/undo]` | `test-booth-search` 86/0、`test-library-find` 127/0、`test-library-find-by-image` 34/0、`test-library-rename` 46/0、`test-library-merge` 51/0、`test-library-relocate` 76/0 |
| L5 / 手动改名 | 只动磁盘末级目录与主件 stem、自动保号、撤销 |
| L6 / P5 只读访客 | `GUEST_ALLOWED` 18 条 GET（列表/详情/封面进度/合并组/使用统计/识别规则…），默认拒绝；**访客响应剥离本机绝对路径**（`paths`/`usage`/`root`/`dir` 一律 null 或相对路径），文件系统报错脱敏（访客只见「路径不存在 / 读取失败」） | `src/console-guest.js`、`src/library-fs-error.js` | `test-console-guest` 111/0（含 18 条白名单全量 sweep） |
| 贯穿 | 对账（已购 ⇄ 本地：matched/missing/extra + 补下/绑定/忘记）、单件详情抽屉、批量操作（批量绑号/合并/移入回收站，≤200 件逐条记账）、回收站（保留期 30 天、自动清理、存储占用/立即清理） | `GET /api/library/reconcile`、`GET /api/library/asset`、`POST /api/library/batch`、`GET/POST /api/library/trash*` | `test-library-reconcile` 34/0、`test-library-reconcile-sync` 42/0、`test-library-asset-detail` 33/33、`test-library-batch` 77/0、`test-library-trash` 88/0、`test-library-trash-storage` 71/0 |

**全局 BOOTH 限速暂停**：`src/booth-pause.js` 是唯一写入口（状态文件沿用 `state/booth-search-pause.json`）——
429 → 停 10 分钟、403 → 停 30 分钟、`Retry-After` 优先、夹取 1 分钟~6 小时；找号/以图搜源/已购解析/商品页抓取/封面抓取/批量补封面/已购同步/清单与下载**全部先查暂停，暂停中 0 请求**。
封面统计与素材页同源：`covers.total === assets.allCount`、`missing === counts.noCover`（已修掉 23/18/0 与 17/16/1 的口径差）。
门禁：`regression-all` **154/154**（跳过需活 DSH socket 的 `test-dsh-session-retire`）、`client-ui` 1533/0、`code-size` 11/0、`ui-design` 54/54、`smoke` 19/0。

### 3.9.1 还知道的限制

1. 截图导入（OCR）仍是占位：本机没有 tesseract，走「上传截图 → 你确认商品名 → 搜候选」，不假装能识别。
2. `/api/files/cover/<号>` 在访客白名单里，访客可触发一次外网抓取（已有 30 天缓存与 1 秒限速），如要更严可移出白名单。
3. 日期目录里的素材要先「归位」才能改名（改名不动日期目录）。
4. 改名后素材的 `contentKey` 会随主件文件名变化；绑定表已在改名时自动迁移，但**外部工具**按旧 key 记账的会失配。

## 3.10 工程使用统计（2026-10-31）

回答「哪些素材真的被 VRChat 工程用过、哪些从没用过」。素材卡片上会挂一枚 `工程在用 ×N` 的 chip，点开是用了它的工程列表。

**扫描根怎么填**：`config.json` 的 `fileArchive.usageRoots`（字符串数组，**沿用 fileArchive 段**，不另开新段 —— 那段是 `loadConfig` 的白名单，另开会被裁掉）。可以填素材根、也可以直接填某个工程目录；相对路径按桥接仓库根解析，最多 12 个。文件库页「工程使用」弹层里能直接编辑保存（走 `POST /api/library/usage`，落盘后热加载）。

**扫描范围**：每个根往下 **2 层**找 Unity 工程（`ProjectSettings/ProjectVersion.txt` 算工程），只扫工程里的 `Assets/**`；`Library/Temp/obj/Logs/Build/.git/node_modules/PackageCache` 等目录一律跳过。文本资产认 `.meta/.prefab/.unity/.asset/.mat/.controller/.anim/.cs`，单文件 **2MB** 以上跳过、每个工程最多 **20000** 个文件。

**匹配口径（GUID 精确优先，名字兜底）**：
- 素材侧：从 `.unitypackage`（tar.gz，条目名首段就是 32 位 GUID）里取 GUID；外层 zip 里套的 `.unitypackage` 也会拆开找。外层 zip 超过 **64MB** 时按偏移只读中央目录与目标条目（不整包进内存）；`.unitypackage` 本身压缩后 **16MB**、解开后 **96MB** 封顶；单件最多 400 个 GUID、一次扫描最多处理 400 件素材。
- 工程侧：扫 `Assets/**` 文本里出现的 32 位 hex GUID 与 `.meta` 的 `guid:`。
- 两边求交：命中的记「工程在用」并带引用次数（`refs`）；素材 GUID 拿到了但工程没用 → `unused`；**素材 GUID 拿不到 → `unknown`（绝不谎报 unused）**。一件素材的 GUID 全取不到时，整轮扫描退回名字/目录名匹配（`usageMode: 'name'`）；GUID 模式下也会**逐件名字兜底**——真库里很多素材包根本没有 `.unitypackage`（实测 36 件素材只有 8 件能拆出 GUID），拿不到 GUID 的素材在同一遍读文件里按主件名/目录名匹配，命中的标 `via: 'name'`。

**接口 / 状态**：`GET /api/library/usage`（返回 `{ok, roots, scannedAt, projects, usage, summary:{withUsage,unused,unknown}, usageMode}`，访客响应剥掉本机路径）、`POST /api/library/usage`（`{roots}` 保存）、`POST /api/library/usage/scan`（后台扫，进度落盘）、`POST /api/library/usage/stop`；状态文件 `state/library-usage.json`（老版本 `state/booth-usage.json` 仍会被读回，升级不丢上次结论），桥接重启时把 `running` 标成 `interrupted` 允许重跑。

**性能**（本机实测，`node scripts/test-library-usage.mjs` 只跑假 io）：

| 场景 | 规模 | 耗时 |
| --- | --- | --- |
| 在一个没有工程的目录里找工程 | 仓库根，深度 2 | 5.4 ms |
| 扫一个中型工程 | 3000 个文本资产 / 13.8 MB / 12 万 GUID | 385 ms |

扫描是后台任务，不挡文件库列表渲染；单工程超 120 秒会中止并记错误，下次可重跑。

**代码位置**：`src/library-usage.js`（纯函数：roots 规整 / 工程扫描 / GUID 求交 / 汇总，零 import）、`src/library-usage-guids.js`（从 `.unitypackage`/zip 抽 GUID）、`src/bridge/console/library-usage.js`（路由与状态机）、`client/07j-library-usage.js`（chip / 弹层 / 按钮）；契约测试 `scripts/test-library-usage.mjs`（82 断言）。

## 3.11 素材库增量扫描缓存（2026-10-31）

- **默认（strict 增量）**：仍然全盘走目录、逐文件 `stat`（这是发现新增/删除/原地改写的可靠手段），但「每个目录认件」按目录签名（`name|size|mtime` 排序串）复用上次结果；缓存落盘 `state/library-scan-cache.json`（原子写、可删、版本或 rules 不符整份丢弃）。响应带 `scanMode:'incremental'|'full'` 与 `scan:{ms,reused,added,changed,removed,dirsReused,dirsTotal,hitRate}`。
- **`?scan=fast`（显式开关，默认关）**：目录 `mtime` 与可见名字都没变时，**整目录跳过文件 `stat`**（合成大库 2000 文件实测 ≈3.5×：88.6ms → 25.7ms）。代价：目录 `mtime` 不变、文件被原地同尺寸覆盖（且 `mtime` 被还原）时**检测不到**。只适合「只读浏览 / 大库快速刷新」；要确认盘面事实用默认模式或 `?scan=full`。响应带 `scan.fastScan` / `scan.statSkipped` / `scan.fastDirs`，前端与日志据此区分。
- 缓存是纯加速件：删掉只会让下一次扫描变慢，不影响素材归属/封面/对账等任何结论。
