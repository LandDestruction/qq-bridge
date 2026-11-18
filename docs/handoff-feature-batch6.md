# 交接｜施工 C 第六批：BOOTH 号识别 + 商品元数据 + 自动分类落文件夹

分支 `feat/file-archive`（已先 `git merge main`，合并提交 94fbef9，无冲突）。

## 一、文件名解析（`src/booth-meta.js` → `parseBoothName`）

规则：`^\s*(\d{5,9})` 取开头连续 5~9 位数字为 `boothId`；其余去掉前导分隔符
（空白 `_` `-` `【` `[` `（` `(`）作为 `productName`。

真实例子（实测）：

```
9038753奥の手 -OkunoTe-【愛莉・ミルティナ専用】
→ { boothId:'9038753', productName:'奥の手 -OkunoTe-【愛莉・ミルティナ専用】' }
```

反例（单测覆盖，全部 `boothId:null`）：

| 输入 | 原因 |
|---|---|
| `R-18 版.zip` / `v1.2.zip` / `.hidden.zip` | 数字不在开头 |
| `2024.zip` / `1234.zip` | 少于 5 位 |
| `1234567890.zip` | **数字后面还紧跟数字**（匹配到 9 位后第 10 位仍是数字）→ 判 null |
| `20240101.zip` / `20241301.zip` | 8 位且以 19/20 开头，按日期文件处理（宁可漏判，不把日期当商品号） |
| `abc9038753.zip` / 空串 | 不以数字开头 |

另：`9038753.zip` → `productName='.zip'`（点不是分隔符）；目录名生成时会去掉文件扩展名，
不会出现 `9038753 .zip/` 这种目录。

## 二、BOOTH 元数据抓取（`src/booth-meta.js` → `fetchBoothMeta` / `parseBoothHtml`）

- 请求 `https://booth.pm/zh-cn/items/<id>`，普通浏览器 UA + `Accept-Language: zh-CN`，**不带登录态**。
- 解析顺序：`<script type="application/ld+json">`（Product：name/brand/offers/image）→
  `og:title`/`og:image`/`og:description` → 页面里的店铺域名（`<shop>.booth.pm`）与 `/tags/<name>`。
- 限速：模块级 ≥`rateLimitMs`（默认 1000ms）/请求；成功缓存 `state/booth-cache/<id>.json` 30 天，
  404 缓存 7 天；429/5xx 只重试 1 次，仍失败标 `error`，**永不 throw**。
- 年龄墙（`年齢確認`/`r-18` 等且没有 Product ld+json）标 `gated`，仍尽量用 `og:image`；
  400/403 → `blocked`；404 → `not_found`。

**真实抓取一次（实测，2026-10-25）**：`9038753` 返回 HTTP 200 / 85,594 字节，字段：

```
status=ok
title  = 奥の手 -OkunoTe-【愛莉・ミルティナ専用】
shop   = ZigZag（ld+json brand.name；brand.url=https://z1gz4g.booth.pm/）
price  = 290-490 JPY（AggregateOffer lowPrice=290 / highPrice=490 / JPY）
image  = https://booth.pximg.net/c/620x620/6462285b-.../i/9038753/..._base_resized.jpg
itemUrl= https://booth.pm/zh-cn/items/9038753
gated  = false；该商品页没有 /tags/ 链接（tags=[]）
```

页面已存为 fixture：`scripts/fixtures/booth-item-9038753.html`（测试不联网，直接解析它）。

### JSON 端点优先（参考 A 在 `wt-backend` 的 `6e12ad2` 研究）

A 的探针（`scripts/booth-scrape-probe.mjs`）证实 BOOTH 还有 JSON 端点：
`https://booth.pm/{lang}/items/<id>.json`（`Accept: application/json`），字段比 HTML 全。
本实现已改成 **JSON 优先、HTML 兜底**（JSON 两条语言各试一次；都不可用才走 HTML）：

- JSON fixture 实测字段（`scripts/fixtures/booth-item-9038753.json`，来自 A 的研究产物，本仓库只读引用）：
  `name=奥の手 -OkunoTe-【愛莉・ミルティナ専用】`、`shop=ZigZag`、`price="¥ 290~"`、
  **`category=3D衣装`、`category.parent=3Dモデル`**（HTML ld+json 里没有分类！）、
  `tags` 十几个（VRChat/ミルティナ/骸骨…，本实现截前 12 个）、`images[0].original=booth.pximg.net/...`、
  `is_adult=false`、`url=https://z1gz4g.booth.pm/items/9038753`。
- `is_adult=true` 不降级成 `gated`（JSON 无年龄墙、字段完整），只在 `raw.isAdult` 标记；
  HTML 真被年龄墙拦（无 Product）才标 `gated`。
- 缓存/限速/重试语义不变（成功 30 天、404 7 天、429/5xx 只重试 1 次）。

## 三、目录布局与数据模型

```
state/files/<群号>/<分类>/<boothId> <商品名>/<原始文件>
    meta.json        ← 商品完整元数据
    thumbnail.jpg    ← 缩略图（下载失败只记 enrich_error，不影响转存）
state/files/<群号>/未分类/<原始文件>        ← 没有 BOOTH 号
```

- 分类优先级：**人工（category_source=manual）> BOOTH 页面分类 > 扩展名规则 > 未分类**。
- **只有抓到有效商品页（status=ok）才按商品建目录搬家**；404/年龄墙/被拦/网络失败**不搬家**，
  只记 `booth_id / enrich_status / enrich_error`（线上消息里有很多 QQ 网关数字文件名，如
  `9013048.zip`，按 5~9 位规则会被解析成 BOOTH 号，若不拦住就会造一堆垃圾商品目录）。
