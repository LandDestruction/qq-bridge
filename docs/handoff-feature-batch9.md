# 交接｜第九批：BOOTH 抓取/归类质量与边界

分支 `feat/file-archive`。配合 B 的卡片库页面，本批只做**质量与边界**，不改转存主流程。

## 一、分类映射表（`src/booth-classify.js`）

固定映射（页面分类 → 本地目录名），未知 → `未分类`：

| BOOTH 页面分类 | 本地目录 |
|---|---|
| `3D衣装` | `3D衣装` |
| `3Dモデル` | `3Dモデル` |
| `3D小道具` | `3D小道具` |
| `素材` | `素材` |
| `ツール` | `ツール` |
| `音声` | `音声` |
| `その他` | `その他` |
| 子类 `テクスチャ` / `シェーダー` / `アニメーション` / `モーション` | 归到 `素材` |
| 其它 | `未分类` |

- 支持去括号再匹配：`3D衣装（セール）` → `3D衣装`。
- 目录名统一清洗 `\/:*?"<>|` 与控制字符、去首尾点/空格、限 40 字符（`sanitizeCategoryName`）。
- `parseBoothJson` / `parseBoothHtml` 输出前就归一化；`enrichArchiveItem` 里再防御性归一化一次，
  保证目录名只可能是映射表里的值。

## 二、三种失败态的实际表现

| 状态 | 抓取结果 | 台账/目录 |
|---|---|---|
| 年龄墙 `gated` | 尽量取 `og:title`/`og:image`，返回 `status='gated'` | **不搬目录**、不丢条目；写 `meta.json`+缩略图，`enrich_status='gated'`，卡片仍能显示标题/图 |
| 429 / 5xx | 退避 1.5s 重试 1 次；仍失败 `status='error'`（不抛） | `enrich_status='failed'` + `enrich_error=HTTP xxx`；文件留在原位；1 天后可被 `/api/files/enrich` 重试 |
| 404 | `status='not_found'`，缓存 7 天 | `enrich_status='not_found'`；**不自动重试**（缓存期内不再发请求，单测断言第二次 enrich 0 次网络） |

其它边界：单次响应体上限 **2MB**（content-length + 实际字节双重检查），超限按 `error` 处理；
`state/booth-cache/<id>.json` 成功缓存 30 天、404 缓存 7 天（已有「过期后重新抓」单测）；全局限速 ≥1000ms。

## 三、缩略图规格

- 抓取时先下原图（≤2MB）到 `.thumb.src`，再用 ffmpeg 规格化成 **长边 ≤512 的 JPEG**
  （`scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos -q:v 3`），写到 `thumbnail.jpg`。
- ffmpeg 不可用/失败 → **保留原图**复制为缩略图，台账 `thumb_status='fallback'`（有图可显示，不隐藏）。
- 成功 `thumb_status='ok'`，失败 `missing`；新增列 `thumb_status`（迁移幂等），`/api/files` 与 meta.json 都带。
- `/api/files/thumb?id=…&w=480`：按需再缩到长边 ≤w（写 `<thumb>.w480.jpg` 缓存），不传 w 直接给 512 版本。

## 四、同号多文件（目录 + meta 样例）

```
state/files/100000001/3D衣装/9038753 奥の手 -OkunoTe-【愛莉・ミルティナ専用】/
   9038753 商品A.zip
   9038753 商品B.zip
   meta.json          ← files 数组含两条（各 fileName/bytes/sha256/relPath/archivedAt）
   thumbnail.jpg
```

- 目录名以「`<boothId> <页面标题>`」为准，标题为空才用文件名里的商品名。
- `meta.json` 读取旧文件后按 `sha256/relPath` 去重并**追加** `files`，不会互相覆盖；其余字段以最新抓取为准。
- 人工分类（`category_source='manual'`）重抓时：**分类与目录都不动**，只更新 booth 元数据/缩略图
  （判定点：`manual = mapped.categorySource === 'manual'`、`shouldRelocate = !manual && status === 'ok'`；`test-booth-merge` 有断言）。

## 五、e2e 真实 id 输出（`node scripts/booth-e2e.mjs 9038753`）

```
status: ok   title: 奥の手 -OkunoTe-【愛莉・ミルティナ専用】   shop: ZigZag
price: ¥ 290~    category: 3D衣装    tags: 12 个（ドクロ/髑髏/VRChat/…）
目录: 9038753 奥の手 -OkunoTe-【愛莉・ミルティナ専用】/
        meta.json (753B)
        thumbnail.jpg (70,885B)
缩略图校验: mode=resized  512x512  70,885B  ✅ 长边 ≤512 且为 JPEG
```

脚本支持 `--keep` / `--dir <path>` 保留产物；默认清理临时目录。

## 六、测试

新增：`test-booth-classify.mjs` **12/12**（映射表+子类归并+未知+非法字符）、
`test-booth-merge.mjs` **5/5**（同号并目录 + meta.files 合并 + 人工分类不被覆盖/标题目录名 + 未分类人工分类移动（有/无 BOOTH 号两条））、
`test-booth-errors.mjs` **6/6**（gated / 429 重试一次 failed / 404 缓存不重试 / 缓存过期重抓 / 2MB 上限 / fallback）。

回归：`test-booth-parse 19/19`、`test-booth-meta 13/13`、`test-booth-archive 11/11`、
`test-audit-bridge` 全 PASS、`test-file-archive`、`test-chat-file-archive` 全过；
`regression-all` 已加入三个新套件。e2e 真实抓取 9038753 通过。

## 七、仍未做 / 注意

- 人工分类现在会**真的移动文件**：`POST /api/files/category` → `moveArchiveItemToCategory`
  （有 BOOTH 号进 `<分类>/<boothId> <商品名>/`，无号进 `<分类>/`，meta.json/缩略图一起搬、旧空目录回收）；
  移动失败（文件被手工挪走等）退化为只改台账并返回 `moved:false`。移动后 `category_source='manual'`，
  BOOTH 后台重抓不会再动它。
- 缩略图按需 `w` 缓存会额外产出 `*.w480.jpg`（随原缩略图一起清理，清理逻辑删父目录时一并回收）。
- `gated` 条目不会自动建商品目录（避垃圾目录），如需归类由人工用 `/api/files/category` 指定。
- 未重启桥接、未改线上 `config.json`。
