# 交接｜表情采集立即落盘（修「只存过期链接」）

分支 `feat/file-archive`。起因：面板又出现「图片已失效」，根因是**观察群采集只存了带 rkey 的
QQ 多媒体直链**（几十分钟过期），md5 为空、本地无缓存；事后原链接已 400，永远补不回来。

## 一、先说明 git 现状

- `git merge main`：worktree 里 `main` 就在 `563c54e`，**已经包含在分支里（Already up to date）**。
- 交付说明里提到的 `3cdde95（load/merge 去重 + md5 优先）` **在本 worktree / main 里都不存在**
  （`git show 3cdde95` 报 `unknown revision`，`dedupeStickerEntries` 也不在 `src/sticker-lib.js`）。
  为了不阻塞，本批**自行实现了同语义的 `dedupeStickerEntries`**（md5 优先、URL 忽略查询参数去重、
  重复项合并保留人工注释），并在 `loadStickerStore` / `mergeStickerLibrary` 里启用。
  如果之后合并到那个提交，注意两边都叫 `dedupeStickerEntries` 会冲突，需要以那份实现为准删掉这份。
- 前一批 `test-stickers.mjs` 里有一条 `buildStickerContext 包含备注` **在本批之前就是失败的**
  （用 `git cat-file blob c7789f1:src/sticker-lib.js` 单独跑同样失败：`buildStickerContext` 只收
  `policy==='usable'` 的表情，那条测试给的条目是 understand-only）。这是既有问题，不是本批引入。

## 二、改了什么

### 1) `src/sticker-lib.js`

- 条目新增两个字段（`normalizeStickerEntry` 保留、`formatStickerList` 透出给面板）：
  - `thumbStatus`: `''` 未试过 / `'ok'` 本地有图 / `'missing'` 试过拿不到；
  - `thumbError`: 原因（如 `HTTP 400`）。
- `dedupeStickerEntries(entries)`：**md5 优先**去重，没有 md5 的按 URL（忽略协议/尾斜杠/查询参数）；
  重复项合并时保留人工注释（localNote/tags/usage/useCount 取并集/较大值）。
- `stickerCachePath(cacheDir, md5)`、`stickerCacheBytes(cacheDir)`：缓存路径与容量统计。
- **`persistStickerThumb(entry, { fetchImpl, cacheDir, maxBytes })`**（核心）：
  - 已有 md5 且 `<md5>.img` 存在 → `cached`（不重复下载）；
  - 有 url → 下字节（≤2MB）→ `md5Hex` → 写 `state/sticker-files/<md5>.img` → 回填条目 `md5`、
    `thumbStatus='ok'`；
  - 下载失败/超限/没 url → 不抛，`thumbStatus='missing'` + `thumbError`，**原 url 保留**。

### 2) `src/bridge.js`

- **观察群采集**（`collectObserveSticker`）：有 md5/url 时先入库，再**立刻** `persistEntryThumb`
  （内部调 `safeFetchBinary(url, 2MB)`）；有 url 但没 md5 的，落盘后 md5 自动回填。
  只有 url/md5 都没有时，才继续走原来的网关 `get_image`/`fetchFaceEntity` 路径（拿到字节也会落盘）。
- **收藏夹同步**（`syncStickerLibrary`）：合并后后台 `persistMissingStickerThumbs({limit:20})`
  ——「有 url、本地还没缓存」的条目补一次落盘；不阻塞同步返回。
- **启动补落盘**：启动 20 秒后 `persistMissingStickerThumbs({limit:10})`，历史遗留的「只有链接」
  条目会在这里被补成 md5 缓存，或标成 `missing`（那 2 条 400 的就属于后者）。
- **缓存上限（按任务书的建议实现了）**：默认 **200MB**（可用 `socialV2.sticker.cacheMaxMb` 覆盖），
  超过上限时**跳过落盘**、条目标 `thumbStatus:'missing'`（原因写明），并每小时最多告警一行日志。
  单张图上限 **2MB**（safeFetchBinary）。
- 缩略图接口/列表已经优先读本地缓存；`/api/stickers` 列表现在带 `thumbStatus/thumbError`，
  面板可以直接显示「失效」并走删除/重新采集（不需要每次请求现拉）。

### 3) 配置

`config.example.json` 的 `socialV2.sticker` 增加 `"cacheMaxMb": 200`（可省略，默认 200）。
**线上 config.json 没动、桥接没重启。**

## 三、磁盘占用口径（任务书要求写清）

- 每张表情 ≤ **2MB**（下载上限）；实际 QQ 表情多为 10~100KB。
- 总量上限 **200MB**（约 2000~20000 张，取决于大小）；超过后新表情只存链接、不落盘，并告警。
- 这也是为什么没有无限增长：上限 + 每小时折叠告警 + `missing` 不重复重试（交给
  `POST /api/stickers/repair` 或面板「重新采集」）。
- 那 2 条已失效的（`c_ICSz…` / `c_vvHdlo…`）：源链接 400，**无法恢复**；启动补落盘会把它们标
  `missing`，在面板里删除或重新采集即可。

## 四、验证

```
node --check src/{bridge,sticker-lib}.js                     通过
node scripts/test-sticker-persist.mjs                        9/9（新）
  - 假 fetch 返回字节 → 断言写出 <md5>.img 且条目 md5 回填、thumbStatus=ok
  - 假 fetch 404 → 不抛、thumbStatus=missing、thumbError 有原因、url 保留
  - 无 url → missing 且 fetch 0 次；md5 命中缓存 → cached 且 fetch 0 次
  - 超 maxBytes → missing 不写盘
  - 去重：同 md5 不同 id/url → 1 条且人工注释不丢；同 url（query 不同）→ 1 条；不同表情不误合并
  - formatStickerList 透出 thumbStatus/thumbError
node scripts/test-sticker-repair.mjs                         5/5
node scripts/test-audit-bridge.mjs / test-chat-file-archive / test-file-archive /
     test-observe-learn / test-booth-archive                 全绿
```

## 五、已知问题 / 后续

- `test-stickers.mjs` 的 `buildStickerContext 包含备注` 是**既有失败**（见第一节），本批未动它。
- 同步后补落盘只补前 20 条/轮；第一次升级时历史条目多的话，后续几轮同步会慢慢补齐，
  也可用控制台的 `POST /api/stickers/repair` 主动跑。
- `thumbStatus:'missing'` 的条目不会自动无限重试（避免反复打过期链接）；重新采集由面板/repair 触发。
- 观察群的 `face` 段没有 url 时仍依赖网关 `fetchFaceEntity`，失败会留日志但不会落盘。
