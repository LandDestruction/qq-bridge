# BOOTH 元数据 / 抓取 / 嗅探 研究（2026-10-25）

> 目标：给施工 C 的 file-archive 升级提供可直接落地的规格。**本文件只写研究结论与接口设计，不含实现**。

## 0. 结论速览

1. BOOTH 有一个**未公开但稳定**的 JSON 入口：`https://booth.pm/ja/items/<id>.json`（KonoAsset 用的就是它）。
   普通商品页 URL 加 `Accept: application/json` **同样返回 JSON**（实测 200 / 11.6KB）。
2. KonoAsset（`siloneco/KonoAsset`，101★，Tauri+Rust）只取 6 个字段做展示；**它的数据模型对我们帮助有限**
   （它扫本地文件系统 + 手填，不用数据库存 BOOTH 元数据）。
3. 我们真正需要的是「**BOOTH JSON 全量字段 + 我们自己的文件关联**」——见 `docs/booth-item.schema.json`。
4. 抓取成本极低（11KB / ~200ms），但**必须有 UA、超时、缓存与限速**。

## 1. KonoAsset 研究

### 仓库与形态
- GitHub `siloneco/KonoAsset`（`api.github.com/repos/siloneco/KonoAsset` → 200，default branch `develop`）。
- 结构：`src/`（React+TypeScript 前端）、`src-backend/`（Tauri + Rust crates：`model` / `booth` / `tauri`）。
- **没有 SQLite / 迁移脚本**：`git trees` 里搜不到 `.sql` / migration；它的「元数据」是
  ① 扫描本地目录 ② 读 BOOTH 轻量信息 ③ 手填（asset type、booth item id、note 等）存进自己的配置/索引文件。

### 它从 BOOTH 取什么（`src-backend/crates/booth/src/definitions.rs`）
```rust
pub struct BoothAssetInfo {      // 对外暴露（前端用）
    id: u64, name: String, creator: String,
    image_urls: Vec<String>, published_at: i64, estimated_asset_type: Option<AssetType>,
}
pub(crate) struct BoothJsonSchema {   // BOOTH 原始 JSON（只反序列化用到的字段）
    id: u64, name: String, shop: BoothShop, images: Vec<BoothPximg>, category: BoothCategory, published_at: String,
}
```
- `creator` ← `shop.name`；`image_urls` ← `images[].original`；
- `estimated_asset_type` ← 由 `category.id` 映射（`estimate_asset_type_from_category`）；
- `published_at` ← `published_at`（RFC3339）转毫秒。

### 抓取实现（`booth/src/booth.rs` + `client.rs` + `cache.rs`）
- URL：`https://booth.pm/ja/items/{id}.json`；
- UA：`KonoAsset/{version}`；超时 **5s**；
- 404 → `NotFound`；JSON 解析失败 → 错误；
- 缓存：**内存 HashMap，TTL 60 秒**（不是持久化）。

### 对「同一商品多次购买/多版本/未匹配」的处理
- KonoAsset 把「商品」与「本地文件」解耦：一个 BOOTH 商品可以挂多个本地文件（目录扫描结果），
  没有「购买记录」概念；未匹配到 BOOTH 的本地文件就是把 `boothItemId` 留空。
- **因此我们不能照抄它的数据层**，只能借它的字段映射思路。

## 2. BOOTH 抓取实测（本机，2026-10-25 22:44）

| 请求 | 结果 |
|---|---|
| `GET https://booth.pm/zh-cn/items/9038753`（普通 UA） | **200**，`text/html`，85,431 字节，含 `application/ld+json` |
| `GET .../items/9038753` + `Accept: application/json` | **200**，`application/json`，11,684 字节 |
| `GET https://booth.pm/ja/items/9038753.json` | **200**，`application/json`，**11,533 字节** ✅ 推荐 |
| `GET https://booth.pm/zh-cn/items/9038753.json` | **200**，`application/json`，11,684 字节 |

- 抓取耗时约 **2.6s**（含 TLS；热连接会快很多）。
- fixture 已存：`scripts/fixtures/booth-item-9038753.json`（11,533B）与 `booth-item-9038753.html`（85,594B，早期探针产物）。

### BOOTH JSON 里有什么（实测 9038753）
```json
{ "id": 9038753, "name": "奥の手 -OkunoTe-【愛莉・ミルティナ専用】",
  "shop": {"name":"ZigZag","url":"https://z1gz4g.booth.pm/"},
  "price": "¥ 290~", "category": {"id":209,"name":"3D衣装","parent":{"name":"3Dモデル"}},
  "tags": [ ... 26 个 ... ], "is_adult": false,
  "images": [{"original":"https://booth.pximg.net/.../..._base_resized.jpg"}],
  "published_at": "2025-xx-xxT...", "wish_lists_count": N }
```
- `is_adult` 是**权威的年龄标记**。实测教训：早期探针用 HTML 正则判 `ageGated` 时，把本商品（`is_adult=false`）误判成 true —— **必须用 JSON 的 is_adult，不要用页面字样**。
- 图片：`images[].original` 是原图 URL；`resized` 是缩略图（`/c/72x72_a2_g5/…`）。**同一图两个尺寸**，抓原图会更慢更大。
- 分类在 JSON 里是 `category.id/name/parent`，比 HTML 面包屑可靠。

### 限速 / 反爬
- 本次研究共约 8 个请求、间隔 ≥1s，**未遇到 429/403**。
- 仍建议：单进程 ≤1 请求/秒、全体 ≤20 请求/分钟；失败指数退避（1s/3s/9s），404 不重试。
- 必需 header：`user-agent`（缺失可能被 CDN 拦）；建议带 `accept: application/json` 与 `accept-language`。

