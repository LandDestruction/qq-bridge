# 控制台接口契约：文件台账 / 观察学习

> 前端（B）以本文为准。所有字段都是**稳定形状**，空数据不等于接口失败。

## 1. GET /api/files/stats

### 字段
| 字段 | 类型 | 说明 |
|---|---|---|
| ok | boolean | 恒 true（失败时返回 503 + error） |
| generatedAt | ISO 字符串 | 统计时间 |
| files | object | 台账汇总，见下 |
| files.active / classified / unclassified / due / deleted / total | number | 各类计数 |
| files.activeBytes / dueBytes / deletedBytes | number | 字节数 |
| **byGroup** | **array** | **永远是数组**（0 项为 `[]`，1 项也仍是数组），元素 `{groupId, files, bytes}` |
| enabled / groups / dir / maxFileMb | — | 转存配置回显 |
| **accept** | object | `{maxFileMb, extensions[], imageExtensions[], excludes[]}`，值与 `src/file-archive.js` 常量同源 |
| **disk** | object/null | `{freeBytes, totalBytes, guardReserveBytes, fitsMaxFile}`；statfs 不可用时为 `null` |
| nextCleanupAt | number(ms) | 下次清理时间 |

### 空数据示例
```json
{ "ok": true, "generatedAt": "2026-10-25T15:00:00.000Z",
  "files": { "active": 0, "activeBytes": 0, "classified": 0, "unclassified": 0,
             "due": 0, "dueBytes": 0, "deleted": 0, "deletedBytes": 0, "total": 0 },
  "byGroup": [], "enabled": true, "groups": [], "dir": "state/files", "maxFileMb": 2560,
  "accept": { "maxFileMb": 2560, "extensions": ["zip"], "imageExtensions": ["jpg"], "excludes": ["face","mface","sticker"] },
  "disk": null, "nextCleanupAt": 0 }
```

## 2. GET /api/files?limit=&offset=&group=&deleted=

| 字段 | 类型 | 说明 |
|---|---|---|
| ok | boolean | |
| files | array | 当前页记录（可能为空数组） |
| total | number | 同过滤条件下的总条数 |
| **limit** | number | **实际生效值**（1..1000；非法/<=0 → 100） |
| **offset** | number | **回显请求值**（负数/非数字 → 0；> total 时仍回显请求值，files 为 `[]`） |

- 前端翻页判断：`offset >= total` 即已到末尾，**不要**把空数组当成接口故障。
- 示例：`?limit=3&offset=0` → `{total:10, offset:0, limit:3, files:[3条]}`。

## 3. GET /api/observe/config

| 字段 | 类型 | 说明 |
|---|---|---|
| enabled | boolean | 观察学习总开关 |
| groups | string[] | **配置里的**观察群（enabled=false 时仍可能非空，属残留配置） |
| **effectiveGroups** | string[] | **实际生效**的观察群：只有 `enabled=true` 时等于 groups，否则 `[]`。前端判断「是否已生效」只看这个 |
| learnSlang / learnStickers | boolean | 学习项开关（默认 true） |
| description | string/null | 人话说明；`enabled=false` 时为 null；启用但无群时是「groups 为空」的提示 |
| source | string | 当前来源（`config.json`） |

### 三种状态
| 状态 | enabled | groups | effectiveGroups | description |
|---|---|---|---|---|
| 未启用 | false | 可能非空（残留） | `[]` | `null` |
| 启用无群 | true | `[]` | `[]` | 「已启用，但 groups 为空…」 |
| 启用有群 | true | `["100000005"]` | `["100000005"]` | 「观察学习白名单：…」 |

## 4. 前端错误处理约定

- **空 vs 失败**：以上接口失败时返回非 2xx + `{ok:false, error:string}`；2xx 且字段齐全即为「成功但没数据」。
- 列表类（files/byGroup/effectiveGroups）**永远不要**判 `if (x)`，直接 `Array.isArray(x)`。
- `disk === null` 表示「读不到磁盘信息」，不是磁盘已满。

## 5. GET /api/files 的筛选参数（库管理器）

| 参数 | 类型 | 说明 |
|---|---|---|
| q | string | 匹配 boothTitle / boothShop / fileName / boothId（大小写不敏感，支持中文） |
| category | string | 分类精确匹配 |
| uncategorized | 1 | 只看未分类（优先于 category） |
| shop | string | 店铺精确匹配 |
| status | enriched \| pending \| unclassified | 有 booth 元数据 / 待抓或失败 / 无 booth_id |
| sort | newest(默认) \| oldest \| title \| booth | 非法值回退 newest |

