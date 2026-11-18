# 素材库 v2 整合方案（找号 / 文件库素材区 → 素材库）

> 目标（用户 2026-10-30）：把「找号」页与「文件库」里的素材板块**全部并进素材库**，一个页面完成
> 浏览 / 搜索 / 找号 / 补封面 / 合并 / 下载 / 回收站；封面能力对标参考软件（本地缓存 + 压缩包内封面
> + 已购台账直取），并补上**软件内下载**（已购库逐件下载 + 下载中心）。
> 只借鉴功能与交互，不复制第三方代码。

## 1. 导航与页面职责

| 侧栏 | 变化 |
| --- | --- |
| 素材库 | **唯一素材入口**：浏览/筛选/搜索/批量找号/补封面/合并/收藏/回收站/上传下载 |
| 找号 | **删除**（功能并入素材库：卡片「找号」+ 顶栏「按名字找号」批量面板） |
| 文件库 | 改名 **转存与存储**：只留转存条件、文件夹、清理、磁盘余量、对账入口；**删掉素材网格**（含其工具栏/批量条/找号面板） |

页面内视图（素材库左栏第一组，对应 `GET /api/library/assets?view=`）：
`all | with-booth | no-booth | with-cover | no-cover | suggested | cloud | trash | favorite`

- `cloud`（新）：已购但本地没文件的商品，卡片来自已购台账（封面直取 `coverUrl`，标题/店铺/价格齐），
  每张卡动作 = 「下载」「商品页」「移除记录」。
- `trash`：回收站条目（原回收站弹层保留，视图里也可见）。

## 2. 素材库顶部工具条（原文件库素材区的能力全搬过来）

一行放主操作：`同步 BOOTH 已购`（已有）｜`补封面`（新增「全部补齐」）｜`批量找号`＋`停止`｜
`重找还没号的`｜`合并同号`｜`识别规则`｜`导出绑定`/`导入绑定`｜`扫描工程`｜`撤销归位`｜
`按名字找号`（面板）｜`回收站`｜`刷新`。

多选（勾选卡片）后出现批量条：`已选 N 件`｜`全选本页`｜`清空`｜`绑定同号`｜`合并同号`｜
`移入回收站`｜`补封面`｜`下载`（cloud 项）。

## 3. 后端接口（本批新增/扩展）

| 接口 | 说明 |
| --- | --- |
| `GET /api/library/assets?view=cloud` | 已购未入库条目（字段同 assets 卡：key=`purchase:<boothId>`、title、shopName、priceText、coverUrl、itemUrl、boothId、source='purchase'、downloaded=false） |
| `GET /api/library/assets?view=...` | 其余视图用现有 filter 语义实现，前端不再本地过滤 |
| `GET /api/library/cover?key=` | 封面解析：本地 thumbRel → 已购台账 coverUrl → `state/booth-cache/<id>.jpg` → BOOTH 抓取；302/直出二进制，`X-Cover-Source: local|ledger|cache|booth|unitypackage` |
| `POST /api/library/covers/backfill {mode:'missing'|'all', limit?}` | 补封面批任务：先把「有 boothId 且台账有 coverUrl」的直接落本地文件（0 网络），再抓 BOOTH，最后试压缩包内 `preview.png`；`GET /covers` 返回 running/done/failed/source 统计 |
| `POST /api/library/purchases/download {boothId}` | 单件下载入队（复用下载台账/限速/暂停闸） |
| `GET /api/library/downloads` | 下载中心聚合：`{running,jobs:[{boothId,title,state,percent,errorKind,error,from}],summary:{queued,downloading,done,failed,interrupted}}` |
| `POST /api/library/downloads/pause` / `resume` | 暂停/恢复队列（暂停=不再启新任务，运行中的跑完） |

## 4. 封面解析优先级（新）

1. `thumbRel`（本地已生成）→ 直接出；
2. 已购台账 `coverUrl`（`state/booth-purchases.json`，723 件里都有）→ 下载落 `state/booth-purchases-covers/<id>.jpg` 后出；
3. `state/booth-cache/<boothId>.json` 里的 BOOTH 元数据封面；
4. 本地压缩包/`.unitypackage` 里的 `preview.png`（zip 内直接读，不落整包）；
5. BOOTH 商品页抓 `og:image`（走现有 `booth-cover.js` 与全局暂停闸）。

「补封面」默认只做 1~3（零/低成本），4 作为兜底，5 最后且受暂停闸约束。

## 5. 附件能力（压缩包，本批先做只读）

