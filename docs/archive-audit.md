# 归档 simpleMode 只读核对与台账一致性（T4）

> 审计时间：2026-10-26 22:55（北京时间）
> 审计对象：`E:\booth-inbox`（线上归档根）、`src/file-archive.js` 的 simpleMode 规则、`state/messages.db` 的 `file_archive` 台账
> **全程只读**：只做 `readdir/stat/read` 与 `readOnly` 打开 DB 副本；没有创建、移动、重命名、删除任何归档文件，也没有写 `state/`、`config.json`。
> 台账不是直接打开线上的，而是先把 `messages.db` + `-wal` + `-shm` 复制到 `%TEMP%\w4-audit\` 再只读打开，避免碰运行中的库。

> **后续变化（2026-10-26 22:58:59）**：本文记录的是 22:55 的快照。之后 `_未分类/100000001_扣1复活牢大/` 被外部清空（12 个文件进了 Windows 回收站，sha256 与台账一致，可恢复），所以现在磁盘只剩 10 个文件 / 222.90 MB。现场、恢复办法与修复方案见 `docs/archive-repair-plan.md`；本文数字保持审计当时的口径，不再回改。

## 0. 结论摘要

| 项 | 结果 |
|---|---|
| 目录总数 | 7（一级 2、二级 5），最大深度 3 |
| 文件总数 / 体积 | 22 个 / 239.43 MB（**原件 20 个 239.05 MB** + 旁挂 2 个 0.38 MB） |
| 布局符合 `<群号_群名>/<7位号>/` 或 `_未分类/<群号_群名>/` | **20/20 原件全部符合**（布局偏差 0 条） |
| 超 `maxFileMb`（2560） | 0 条（最大单文件 213.40 MB） |
| 扩展名不在白名单 | 0 条 |
| 台账有效行 | 18 行（已删 0） |
| 台账 ↔ 磁盘 | 台账 18 行**全部存在**且 **sha256 18/18 相符**；磁盘多出 **2 个无台账文件**、**2 个无台账旁挂** |
| 悬空引用 | 台账 #6 的 `meta_rel` / `thumb_rel` 指向已不存在的旧路径（2 条） |
| 结论 | 布局与内容规则**没有偏差**；问题集中在「台账侧口径漂移」：孤儿文件、悬空 meta/thumb、`booth_id` 空列、分类词表混用、迁移脚本落点过期 |

## 1. 口径与规则来源（源码行号）

| 规则 | 实现 | 线上配置 |
|---|---|---|
| simpleMode 开关 | `normalizeFileArchiveConfig().simpleMode`（`src/file-archive.js:128`） | `true`（config.json:527） |
| 入库闸门：文件名必须以 **7 位数字开头** | `bridge.js:17044-17052` `SIMPLE_BOOTH_RE = /^\d{7}/` | — |
| 号目录：7 位号且**第 8 位不是数字** | `simpleBoothId()`（`src/file-archive.js:174-177`）`/^(\d{7})(?!\d)/` | — |
| 落点：`<群号_群名>/<7位号>/`，无号 → `<群号_群名>/<YYYY-MM>/` | `simpleArchiveDir()`（`src/file-archive.js:185-195`） | 群名缓存 `state/group-names.json` |
| 压缩包白名单 | `ARCHIVE_EXTENSIONS`（`:33`）= zip rar 7z tar gz tgz bz2 xz zst | — |
| 图片白名单 | `IMAGE_EXTENSIONS`（`:35`）= jpg jpeg png gif webp bmp heic | — |
| 单文件上限 | `MAX_FILE_MB = 2560`（`:26`），`maxFileMb` 夹在 1~2560（`:117`） | `maxFileMb: 2560` |
| 群白名单 | `isArchiveGroup()`（`:135-138`），空数组 = 谁都不存 | `groups: ["100000001"]` |
| 保留期 | 已分类 120 天 / 未分类 60 天（`:326-330`） | 60 / 120 |
| 清理 | simpleMode 下**不执行**自动清理（`bridge.js:17220-17222`） | — |
| BOOTH 抓取/分类 | simpleMode 下跳过全部后台补抓（`bridge.js:16995-16996`） | `booth.enabled: true`（被 simpleMode 短路） |

补充口径（历史迁移留下的目录，运行时不写也不读）：

- `_未分类/<群号_群名>/` 来自 `scripts/migrate-archive-simple-layout.mjs:60-62`，只被该一次性脚本使用；`src/` 里没有任何代码引用 `_未分类`。

## 2. 磁盘布局表

### 2.1 一级目录

| 目录 | 目录数（含自身） | 原件 | 体积 | 时间跨度（文件 mtime） |
|---|---|---|---|---|
| `100000001_扣1复活牢大/` | 5（含 4 个号目录） | 8 | 222.52 MB | 2026-10-25 20:54:27 ~ 2026-10-26 07:03:37 |
| `_未分类/` | 2（含 1 个群目录） | 12 | 16.53 MB | 2026-10-25 20:43:15 ~ 2026-10-25 23:05:48 |

### 2.2 明细目录（原件，不含 `meta/thumbnail` 旁挂）

| 目录 | 原件数 | 体积 | 内容 |
|---|---|---|---|
| `100000001_扣1复活牢大/8664050/` | 2 | 0.79 MB | `8664050.jpg` + `8664050_35種 Mew_Pose_Ver.3.zip` |
| `100000001_扣1复活牢大/9013048/` | 1 | 213.40 MB | `9013048.zip`（+ 旁挂 `9013048.meta.json`、`9013048.thumbnail.jpg`） |
| `100000001_扣1复活牢大/9040444/` | 2 | 0.98 MB | `9040444.jpg` + `9040444_♡期間限定無料♡…zip` |
| `100000001_扣1复活牢大/9041635/` | 3 | 7.35 MB | `9041635_1.jpg`、`9041635_2.jpg`、`9041635_【9アバター対応】…zip` |
| `_未分类/100000001_扣1复活牢大/` | 12 | 16.53 MB | 全部是 `图片-引用*.png/.jpg`（文件名无 7 位号） |

### 2.3 扩展名分布（原件）

| 扩展名 | 个数 | 体积 | 白名单 |
|---|---|---|---|
| `.zip` | 4 | 221.55 MB | ✅ ARCHIVE_EXTENSIONS |
| `.png` | 10 | 16.04 MB | ✅ IMAGE_EXTENSIONS |
| `.jpg` | 7 | 1.84 MB | ✅ IMAGE_EXTENSIONS |
| `.json`（旁挂） | 1 | 0.00 MB | 旁挂，不走白名单 |

## 3. 规则偏差清单

布局层面**没有偏差**：20 个原件里，带 7 位号的文件全部落在同名号目录（同名号 = 文件名前 7 位），无号文件（12 个 `图片-引用*`）全部在 `_未分类/<群号_群名>/`，都可由 `simpleBoothId()` 复现判定。

真正不一致的是「台账 vs 磁盘 vs 脚本口径」：

### D1（台账→磁盘）2 个文件没有台账行

| 文件 | 体积 | mtime |
|---|---|---|
| `_未分类/100000001_扣1复活牢大/图片-引用1 (1).jpg` | 0.11 MB | 2026-10-25 21:27:49 |
| `_未分类/100000001_扣1复活牢大/图片-引用1 (6).png` | 0.18 MB | 2026-10-25 21:28:03 |

- 台账里同类文件的 `stored_name` 序号是 `(1).png、(2)…(5)、(7)、(8)`，**恰好缺 `(1).jpg` 与 `(6).png`**；磁盘上这两个文件存在。
- 两个文件的时间与台账邻居的关系：`(1).jpg`（21:27:49）紧挨 #8 `(4).png`（21:06:00）之后的批次；`(6).png`（21:28:03）紧挨 #10 `(7).png`（21:56:08）**之前**约 28 分钟。两者都不与任何台账行的 `archived_at` 落在同一秒。
- 现有日志（`bridge.log` / `.log.1`）只覆盖到 10-25 17:52 之后的部分片段，**没有这两条事件的记录**，因此只能登记现象，不能断言成因（不臆造原因）。

> 更正记录（2026-10-26 23:0x，T11 期间）：本表原写 `(6).png` 的 mtime 为 21:56:08，并据此推断「与 #10 同一秒」。核对回收站里的原文件（`$R3PS996.png`，184043 B，mtime 21:28:03）后确认原记录有误，上面的数字已按实际文件更正，推断同步撤回。

### D2（台账列）`booth_id` 列空着 7 条

- 台账 12~18 号（`8664050*.zip`、`9040444*`、`9041635*`）的 `file_name` 都以 7 位号开头，`simpleBoothId()` 现算都成立，但 `booth_id` 列是空串。
- 原因（可验证）：simpleMode 跳过所有后台补抓（`bridge.js:16995-16996`），`backfillBoothColumns()` 没有在 simpleMode 下跑过；只有 #6（simpleMode 开启前补抓过）有 `booth_id=9013048`。
- 影响：`idx_file_archive_booth` 索引、`st === 'enriched' / 'pending'` 过滤、`matchImageBooth` 同号图片归属都查不到这些文件；但 `booth_id` 可以从 `file_name` 无损重算。

### D3（台账→磁盘）#6 的 `meta_rel` / `thumb_rel` 是悬空引用

```
#6 meta_rel  = 100000001\3D衣装\9013048 zip\meta.json      → 磁盘不存在
#6 thumb_rel = 100000001\3D衣装\9013048 zip\thumbnail.jpg  → 磁盘不存在
```

- 实际文件在 `100000001_扣1复活牢大/9013048/9013048.meta.json` 与 `9013048.thumbnail.jpg`，**但台账没有记录它们**（`meta_rel/thumb_rel` 仍是旧值）。
- 这是 `migrate-simple-booth-folders.mjs:125-130` 的既定行为（旧路径失效时保留原值、不抹掉），不是崩溃，但外部工具按台账取缩略图会 404。

### D4（脚本口径）`migrate-archive-simple-layout.mjs` 的落点已经过期

- 该脚本头部注释与实现（`:3`、`:60-62`）把「合规文件」搬到 `<root>/<群号_群名>/<YYYY-MM>/<文件>`；
- 但 `b44d97a` 之后运行时落点是 `<root>/<群号_群名>/<7位号>/`（`simpleArchiveDir()`），后来者 `migrate-simple-booth-folders.mjs` 才负责把年月目录折进号目录。
- 即：**今天再跑 `migrate-archive-simple-layout.mjs --apply`，合规文件会被搬回年月目录**，与运行时布局打架（对本次 12 个无号文件是幂等的，因为它们的落点本来就该是 `_未分类/`）。

### D5（命名双轨）旁挂文件名两套

| 现行运行时代码 | 磁盘实际 |
|---|---|
| `<目录>/meta.json`（`:1190`） | `9013048.meta.json` |
| `<目录>/thumbnail.<ext>`（`:1196`） | `9013048.thumbnail.jpg` |

磁盘这套 `<boothId>.meta.*` 是旧布局遗留（`migrate-simple-booth-folders.mjs:145-157` 专门处理它）。simpleMode 下不会再触发 enrich，所以现在不会出现两份；**一旦关掉 simpleMode 重跑 enrich，同一目录会多出一个 `meta.json`**。

### D6（词表）分类列混用三套词汇

| category | 行数 | category_source |
|---|---|---|
| `image` | 10 | `media`（旧代码） |
| `图片` | 4 | `rule` |
| `压缩包` | 3 | `rule` |
| `3D衣装` | 1 | `booth` |

`isClassified()` 只把 `unclassified/未分类` 当未分类，所以这 18 行**全部按 120 天**算（与审计输出一致）；但按当前规则，无号图片理应落在「未分类」语义里。simpleMode 不清理，暂时无害；**一旦关掉 simpleMode，这批旧行会按 120 天而不是 60 天保留**。

## 4. 风险

| # | 风险 | 现状证据 | 影响 |
|---|---|---|---|
| R1 | 存储高度集中在单个大包 | `9013048.zip` 213.40 MB = 总量的 89% | 该目录损坏/误删即丢 89% 内容；2.5 GB 上限下磁盘护栏要求 free > 2.5 GB + 5 GB |
| R2 | `_未分类` 是无出口的角落 | 运行时 `src/` 无任何代码引用 `_未分类`；清理在 simpleMode 下被禁用（`bridge.js:17220`） | 12 个文件 16.53 MB 既不会再被搬，也不会被清理，只能靠人工 |
| R3 | `_未分类` 还会不会长 | 该目录最后一次写入 2026-10-25 23:05:48；闸门生效后第一批号目录文件是 2026-10-26 01:19:22 | **增长已停止**（0 条新增）；残余 12 个是闸门/迁移之前的历史文件 |
| R4 | 号段误判 | 闸门是 `/^\d{7}/`（8 位日期也能进），落点用 `simpleBoothId()` 要求第 8 位非数字（`file-archive.js:166-177`） | 8 位日期文件会归档到 `<群号_群名>/<YYYY-MM>/`，不会造出 `2024010` 号目录；当前磁盘上**没有**这类文件，规则只被测试覆盖 |
| R5 | 台账孤儿文件 | D1 的 2 个文件（0.29 MB） | 无法用台账去重/清理/统计；也不会被 simpleMode 清理，永久悬空 |
| R6 | 悬空 meta/thumb 引用 | D3 的 2 条 | 外部索引/管理面板按台账取缩略图 404 |
| R7 | 迁移脚本可被误用 | D4 | 重跑 `--apply` 会把合规文件搬回年月目录，之后要再跑 `migrate-simple-booth-folders.mjs` 才能折回来 |
| R8 | 分类/保留期口径 | D6 | 关掉 simpleMode 后旧行按 120 天保留，与「未分类 60 天」的预期不一致 |

## 5. 后续建议（本次不执行）

1. **修 D4**：`migrate-archive-simple-layout.mjs` 的落点改成 `<7位号>`（或直接标注为历史一次性脚本、移到 `scripts/legacy-` 前缀并在注释里写明被 `migrate-simple-booth-folders.mjs` 取代）。改动只碰文档与脚本，不碰 `src/`。
2. **收 D2**：给 simpleMode 加一次性 `backfillBoothColumns()` 调用（或改成读侧用 `simpleBoothId(file_name)` 现算），让 `booth_id` 与文件名一致；需要写库，需主窗口批准。
3. **D3 只补引用不搬文件**：把 #6 的 `meta_rel/thumb_rel` 指向磁盘上真实存在的 `9013048.meta.json` / `9013048.thumbnail.jpg`（纯 UPDATE，无文件移动）。
4. **D1 先查再动**：对 2 个孤儿文件算 sha256 与同目录邻居比对；若与 `(5)/(7)` 重复则可去重，否则补台账行。**任何移动/删除都必须先有台账记录与用户确认**。
5. **D5**：若将来重开 enrich，先统一旁挂名（把 `<boothId>.meta.json` 规整成 `meta.json`），避免同目录两份元数据。
6. **D6**：用一条 `UPDATE ... SET category='图片' WHERE category='image'`（或读侧映射）统一词表；这与保留期口径绑定，改之前先确认 simpleMode 长期是否开启。
7. `_未分类/` 的 12 个文件建议**保持原样**等用户自己整理（simpleMode 的设计前提就是「用户自己整理」），只在文档里标注它们是历史遗留。

## 6. 每个数字怎么复现

审计器新增在 `scripts/audit-archive-simple.mjs`（只读、不写任何文件），下面每条命令都能重跑出本文的数字：

```powershell
cd <本机路径>\w4