示例：`/api/files?q=奥の手&status=enriched&sort=title&limit=24&offset=0`

## 6. GET /api/files/lists

```json
{ "ok": true, "lists": [{ "category": "3D衣装", "count": 7 }, { "category": "压缩包", "count": 4 }],
  "uncategorized": { "count": 0 } }
```

## 7. GET /api/files/notify

```json
{ "ok": true, "pendingEnrich": 0, "failed": 0, "unclassified": 0, "lastBackfillAt": 1761392521000 }
```

## 8. GET /api/files/item?id=

```json
{ "ok": true, "item": { "id": 3, "fileName": "9013048 奥の手.zip", "boothId": "9013048",
  "boothTitle": "奥の手", "boothShop": "ZigZag", "category": "3D衣装",
  "thumbUrl": "/api/files/thumb?id=3", "metaUrl": "/api/files/meta?id=3",
  "meta": { "id": 9013048, "title": "…" }, "boothUrl": "https://booth.pm/zh-cn/items/9013048" } }
```
未找到 → **404** `{ok:false,error:"未找到该记录"}`。

## 9. GET /api/files/thumb?id=&w=

- 不传 `w`：原图。
- 传 `w`（64~1024，越界夹取；非数字按 480）：服务端用 ffmpeg 缩放为 JPEG；
  **ffmpeg 不可用/失败/超时 → 自动回原图**，响应头 `x-thumb-scaled`（`0` 表示未缩放）。
- 前端建议：卡片一律 `?w=480`。

## 10. POST /api/files/category（改分类）

- 无 `booth_id` 的条目：只改台账 `category`。
- 有 `booth_id`（已建 `<群>/<分类>/<boothId> <标题>/` 目录）：**同步移动目录**并把台账的
  `rel_path / thumb_rel / meta_rel` 一起改写；移动失败会**回滚目录**并返回 **500** + 明确原因，
  台账保持不变。

## 11. Library（以 BOOTH 商品为单位的卡片库）

> 规则：**列表单位是商品，不是文件**；库里只出现**压缩包**。图片只能作为**同 BOOTH 号**的素材
> （缩略图/画廊），无号或对不上的进「未分类」。

### GET /api/library/items
```json
{ "ok": true, "total": 1, "items": [{
  "boothId": "9013048", "title": "奥の手 -OkunoTe-", "shop": "ZigZag", "category": "3D衣装",
  "coverUrl": "/api/library/item-thumb?boothId=9013048",
  "boothUrl": "https://booth.pm/zh-cn/items/9013048",
  "enrichStatus": "ok",
  "files": [{ "id": 12, "fileName": "9013048 奥の手.zip", "bytes": 123456, "storedName": "9013048 奥の手.zip", "relPath": "100000001/3D衣装/9013048 奥の手/9013048 奥の手.zip", "archivedAt": 1761392521000 }],
  "totalBytes": 123456, "fileCount": 1
}] }
```
- 只聚合**压缩包**（`ARCHIVE_EXTENSIONS`）；**图片不会出现在 items**；
- 没有 `booth_id` 的压缩包不出现在 items（见 unclassified）。

### GET /api/library/item/:boothId
商品卡片 + `images[]`（同号图片，作素材/画廊，`thumbUrl` 已带 `w=480`）+ `meta`（meta.json 内容）。
未找到 → **404**。

### GET /api/library/unclassified
```json
{ "ok": true,
  "archives": [{ "id": 3, "fileName": "c.zip", "bytes": 100, "category": "压缩包", "archivedAt": 1761392521000 }],
  "images":   [{ "id": 5, "fileName": "nopic.png", "bytes": 100, "archivedAt": 1761392521000, "thumbUrl": "/api/files/thumb?id=5&w=480" }] }
```

### GET /api/library/item-thumb?boothId=
输出 `state/booth-cache/<boothId>/cover.jpg`（由转存回填缓存）。
**没有则 404**（前端显示占位图），不返回 302/空图。

### 同号图片回填
```bash
node scripts/backfill-image-booth.mjs           # dry-run（只读，打印将更新的行）
node scripts/backfill-image-booth.mjs --apply   # 写库（幂等）
```
桥接启动时也会补跑一次（幂等，只处理 `booth_id` 为空的图片）。