`src/zip-read.js`：纯 JS 读 ZIP 中央目录（stored/deflate，`zlib.inflateRawSync`），
`readZipDirectory(buffer)`、`readZipEntry(buffer, name, {maxBytes})`、`readZipEntrySafe(...)`、
`findZipPreviewEntries(entries)`；不解压整包、不写盘；加密条目带
`encryption:'zipcrypto'|'aes'`（只标类型，解密在 `src/zip-crypto.js`）。
配套 `src/unitypackage-cover.js`：`findUnitypackageCover(buffer, {maxBytes})` 直接抠 `preview.png`
（其次 `thumbnail.png`/`cover.png`），`describeCoverExtraction(result)` 给中文人话。
供封面抽取与「自动解压」复用。

`src/zip-extract.js`（流式落盘解压，300MB~1GB 也不进内存）：

- `readZipDirectoryFromFile(zipPath)`：只读文件尾 64KB 找 EOCD + 按偏移读中央目录段，
  返回与 `readZipDirectory(buffer)` 完全一致的形状（同一条解析路径）；
- `extractZipToDir(zipPath, destDir, {keepZip, onProgress, maxTotalBytes, maxEntries, password, passwords})`：
  逐条 `createReadStream` → （deflate 时）`inflateRaw` → 写 `.part` 再 rename；目录条目自动建、同名加 `.1`/`.2`
  后缀不覆盖、穿越/绝对路径条目记 `skipped:{reason:'unsafe_path'}`、单条坏不影响其它条；
  累计超 `ZIP_EXTRACT_MAX_TOTAL_BYTES`（8GB）回 `{ok:false,error:'too_large'}`，
  ZIP64 回 `zip64_unsupported`、磁盘写不进回 `write_failed`。
  `keepZip:false` 时**不在这里删 zip**（交给调用方），只回 `zipKept:true`；
- 加密包（见 `src/zip-crypto.js`，传统 ZipCrypto）：
  - `password` 或 `passwords:[...]`（密码本，最多试 10 个 = `ZIP_EXTRACT_MAX_PASSWORDS`）先拿第一条加密条目验
    12 字节头（只读 12 字节），**验过才落盘**；成功后结果带 `usedPassword`（给上层存密码本）与 `triedPasswords`；
  - 参数不对/密码全错回 `{ok:false, reason:'password_required'|'bad_password', error:'中文说明'}`，一条都不写；
  - AES（method 99 / `0x9901` 扩展 / 强加密位）回 `reason:'aes_unsupported'` + 中文提示走 7-Zip；
  - 结果新增 `encryption:'none'|'zipcrypto'|'aes'`、`reason`（机器可读）、`usedPassword`、`triedPasswords`；
- `listZipPreview(zipPath, {maxEntries:200})`：解压前先看看里面有什么（`{name,size,depth,isDir}`）。

## 6. 验收口径

- 素材库一个页面能完成：筛选/搜索/找号/补封面/合并/收藏/回收站/已购下载；「找号」导航消失；
  「转存与存储」页只剩存储与转存配置。
- `view=cloud` 条数 = `reconcile.missing`（当前 718）；卡片有封面、可单件下载。
- 补封面「全部补齐」能把 `noCover` 清零或给出逐件原因；`X-Cover-Source` 可观测。
- 下载中心能显示队列/进度/失败原因，支持暂停/恢复。

## 7. v2.2 / v2.3 落地记录（2026-10-30）

> 面向开发者：这一批加进来的接口与规则，以及对外文档位置。用户视角的操作手册见
> `docs/BOOTH-LIBRARY-GUIDE.md` 第 17~22 节。

### 7.1 认号可信度 + 一键认号（v2.2）

| 项 | 落地 | 代码位置 |
|---|---|---|
| 卡片状态 `boothStatus: verified\|candidate\|none` | 视图层给每张卡算，不落盘 | `src/library-bind-match.js:186-198`；`src/bridge/console/library-bind-view.js:66-88` |
| 标题按状态显示（verified 台账名 / candidate `? 候选` / none 文件名） | `displayTitleOf` | `src/library-bind-match.js:203-217` |
| 封面 verified-only（未核实的号不抓远程图） | `coverUrl` / 抓取闸 | `src/bridge/console/library-cover.js:144`、`:156`、`:258` |
| 候选生成（号命中台账 1.0 `source:'id'`；否则标题相似度） | `suggestBindings` | `src/library-bind-match.js:139-162` |
| `GET /api/library/bind-suggestions?limit=&minScore=` | 只读列表，agent/访客 403 | `src/bridge/console/library-bind-view.js:149-183`、`:207`；接线 `src/bridge/console/library-view.js:502` |
| `POST /api/library/bind-suggestion/accept {key,boothId}` | 写现有绑定表（等同手动绑定） | 同上 |
| `counts` 口径 | `withBooth` 只算 verified；`bindStats` 按最终卡；`duplicated`=重复组卡片数；`duplicateGroups`；`extracted` | `src/bridge/console/library-view.js:348`、`:584`、`:590`、`:598-599` |

