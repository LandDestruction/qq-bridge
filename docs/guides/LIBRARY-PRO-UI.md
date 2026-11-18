# 素材库 Pro 界面（参考 VRC 素材库 / MioVRC 的三栏结构）

目标：给「素材库」一套**看起来像专业素材管理器**的浏览界面（不是运维页）。现有「文件库」页保留（转存条件、文件夹、清理、对账入口都在那儿），新界面作为**新的一级导航「素材库」**，与文件库共用后端数据与写操作。

## 1. 布局（1440 宽）

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 顶栏（站点已有的）                                                            │
├───────────────┬────────────────────────────────────────────────────────────┤
│ 左栏 (240px)   │ 工具条 row1：🔍 搜索名称/标签/店铺/商品号 (Ctrl+K)   [适配模型▾] [全部｜仅图片｜收藏]  [质量检查▾] [最近导入▾] [▦ 密度滑杆] │
│               ├────────────────────────────────────────────────────────────┤
│ ▸ 全部素材 17  │ 分类胶囊 row2：[全部 17] [饰品 3] [服装 2] [发型 1] …      [展开全部 N 个子分类] │
│ ▸ BOOTH 已购 10│────────────────────────────────────────────────────────────│
│ ▸ 免费/免费鸡蛋│ 网格：宽卡（封面 4:3 或 1:1，圆角 14）                          │
│ ▸ 未认号 1     │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐             │
│               │  │ 封面    │ │ 封面    │ │ 封面    │ │ 封面    │             │
│  分类 ▾        │  ├─────────┤ ├─────────┤ ├─────────┤ ├─────────┤             │
│   饰品 3       │  │标题两行 │ │标题     │ │标题     │ │标题     │             │
│   服装 2       │  │#号 店铺 │ │#号      │ │未认号    │ │#号      │             │
│   …（全部）    │  │ZIP 分类 │ │ZIP 分类 │ │ZIP 未分类│ │…        │             │
│               │  │3 文件 1.2M│ │ …      │ │…        │ │…        │             │
│  店铺 ▾        │  └─────────┘ └─────────┘ └─────────┘ └─────────┘             │
│   某某店 4     │  （每卡右上角：☑ 多选、★ 收藏；悬停浮出快捷：找号/以图搜源/改名/补封面/更多）│
│  来源 ▾        │                                                            │
│   百度网盘 12  │  底部：共 N 件 · 已显示 M · [加载更多]（滚动到底自动加载）        │
│  标签 ▾        │                                                            │
│   合集 / 其它  │                                                            │
└───────────────┴────────────────────────────────────────────────────────────┘
```

要点：
- **左栏是筛选树**，每项右侧带计数；点一项即筛选，再点取消；分组可折叠。
- 顶栏左侧搜索框支持 `Ctrl+K` 聚焦、300ms 防抖、清空按钮；搜索覆盖标题、别名、商品号、店铺、标签。
- 「适配模型」是下拉（全部 / 未标注 / 1 / 2~3 / 4~7 / 8+），对应后端 `modelCount` 桶。
- 「全部｜仅图片｜收藏」是分段；「仅图片」= 主件是图片（png/jpg/jpeg/webp），「收藏」= `favorite:true`。
- 「质量检查」下拉：全部 / 未分类 / 无封面 / 未认号 / 有解压码 / 有 RJ / 重复号。
- 排序：最近导入（默认）/ 名称 / 大小 / 使用次数 / 最近使用。
- 密度滑杆：3 档（大 3 列 / 中 4 列 / 小 6 列），存 localStorage。
- 卡片快捷操作直接复用现有 `data-write`（`library-find`、`library-find-by-image`、`library-rename`、`library-covers`、`library-detail`、`library-trash`、`library-batch-*`）。
- 空状态、加载骨架、错误态都要有；窄屏（<900）左栏收进抽屉。

## 2. 后端契约（新增）

### 2.1 `GET /api/library/facets`
一次返回左栏与胶囊所需的全部计数（与当前筛选无关的**全库**口径；带 `q` 时按搜索命中的子集算）：
```json
{
  "ok": true,
  "total": 17,
  "facets": {
    "category": [{ "value": "饰品", "label": "饰品", "count": 3 }],
    "shop":     [{ "value": "𝔐𝔢𝔴 ℕ𝔶𝕒𝕟𝕘", "count": 2 }],
    "source":   [{ "value": "transfer", "label": "群转存", "count": 14 }],
    "tag":      [{ "value": "VRChat", "count": 6 }],
    "modelCount":[{ "value": "unlabeled", "label": "未标注", "count": 9 }],
    "quality":  [{ "value": "noCover", "label": "无封面", "count": 1 }, { "value": "noBooth", "label": "未认号", "count": 1 }, …],
    "purchased": 10, "free": 0
  },
  "categoryRules": "v1"
}
```
约定：
- `category` 用固定分类表（见 §2.3），`value` 是规范名（中文），`label` 同值。
- `shop` 来自 `meta.shop`；没 meta 的归「未填店铺」，不列进 facets。
- `source` 取值：`transfer`（群转存）/`baidu`（百度网盘目录）/`unfiled`（未分类目录）/`unknown`。
- `modelCount` 桶：`unlabeled` / `1` / `2-3` / `4-7` / `8+`。
- `quality` 桶复用 assets 的 counts 口径（`noCover`/`noBooth`/`withPassword`/`rj`/`duplicated`/`unclassified`），只列出 >0 的。
- `purchased`/`free` 来自已购台账（能对上的算 purchased；boothId 属于免费清单的算 free，没有免费台账时 free=0）。

### 2.2 `GET /api/library/assets` 新增参数（在现有 `q/filter/sort/offset/limit` 之上）
| 参数 | 值 | 说明 |
|---|---|---|
| `category` | 分类名或 `unclassified` | 按规范分类筛 |
| `shop` | 店铺名 | 精确匹配 `meta.shop` |
| `tag` | 标签 | 命中 tags 任一 |
| `model` | `unlabeled`/`1`/`2-3`/`4-7`/`8+` | 适配模型桶 |
| `kind` | `image`/`archive`/`unity` | 「仅图片」= `kind=image` |
| `fav` | `1` | 只看收藏 |
| `purchase` | `purchased`/`free` | 按已购台账 |
| `sort` | `recent`（默认）/`title`/`bytes`/`use`/`lastUsed` | 新增后两个按 `usage`（工程使用统计）排序 |
响应新增每个 asset 的 `category`、`modelCount`、`favorite` 三个字段（`favorite` 布尔）。

### 2.3 分类规则（新纯函数 `src/library-category.js`）
`categoryOf(asset) -> {category, from}`：
1. `meta.category` 是已知规范名 → 用它（`from:'meta'`）；
2. 否则按名字/标签关键词映射（`from:'rule'`）：饰品 / 服装 / 发型 / 模型 / 贴图 / 地图 / 特效 / 工具 / 音声 / 其它；
3. 都没有 → `未分类`（`from:'none'`）。
`modelCountOf(asset) -> number|null`：优先 `meta.models`（数组长度或数字），否则从 title/规格名抽 `Nアバター/N avatars/N人` 之类的数字，抽不到返回 null。
`bucketOfModel(n)` 见 §2.1。

### 2.4 收藏（新）
- 存储 `state/booth-favorites.json`：`{ "version":1, "entries": { "<contentKey>": { "at": 0 } } }`
- `POST /api/library/favorite { key, on }` → `{ ok, favorite, count }`；`GET /api/library/favorites` → `{ ok, keys: [], count }`。
- 访客只读：`GET /favorites` 允许，`POST` 403。
- 改名导致 key 变化时，收藏随绑定表一起迁移（复用 rename 的 bindMigrate 路径）。

## 3. 前端结构

- 新文件 `client/10-library-pro.js`（片段，按现有 build-client 顺序加在 `09-ring.js` 之前或之后，按文件名排序即可）。
- 新 `data-view="library-pro"` 的 `<section data-page="library-pro">`，侧栏一级项「素材库」（放在「文件库」上面）。
- 复用：`libraryCardHtml` 的缩略图/详情/写操作；`libDetailOpen`；`libBatch*`（多选条）；`data-write` 委托。
- 独立状态 `libProState = { q, side:{...}, seg:'all', quality:'', model:'', sort:'recent', density:2, items, total, offset, loading, facets }`。
- 加载顺序：先 `facets`（骨架）→ `assets` 首屏 24 件 → 滚动加载更多（`offset`）。
- 所有请求走 `api()`（自动带 token）；错误显示 `qdb-hint` 人话；404 → 「后端还没上线素材库视图（接口 404）」。
- 可访问性：筛选按钮 `aria-pressed`、滑杆 `aria-label`、卡片 `tabindex=0` 回车开详情。

## 4. CSS（`public/client.css` 追加）
- `.qdb-libpro { display:grid; grid-template-columns:240px minmax(0,1fr); gap:16px }`
- 左栏 `.qdb-libpro-side`（玻璃卡、分组标题 12px 大写、计数徽章、选中态左侧 2px 主色条）
- 顶栏 `.qdb-libpro-bar`（sticky，搜索框 320px、胶囊与下拉复用 `.qdb-seg`/`.qdb-chip`）
- 卡片 `.qdb-libpro-card`（封面 4:3、标题两行截断、chips 单行溢出隐藏、hover 抬升 1px + 阴影）
- 密度：`.qdb-libpro[data-density="3"] { grid-template-columns: repeat(3, 1fr) }` … 6 列
- 窄屏 <900：`.qdb-libpro { grid-template-columns:1fr }`，左栏变抽屉（`#libProSideToggle`）。

## 5. 验收（verifier）
1. `GET /api/library/facets` 与 `assets` 的计数自洽：每一档 count 之和 = total；`assets?category=X` 的 `total` 等于 facets 里该分类 count。
2. 每个筛选参数单独打一遍，结果集合与 facets 计数一致。
3. 搜索：`q=号`/`q=店名`/`q=标签` 都有命中，`Ctrl+K` 聚焦、清空恢复。
4. 收藏：POST 后 `fav=1` 能筛出来、`GET /favorites` 有 key；取消后消失；访客 POST 403。
5. 视觉：1440 三栏、1024 与 375 两档截图；无横向滚动、卡片不重叠、文字不溢出。
6. 写操作（找号/改名/以图搜源/补封面/移入回收站）在新页面都能触发且行为同文件库页。
