# 交接｜第十批：商品展示图（cover）+ 同号图片归属 + 只归档压缩包进商品

分支 `feat/file-archive`。口径照抄 BOOTH Library Manager 的 `item.thumbnailUrl` 模型
（`docs/booth-library-manager-reverse.md`，`ed33992`）。

## 一、封面（cover）抓取与缓存

- 只对**有 booth_id 的压缩包**抓；同 id 首次抓到后走缓存，后续归档/补抓不再请求。
- 来源：商品页 `https://booth.pm/zh-cn/items/<id>`，**优先 `og:image`**，其次 ld+json 的 `image`
  （`parseBoothCoverSource`）。响应体上限 2MB。
- 规格：长边 **≤512px JPEG**、**≤200KB**（质量 3/6/9 × 边长 512/448/384/320 逐级压缩；
  压不到 200KB 时保留最小结果并在 `coverError` 里写明，卡片仍有图）。
- 存储路径：`state/booth-cache/<boothId>/cover.jpg` + 同目录 `cover.json`
  （`{status, fetchedAt, sourceUrl, bytes, width, height, edge, quality, error}`）。
- 缓存 TTL：**成功 30 天**；**失败 1 天**（避免 429/超时后立刻重试）。
- 失败不阻塞转存：`getBoothCover()` 返回 `{ok:false, status, coverError}`，写进 `cover.json`；
  `meta.json` 里同步写 `coverPath` / `coverError`。

## 二、给 A/库页面的约定（二选一，本批选了「导出函数 + HTTP」）

- 模块导出：`import { getBoothCover, getBoothCoverPath } from './booth-cover.js'`
  - `getBoothCover(boothId, { cacheRoot })` → `{ok,status,path,bytes,width,height,cached,coverError}`
  - `getBoothCoverPath(boothId, { cacheRoot })` → 已有新鲜封面时返回绝对路径，否则 `''`
- HTTP：`GET /api/files/cover/<boothId>`（本地优先；没有就现场抓一次再返回 JPEG，失败返回 404 + 原因）。
- 不新增 `cover_rel` 列（避免再动台账 schema）；`/api/files` 的每条压缩包记录会带
  `coverUrl: "/api/files/cover/<boothId>"`。

## 三、同号图片归属

`matchImageBooth(fileName, boothIds)`（`src/booth-meta.js` 导出）：

- 取文件名开头 5~9 位数字，**必须在已有 boothIds 集合里**才返回该 id，否则 `null`；
- 与 `parseBoothName` 共用同一套陷阱：10 位数字、`20240101` 这类 8 位日期、`R-18`/`v1.2` 全部不命中；
- 供 A 的迁移/补跑使用：图片行本身已带 `boothId`（见下），A 也可直接按台账字段挂到商品下。

## 四、只归档压缩包进商品

- `isArchiveFileName(fileName)`：扩展名属 zip/rar/7z/tar/gz/tgz/bz2/xz/zst。
- `enrichArchiveItem` 新增前置判断：**非压缩包**（图片等）只把 `booth_id/booth_url` 记进台账
  （供同号归属），**不建商品目录、不写 meta.json、不抓封面**，`enrich_status='skipped'`。
- 压缩包照旧：分类目录 + meta.json + thumbnail + cover；图片继续落盘/进台账但不单独成条目。
- `/api/files` 每条带 `isArchive` 标记，库页面可只展示压缩包、图片按 `boothId` 归到商品下。

## 五、实测（`node scripts/booth-e2e.mjs 9038753`，真联网）

```
元数据: status=ok title=奥の手 -OkunoTe-【愛莉・ミルティナ専用】 shop=ZigZag price=¥ 290~ category=3D衣装
cover:  ok=true status=ok
        path=<tmp>/booth-cache/9038753/cover.jpg
        bytes=70246  width=512  height=512  cached=false  maxEdge=512 maxBytes=204800
缩略图: mode=resized 512x512 70,885B ✅
```

（e2e 用临时 cacheRoot 演示结构；线上路径固定为 `state/booth-cache/9038753/cover.jpg`。）

## 六、测试

新增 `test-booth-cover.mjs` **4/4**：
- og:image 优先于 ld+json（断言下载 URL）；
- 生成 `cover.jpg` 尺寸 ≤512、≤200KB；第二次调用 `cached=true` 且 fetch/download 不再发生；
- 下载失败 → `status=error` + `coverError`，不抛；1 天内不重试；
- `matchImageBooth` 正反例（已有号命中、未知号、日期陷阱、无号、10 位数字）。

扩展 `test-booth-merge` **7/7**：同号多文件 meta 合并、标题目录名、人工分类不被覆盖、未分类移动 ×2、
**同号图片只记 boothId 不建商品**（断言不抓元数据、不抓封面、不移动）、压缩包 enrich 会调 `ensureCover` 且 meta 带 coverPath。

回归：`test-booth-parse 19/19`、`test-booth-meta 13/13`、`test-booth-classify 12/12`、
`test-booth-errors 6/6`、`test-booth-archive 11/11`、`test-audit-bridge` 全 PASS、
`test-file-archive`、`test-chat-file-archive` 全过；`regression-all` **38/40**
（未过：`test-v2-wait`、`test-vision-media`，都是工作树无 `config.json` 的环境性失败）。

## 七、未做 / 注意

- 没把 cover 路径写进台账列（约定用 `getBoothCover`/HTTP）；A 若更需要 DB 字段可再加 `cover_rel`。
- 失败 1 天缓存：过期后 `/api/files/cover/<id>` 会再试（`?force=1` 未实现，需要可加）。
- 图片不会因为同号而物理移动到商品目录（只记 boothId）；库页面展示归属由 A/B 的界面逻辑决定。
- 未重启桥接、未改线上 `config.json`。