- 同一 BOOTH 号再次转存：如果同群已有该号的商品目录，**并入同一目录**（文件名冲突加 ` (1)`）。
- 保留期仍按台账 `archived_at/cleanup_at`；清理时会连同 `meta.json`/`thumbnail.*` 一起删，
  并向上删除空目录（商品目录 → 分类目录 → 群目录）。
- 人工分类：`POST /api/files/category` 写 `category_source='manual'`；此后重跑增强
  **不会改分类、不会挪文件**，只补 BOOTH 元数据/缩略图（判定点：`enrichArchiveItem` 里的
  `const manual = mapped.categorySource === 'manual'` 与 `shouldRelocate = !manual && status === 'ok'`）。
  注意：人工分类目前只改台账分类，不会自动搬文件（避免和用户手工挪目录打架）；
  如果用户自己把文件挪走，`rel_path` 会失配，建议通过 API 分类。

### 台账迁移（幂等）

`file_archive` 新增 11 列：`booth_id, booth_url, booth_title, booth_shop, booth_price,
booth_tags('a|b|c'), thumb_rel, meta_rel, enrich_status, enrich_error, enriched_at`。
`ensureFileLedger` 每次启动用 `PRAGMA table_info` 查列、缺哪列 `ALTER TABLE ADD COLUMN` 补哪列，
不重建表、不动数据。

**线上迁移前后（只读实测）**：迁移前 `file_archive` = **11 行 / 18 列**
（id, group_id, file_id, file_name, stored_name, rel_path, bytes, sha256, message_id, uploader,
uploaded_at, archived_at, category, category_source, cleanup_at, deleted_at, delete_reason, source）；
重启后第一次 `ensureFileLedger` 会补 11 列 → **11 行 / 29 列**（数据不变）。
存量回填：启动 15 秒后后台跑 `backfillBoothColumns`（按 file_name 反解 booth_id，不搬文件）。
当前 11 行里只有 `9013048.zip` 会被解析成 `booth_id=9013048`；其余是 `图片-引用N.*`，不解析。
该行随后抓页面大概率 404 → 保持原位、`enrich_status=not_found`。

## 四、接口（都挂控制台鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/files` | 每条带 `booth*` 字段、`tags[]`、`thumbUrl`、`metaUrl`（**前端不直连 BOOTH CDN**） |
| GET | `/api/files/thumb?id=` | 本地缩略图 |
| GET | `/api/files/meta?id=` | `meta.json` 内容 |
| POST | `/api/files/enrich` | `{ids:[...]}` 或 `{limit}`；重抓未抓到的/失败重试，返回每条结果 |
| GET | `/api/files/booth/:boothId` | 同一商品下的所有文件 |
| GET | `/api/files/export?format=json\|csv` | 外部索引（konoasset 风格） |

## 五、配置（写进交接，线上 config.json 由用户改）

```jsonc
"fileArchive": {
  "booth": {
    "enabled": true,              // 关闭后：全部按老「未分类/日期」逻辑，不发 BOOTH 请求
    "cacheDir": "state/booth-cache",
    "cacheDays": 30,              // 成功缓存
    "notFoundCacheDays": 7,       // 404 缓存
    "rateLimitMs": 1000,          // 全局请求间隔
    "timeoutMs": 15000,
    "thumbMaxBytes": 2097152      // 缩略图上限 2MB
  }
}
```

`config.example.json` 已加这段。**线上 config.json 没动、桥接没重启。**

## 六、验证

```
node --check src/{bridge,file-archive,booth-meta}.js                 通过
node scripts/test-booth-parse.mjs          19/19（真实例子 + 9 个陷阱 + 分隔符矩阵）
node scripts/test-booth-meta.mjs           8/8（真实 fixture、og 兜底、gated、404、429 重试、缓存、异常）
node scripts/test-booth-archive.mjs        11/11（目录布局、meta.json、缩略图、同号并入、人工优先、
                                                 无号未分类、失败不搬家、迁移幂等、回填、导出 CSV、清理删空目录）
node scripts/test-file-archive.mjs         全过
node scripts/test-chat-file-archive.mjs    全过（含「BOOTH 开启时先落未分类」）
node scripts/test-observe-learn.mjs        全过
node scripts/test-audit-bridge.mjs         全 PASS
node scripts/test-storage-card / media-queue / archive / safe-fetch / sticker-repair   全绿
```

## 七、已知限制 / 风险

- 商品页分类依赖 ld+json 的 `category`；BOOTH 很多分类其实只有标签或没有，此时继续用扩展名规则
  （`压缩包`/`图片`）做目录。gated 页面拿不到分类，按其状态不搬家。
- 年龄墙只取 og 信息；不进分类目录（同样「失败不搬家」）。
- 合并目录里的 `meta.json` 是「最后一条转存记录」写的，多文件同商品时字段相同，不影响索引；
  但不同商品如果被同名目录合并（BOOTH 改名）会以最新为准。
- `booth_tags` 用 `|` 连接（导出 JSON 再 split），标签来自 `/tags/` 链接，最多 8 个。
- 缩略图失败不阻塞，`enrich_status` 仍可能是 ok（`enrich_error` 会写原因）。
- 未做：手动分类时自动搬文件；商品页价格变动后的刷新（缓存 30 天）。