# 1) 先把台账复制到临时目录（不碰运行中的 state/）
$tmp = Join-Path $env:TEMP 'w4-audit'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Copy-Item '<本机路径>\qq-bridge-src\state\messages.db'     $tmp -Force
Copy-Item '<本机路径>\qq-bridge-src\state\messages.db-wal' $tmp -Force
Copy-Item '<本机路径>\qq-bridge-src\state\messages.db-shm' $tmp -Force

# 2) 主审计（--sha 会重算 18 行 sha256 与台账比对，读 239 MB，约 1~2 秒）
node scripts\audit-archive-simple.mjs --root 'E:/booth-inbox' --db "$tmp\messages.db" --sha
# 机器可读版：加 --json

# 3) 目录/文件计数（与审计器互相独立，用来交叉验证）
(Get-ChildItem 'E:\booth-inbox' -Recurse -Directory -Force).Count                     # 7
(Get-ChildItem 'E:\booth-inbox' -Recurse -File -Force).Count                          # 22
(Get-ChildItem 'E:\booth-inbox' -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1MB   # 239.43

# 4) 按目录汇总（原件）
Get-ChildItem 'E:\booth-inbox' -Recurse -File -Force |
  Where-Object { $_.Name -notmatch '(\.meta\.json$|thumbnail\.)' } |
  Group-Object { $_.Directory.FullName.Replace('<本机路径>\','') } |
  ForEach-Object { '{0} | {1} 个 | {2:N2} MB' -f $_.Name, $_.Count, (($_.Group | Measure-Object Length -Sum).Sum/1MB) }
```

审计器当前输出（2026-10-26 22:55 快照）：

```
审计根：E:\booth-inbox（simpleMode=true）
一级目录 2 个：100000001_扣1复活牢大、_未分类
文件 22 个（原件 20 + 旁挂 2），合计 239.43 MB（原件 239.05 MB，旁挂 0.38 MB）
BOOTH 号目录 4 个；_未分类 12 个文件 / 16.53 MB
目录 → 原件数 / 体积：
  _未分类/100000001_扣1复活牢大 | 12 个 | 16.53 MB
  100000001_扣1复活牢大/8664050 | 2 个 | 0.79 MB
  100000001_扣1复活牢大/9013048 | 1 个 | 213.40 MB
  100000001_扣1复活牢大/9040444 | 2 个 | 0.98 MB
  100000001_扣1复活牢大/9041635 | 3 个 | 7.35 MB
台账分类分布：image×10、3D衣装×1、图片×4、压缩包×3
保留期分布：120天×18
  台账 meta_rel 悬空 #6 → 100000001/3D衣装/9013048 zip/meta.json
  台账 thumb_rel 悬空 #6 → 100000001/3D衣装/9013048 zip/thumbnail.jpg
布局偏差 0 条；超 2560MB 上限 0 条；扩展名不在白名单 0 条
台账：18 行（有效 18、已删 0）；磁盘缺文件 0 条；无台账文件 2 条；sha256 核对 18 条，不符 0 条
  无台账 _未分类/100000001_扣1复活牢大/图片-引用1 (1).jpg（0.11 MB）
  无台账 _未分类/100000001_扣1复活牢大/图片-引用1 (6).png（0.18 MB）
```

## 7. 测试结果

| 套件 | 结果 | 备注 |
|---|---|---|
| `node scripts/test-file-archive.mjs` | ✅ 18/18 | 工作树内跑，依赖 `node_modules` junction |
| `node scripts/test-chat-file-archive.mjs` | ✅ 25/25 | 工作树内跑（输出里那行 `mp4/pdf ❌` 是测试用例描述文字，不是失败） |
| `node scripts/test-simple-booth-dir.mjs` | ✅ 8/8 | 该套件要读 `config.json`，按 w1 的口径在**主仓库**只读跑（worktree 里没有 config.json）；只读+临时目录，未改任何线上数据 |

`regression-all` 归组长 w1 跑，本次不跑。
