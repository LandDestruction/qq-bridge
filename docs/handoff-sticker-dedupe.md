# 表情库重复排查与修复（handoff）

> 批次：msg-b28（三十批补）｜分支 `feat/frontend`｜提交见文末
> 线上 `state/stickers.json` 已清理并备份；**桥接需重启一次**新写入代码才生效。

## 1. 现场统计

### 1.1 `state/stickers.json`（清理前，只读统计）

```
总条数 164
按 md5 重复：0 组
按 emojiId 重复：0 组
按 url 重复：1 组（93 条共用 https://multimedia.nt.qq.com.cn/download 的 path，属正常：QQ 直链同路径不同 query）
按 dhash 重复：1 组（2 条）   ← 唯一的真重复
缺 md5：0 条｜thumbStatus=missing：0 条｜无本地缓存文件字段：164 条（缓存靠 md5 定位，不依赖字段）
```

重复组明细：

```
dhash 589c96589c98e0e0 ×2
  100000007_0_0_0_18502EFD5D28C35D2A3091E6F4E763B0_0_0  md5 18502EFD…  localNote「一般用在围观、旁观」
  100000007_0_0_0_2E997EFEB6AB15A6B46F518C6C1DCA60_0_0  md5 2E997EFE…  无备注
```

缓存目录 `state/sticker-files`：179 个 `.img`，按内容 MD5 分组 **0 组重复** —— 磁盘上没有重复图片，重复只发生在台账层。

### 1.2 与 `/api/stickers` 的差异（清理前，桥接内存态）

```
/api/stickers?count=500 → total=164, 返回 100 条
仅在 API：1 条（就是被清理掉的那条重复，桥接内存里还是 164）
仅在文件：64 条（API 分页只返回 100 条，属正常）
两边 thumbStatus=missing 都是 0
```

结论：**文件与 API 的「多出来那一条」正是重复条目；API 显示 164 是桥接内存快照未随文件清理更新**。

### 1.3 `[sticker]` 日志（`state/bridge.log`）

```
15:37:27 [sticker] 已同步 QQ 收藏表情 54 个（本地库 163 条，via ws）
16:00:55 [sticker] 已同步 QQ 收藏表情 54 个（本地库 164 条，via ws）
16:02:36 [sticker] 已同步 QQ 收藏表情 54 个（本地库 163 条，via ws）
16:16:48 [sticker] 已同步 QQ 收藏表情 54 个（本地库 164 条，via ws）
16:16:50 [sticker] 已同步 QQ 收藏表情 54 个（本地库 164 条，via ws）
17:15:03 [sticker] 已同步 QQ 收藏表情 54 个（本地库 164 条，via ws）
```

`163 ↔ 164` 反复横跳 = 每次「收藏同步」先用 load 去重（163），随后把**内存里的 164 条整表写回**（164）。可见写入路径在 sync 时**没有走去重**，只是读的时候折叠了一下。

## 2. 根因

| # | 口子 | 说明 |
|---|---|---|
| 1 | 同图不同 md5 | CDN 重编码/尺寸变体 → 同一张图两次采集 md5 不同，md5 键天然失效；只有 dhash 能认 |
| 2 | url 键没剥 query | QQ 图片链接带会过期的签名参数；md5 未回填时（先收图、后算 md5）同图两次采集 URL 不同 → 两条 |
| 3 | `emojiId` 未归一 | `normalizeStickerEntry` 白名单没有 `emojiId`，QQ「重复收藏同一表情」（emoji_id 不同）只能按 id 各存一条 |
| 4 | **写盘不去重** | `saveStickerStore` 直接写传入数组；`loadStickerStore`/`mergeStickerLibrary` 的去重只在**读**时生效。任何 `load → push → save`（收藏同步、群聊收集、观察群采集、md5 回填、`/api/stickers` 写操作）都会把重复重新写回盘；并发两次 read-modify-write 还会丢更新 |

日志的 163↔164 就是第 4 条的直接证据。

## 3. 写入点清单（`src/`）

| 写入点 | 路径 | 旧行为 |
|---|---|---|
| `mergeStickerLibrary` | QQ 收藏同步（每几分钟一次） | 末尾 dedupe，但写的仍是「内存整表」 |
| `collectSticker` | 群聊/观察群收集（`qq_collect_sticker`、观察学习） | push 后交调用方 save，不去重 |
| `backfillStickerMd5` | md5 回填（缩略图修复/首次下载） | 只改一条的 md5，不触发合并 |
| `applyStickerNote` / `setStickerPolicy` / `removeSticker` | 面板写操作 | 改完直接 save |
| `POST /api/stickers/*` | 控制台接口 | 同上传入数组 |

## 4. 修复（`src/sticker-lib.js`，全部幂等）

1. `dedupeStickerEntries` 键优先级：**md5 → emojiId → id/resId → url(去 query)**；
2. 追加 **dhash 第二轮**：dhash ≥ 8 位且相同、md5 不同 → 合并（保留信息最丰富那条，合 tags/localNote/usage/useCount）；
3. `normalizeStickerEntry` 保留 `emojiId`；
4. **`saveStickerStore` 写盘前统一 dedupe** —— 一处护栏覆盖全部写入口；
5. `mergeStickerLibrary` 先 dedupe 现有与 fetched 两份输入。

`scripts/dedupe-stickers.mjs` 改为直接复用 `dedupeStickerEntries`（脚本与运行时一套规则），并打印 md5 / emojiId / url / dhash 四类重复组；`--apply` 前自动备份。

## 5. 线上清理

```
备份：state/stickers.json.bak-dedupe-2026-10-26T09-14-13-541Z（135,709 字节）
前：164 条 → 后：163 条（合并 1 条 dhash 重复；保留带备注「一般用在围观、旁观」的那条）
thumbStatus=missing：本次 0 条（当前库里没有不可恢复条目；脚本与去重函数都保证唯一条目不会被删）
```

> 注：此前记录的两条 `thumbStatus:"missing"` 条目（`c_f9aa32bc4ed5`、`c_4976cf36a7ea`）已不在当前库中（可查更早的 `.bak-*` 备份）；本次清理未删除任何 missing 条目。

**重启提示**：桥接内存里仍是 164 条，下一次收藏同步会把 164 写回（旧代码无写盘去重）。请在方便时重启一次桥接，让 `saveStickerStore` 的新护栏生效；重启后 sync 日志应稳定在 163，不再横跳。

## 6. 测试

`scripts/test-sticker-dedupe.mjs` → **16 项全过**：

- 原 UI 8 项（92→84、备注/标签不丢、可发优先、幂等、接口 404/成功）
- 新增 lib 8 项：同 md5 合并保 cache/备注/tags；幂等；同 emojiId 合并；同 dhash 不同 md5 合并；dhash 短于 8 位不合并；`saveStickerStore` 写盘前去重；url 去 query 合并；**missing 唯一条目不被删**

无回退：`test-sticker-thumb` 20、`test-sticker-thumbs` 20、`test-console-static` 全过、`test-console-failpaths` 181。

## 7. 怎么防止再发

1. 所有写入口只走 `saveStickerStore`（已强制去重）；
2. 新增采集路径必须写 `dhash`（本地 `.img` 可现算），否则重编码图仍会被当新图；
3. md5 回填后不需要手动合并，下次 load/save 自动折叠；
4. 定期 `node scripts/dedupe-stickers.mjs --file <stickers.json>` 看报告；`--apply` 才写盘且自动备份；
5. 排查时先看 `[sticker] 已同步…（本地库 N 条）` 是否横跳 —— 横跳就是写盘没去重。