### 7.2 解压（v2.3）

- `POST /api/library/extract` `{key|boothId, dryRun?}`；`GET /api/library/extract/status`（最近 20 条）：
  `src/bridge/console/library-extract.js:12-15`、`:213-317`。
- 配置 `library.extractKeepZip` 默认 true、`library.autoExtract` 默认 false：`src/bridge/config-load.js:82-84`、`:447`；
  下载完自动解压并回填台账 `job.extract`：`src/bridge/console/library-download.js:301-320`、`:570`。
- 解压产物默认隐藏，`GET /api/library/assets?view=extracted` 才列：`src/library-assets-query.js:278-332`、`src/bridge/console/library-view.js:564-566`。
- 底层能力：`src/zip-extract.js`（流式、8GB/20000 条上限、ZipCrypto 密码本最多 10 个、AES 拒绝 7-Zip 手动解）。
- **已知缺口**：解压路由不传 `password`（`src/bridge/console/library-extract.js:251`），`state/booth-passwords.json` 密码本后端未落地；
  加密包当前只回中文提示。该文件已进备份黑名单（永不备份）。

### 7.3 下载中心闭环（v2.3）

| 接口 | 位置 |
|---|---|
| `GET /api/library/downloads`（jobs + summary + needsScan） | `src/bridge/console/library-download.js:657-671`；summary `:276-284`；needsScan `:86-87` |
| `POST /downloads/pause` / `resume`（重复操作 409） | `:676-682` / `:685-691` |
| `POST /download/retry` / `POST /download/clear` | `:716-740` / `:739-746` |
| 队列台账 `state/booth-downloads.json`（最多 50 条） | `:17-18` |

### 7.4 重复素材（v2.3）

- 判据四类（同号 / 同名同大小 / dhash 相同 / 标题近似+体积差<5%）：`src/library-duplicates.js:1-17`。
- `GET /api/library/duplicates`：`src/bridge/console/library-duplicates.js:87`（报告 `:31-70`、`duplicateCounts` `:75-80`）。
- dhash 来自扫描期缓存 `state/booth-dhash-cache.json`（可再生，不进备份）：`src/library-scan.js:202-234`、`:252`。
- 清理计划 `planDuplicatesCleanup` 只出建议、`keepKey` 永不进回收站（`:246-...`）。

### 7.5 素材集（v2.3）

- 台账 `state/library-collections.json`，接口 `GET/POST /api/library/collections`、`/update`、`/remove`、`/members`：
  `src/bridge/console/library-collections.js:19-23`、`:105-233`；装饰字段 `src/library-collections.js:180-194`。
- 该文件是用户数据 → **已进 `state/` 备份白名单**（`src/bridge/state-backup.js` 的 `STATE_BACKUP_FILES`）。

### 7.6 包内信息（v2.3）

- `GET /api/library/archive-info?key=`（boothIds / itemUrls / titleCandidates / passwordCandidates / scanned / truncated）：
  `src/bridge/console/library-archive-info.js:10`、`:24-98`；>256MB 不读、非压缩包 `info:null`。

### 7.7 访客可见性（本批裁定）

| 接口 | 访客 | 理由 |
|---|---|---|
| `GET /api/library/duplicates` | ✅ 给 | 只读报告，不含本机路径 |
| `GET /api/library/collections` | ✅ 给（只读） | 用户自己攒的集子，可视 |
| `GET /api/library/extract/status` | ✅ 给 | 只有进度与相对路径 |
| `GET /api/library/archive-info` | ❌ 不给 | 包内标题 / 解压密码候选是私人信息 |
| `POST /api/library/extract`、`/downloads`、`/downloads/pause|resume` | ❌ 403 | 写盘 / 本机队列 |
| `/collections/update|remove|members`、`/bind-suggestion/accept`、`/passwords` | ❌ 403 | 写操作 / 凭据 |
| 手动标签 `manual-meta`、OCR 两条 | ❌ 403 | 私人备注 / 算力与语言包信息 |

白名单现状：`GUEST_ALLOWED` **23** 条（`src/console-guest.js`），`GUEST_DENIED_SAMPLE` **32** 条；
断言在 `scripts/test-console-guest.mjs`（含全量兜底 sweep，扫描绝对路径泄漏）。

### 7.8 备份决策（本批）

| 文件 | 决定 | 理由 |
|---|---|---|
| `state/library-collections.json` | 进白名单（27→28 条） | 用户手工攒的数据，丢了找不回 |
| `state/booth-passwords.json` | 进 `STATE_BACKUP_NEVER` | 凭据，不能进备份包 |
| `state/booth-dhash-cache.json` | 不进 | 能从封面重算（可再生） |
| `state/library-extracts.json` | 不进 | 只是最近 20 条解压日志 |

