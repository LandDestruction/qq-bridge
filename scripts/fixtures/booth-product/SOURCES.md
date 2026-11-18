# BOOTH 商品页 fixture（已购库解析层用）

这些是**真实商品页**的 HTML 切片，给 `src/booth-product.js` 与 `scripts/test-booth-product.mjs` 用。
改写方式：抓一份完整页面后，从商品详情区末尾（`<div class="shop-items"` 推荐区之前 / `<div class="shop__text"` 之前）
截断，每份 ≤120KB，其余字节原样保留（没有手工改数据）。

抓取日期：2026-10-30（本地，UTC+8；UTC 2026-10-29T16:00Z）
抓取方式：Node `fetch`，`user-agent: Chrome/124`，`accept-language: ja`，只抓公开商品页（无登录）。

| 文件 | 来源 URL | 用途 | 大小 |
| --- | --- | --- | --- |
| `item-8942722-variations.html` | https://booth.pm/ja/items/8942722 | 多规格：9 个 variations（¥990~¥1,800）、19 张图 | 73,351 B |
| `item-4511536-free.html` | https://booth.pm/ja/items/4511536 | 免费（最低价 ¥0）+ 规格名带适配数（11Avatars / 43Avatar） | 56,541 B |
| `item-6538026-single.html` | https://booth.pm/ja/items/6538026 | 单一价格（¥6,000），只有默认购买档 → `variations: []` | 36,209 B |

复抓注意：
- BOOTH 页面结构随时会改版；解析层断言的是这些真实页的当前形状，改版后先重新抓 fixture 再看测试红在哪。
- 页面里标签列表（`#js-item-tag-list`）与分类面包屑（`#js-item-category-breadcrumbs`）是客户端渲染的空壳，
  服务端 HTML 只有 `tags%5B%5D=` / `/ja/browse/` 链接可抽，所以 `tags`/`categories` 是 best-effort。
- 抓取时请保留商品详情区（`<div class="market">` 之后）到推荐区之前，别整页直传：推荐区里是别的商品，
  会把 title/tags/images 污染成邻居商品的数据。