## 3. 资源嗅探（我们场景）

三种来源，统一收敛到 `boothItemId`：

| 来源 | 规则 | 备注 |
|---|---|---|
| 群消息文本 | `booth\.pm/(?:[a-z-]+/)?items/(\d+)` | 覆盖 `/zh-cn/items/`、`/ja/items/`、带 `.json` 也能命中 |
| 引用/卡片 | 同上（转发消息 body 走同一正则） | 卡片里的链接可能被转义成 `https:\/\/`，先 `JSON.parse` 或反转义 |
| 文件名 | `^(\d{4,10})[\s_-]*` | 群友命名惯例：`9038753奥の手…`；**前缀数字优先**，避免商品名里含数字 |

- 压缩包内线索（`readme`/`商品名.txt`）：**不做**（要解压 + 编码探测，收益低）。
- 去重：以 `boothItemId` 为主键，抓取成功缓存 7 天（研究期 60s 太短，我们不是交互式工具）；
  失败也缓存 10 分钟，避免抖动时反复打。
- 安全：只允许 `booth.pm` / `*.booth.pm`（图片域 `booth.pximg.net`）；**禁止跟随跨域重定向**；
  响应体上限 2MB；超时 8s；不执行 JS。
- R-18：`is_adult=true` 默认**只存元数据、不落图片**（见「需拍板」）。

### 接口设计（建议放 `src/booth-meta.js`，与 `file-archive.js` 独立）
```js
sniffBoothIds({ text, segments, filenames }) -> number[]        // 纯函数，可离线单测
resolveBoothMeta(id, { fetchImpl, cache, now }) -> BoothItem    // 抓取 + 解析 + 缓存
cacheGet(id, now) / cachePut(id, item, now)                     // TTL + 失败短缓存
buildArchiveMeta({ groupId, file, booth }) -> meta.json 对象     // C 的 file-archive 直接消费
```
调用关系：`file-archive` 收到文件 → `sniffBoothIds({filenames:[name]})` → 命中则
`resolveBoothMeta(id)` → 写 `meta.json`（路径、sha256、booth 字段、unmatched 标记）。

## 4. 我们建议的最小落地（给 C）

1. 文件名前缀 `^(\d{4,10})` → id；抓 JSON；`meta.json` 落 `{id,title,shop,price,category,tags,isAdult,images,thumbUrl,publishedAt,fetchedAt,localFiles[]}`。
2. 目录：`state/files/<groupId>/<YYYY-MM>/<category.parent>/<category.name>/<id>-<sanitizedTitle>/`（C 已定，此处只提供字段）。
3. 未匹配：`unmatched: true` + 原始文件名，**不要**伪造标题。
4. 图片：默认**不下载**（省空间）；需要时按 `thumbUrl` 拉缩略图（`resized` 更小）。

## 5. 风险与不做的事

- 不做：登录态抓取（买过的商品）、价格历史、评论抓取；
- 不做：HTML 页面正文解析当主路径（JSON 已够，HTML 只做兜底）；
- 风险：BOOTH 的 JSON 端点未公开，**随时可能加验证/移除**；抓取失败必须降级为「只有文件名」，不能阻塞转存。

## 6. 复现命令

```bash
node scripts/booth-scrape-probe.mjs 9038753 --save
# → 打印 {id,title,shop,price,category,tags,isAdult,images,thumbUrl,...}
# → 保存 scripts/fixtures/booth-item-9038753.json
node scripts/booth-scrape-probe.mjs 6641548        # KonoAsset 自己的商品，交叉验证
```

## 8. 需要拍板的问题（等审阅/用户决定）

1. **R-18 商品**：`is_adult=true` 时是否只存元数据、不落图片/不建可见目录？（默认建议：只存元数据）
2. **缩略图是否落本地**：`booth.pximg.net` 是 CDN，URL 可能失效；落本地占空间但稳定（建议：只存 URL + 可选落图）。
3. **缓存时长**：本模块默认成功 7 天 / 失败 10 分钟（KonoAsset 用 60s，因为它是交互式工具）。
4. **是否允许调用未公开的 `.json` 端点**：它最省事（11KB vs 85KB HTML），但非官方 API，可能随时变。
5. **引用里的视频**：当前只标注「未做抽帧/转写」；是否要改成真分析（需要构造消息对象回填引用文本）。

## 9. 复现清单（离线可跑）

```bash
# 1) 纯逻辑单测（不联网）
node scripts/test-booth-meta.mjs
# 2) 抓取探针（联网，单次 ~1 请求）
node scripts/booth-scrape-probe.mjs 9038753 --save
# 3) 视频音轨/转写离线探针（需要 ffmpeg + faster_whisper）
node scripts/probe-video-audio.mjs <path-to-mp4>
```

## 10. 视频分流修复的最终结论（五选一）

**主因 (a) 视频未被识别为视频**：引用附件旁路 `src/bridge.js:14383-14388` 无类型判定，
加上 `file` 段只看 `d.name` → mp4 被当图片抓（`抓取内容不是有效图片`）。
叠加 **(b) enrich 与 prompt 竞态**（已改为 prompt 前有限等待 ≤20s）与
**(e) 上一轮残留帧**（拼图以 image 形式留在 recentMessages）。
(c) 音频提取失败 / (d) 转写空 —— 已用离线探针排除（40s 中文语音 mp4 转写成功）。
