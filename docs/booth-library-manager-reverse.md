# BOOTH Library Manager（BLM）逆向笔记

来源：`https://github.com/vrc-booth/booth-library-manager`（v1.1.0，WXT + React 浏览器扩展，侧栏面板）。
抓取时间：2026-10-25。本地副本：`<本机路径>\booth-library-manager-main`（下载 zip 解包，未改源码）。

## 它是什么
一个**浏览器扩展**：用户登录 booth 后，扩展在侧栏里抓取「我的库（accounts.booth.pm/library）」和「礼物（/gifts）」的分页 HTML，
解析成商品卡片列表，支持搜索、收藏、隐藏、文件夹归类、按文件下载。

## 数据模型（`types/booth.ts`，直接可抄）
```ts
type LibrarySource = "library" | "gifts";
interface BoothItem {
  id: string;            // BOOTH 商品号
  title: string;
  creator: string;       // 店铺/作者
  thumbnailUrl: string;  // 商品展示图
  boothUrl: string;      // https://booth.pm/.../items/<id>
  downloadUrls: { name: string; url: string }[];  // 该商品下的文件
  purchasedAt?: string;
  source?: LibrarySource;
}
interface LibraryFolder { id: string; name: string; parentId: string | null; itemIds: string[]; createdAt: number }
interface UserPreferences { favorites: string[]; hidden: string[]; tags: Record<string,string[]>; folders: LibraryFolder[] }
type FilterTab = "all" | "favorites" | "hidden";
type SourceTab = "library" | "gifts" | "custom";
```
要点：**列表单位是「商品（BOOTH item）」，不是文件**；同一个商品下的多个文件挂在 `downloadUrls` 上。

## 抓取方式（`utils/scraper.ts`）
- 基址 `https://accounts.booth.pm/library`，礼物 `.../library/gifts`，分页 `?page=N`，`fetch(url,{credentials:'include'})`（复用登录态）。
- 每 5 页并发一批，批间 `delay(400ms)`；用 `totalPages` + `hasNextPage` 判断结束，404 当作「到底了」。
- 解析失败（items 为空）时**远程刷新解析规则**（`utils/remoteParserRules.ts`）再解析一次——BOOTH 改版时的兜底。
- 去重键：`boothUrl || source+':'+id`。

## 解析（`utils/parser.ts` + `utils/parserRules.ts`）
- 商品 id：`data-product-id`/`data-item-id`，或从 `/items/<id>` 链接正则取。
- 标题/店铺：按规则选择器取文本；店铺缺失给 `"Unknown creator"`。
- 缩略图：按选择器取 `<img>`（图片懒加载属性也要看）。
- 下载文件：优先 `js-download-button` 元素（BOOTH 库的下载按钮模式），退化到 data 属性里的 URL。

## 界面结构（`entrypoints/content/components/*`）
- `LibraryPanel`：整体面板；`SearchBar` + `FilterTabs(all/favorites/hidden)` + `SourceTabs(library/gifts/custom)` + `ItemGrid`。
- `ItemCard`：**方形缩略图** + 标题 + 店铺 + 文件数；卡片点击打开 `boothUrl`；按钮：收藏、隐藏、加入文件夹、下载。
- `FolderBrowser` / `FolderPickerDialog` / `FolderDropTray`：嵌套文件夹，拖拽卡片进文件夹。
- `DownloadDialog`：选择该商品的哪些文件下载。
- `SyncButton`：全量同步（带进度：当前页/总页/已收集数）。
- `SkeletonCard`：加载占位。
- 存储：`utils/storage.ts`（偏好：收藏/隐藏/标签/文件夹）+ `utils/libraryCache.ts`（列表缓存）。

## 我们可以直接照搬的部分
1. **列表单位改成「商品」**：我们的库现在按文件平铺，用户要的是按 BOOTH 商品聚合的卡片（缩略图=BOOTH 商品图、标题、店铺、文件数）。
2. **缩略图取商品展示图**（不是本地图片、不是压缩包首图）。
3. 收藏/隐藏/标签/文件夹 这四个偏好概念（先做收藏+文件夹，可后置）。
4. 过滤 tabs（全部/收藏/隐藏）+ 搜索 + 大小排序的交互范式。
5. 卡片交互：点卡片开 BOOTH 页；详情里列文件与下载/重新抓取。

## 我们不照搬的部分
- 它是**浏览器扩展**，靠 `credentials:'include'` 复用用户登录态；我们是服务端，抓的是**公开商品页**（`booth.pm/zh-cn/items/<id>`），不碰用户账号、不存储登录态。
- 它的下载是浏览器发起、直接写用户磁盘；我们的下载由桥接完成并落 `state/files`。
- 它没有「文件类型白名单」概念；我们只转存图片+压缩包（用户规则）。
