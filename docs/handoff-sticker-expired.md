# 交接｜表情注释页「图片已失效」修复（4 张）

分支 `feat/file-archive`。线上运维面板「表情包注释」里出现 **4 张「图片已失效」**，已定位、已处理并加了防复发。

## 一、根因（实测）

线上 `state/stickers.json` 共 86 条，其中正好 **4 条**满足「显示不出来」：

```
id = c_ICSzQu1u49HHI8uuN3Ay7Idw   （4 条完全相同）
url = https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=…   （均已过期）
md5 = ""，collectedFrom = 观察群 100000005，无备注/无标签
```

两条原因叠加：

1. **id 撞车**：`collectSticker()` 旧实现用 `id = c_ + (md5 || url).slice(-24)`。多媒体下载链接
   尾部高度相似，4 张不同表情被收成**同一个 id**。
2. **缩略图只试第一条**：`/api/stickers/thumbnail` 用 `stickerEntries.find(e => e.id === id)`，
   第一条链接过期（实测返回 HTTP 400）就 502，于是同一 id 下的 4 张卡片全部显示「图片已失效」。
   而且这些条目 `md5` 为空，接口成功后也**不落缓存、不回填 md5**，所以下次继续失效。

实测证据：直接 GET 这 4 条的 url 全部 `400`（body 是 `{"ret...}` 错误 JSON）；其余 md5-less 条目
（`gxh.vip.qq.com` 的 GIF）返回 200，可正常显示。

## 二、已做的处理（都在线上 API 上完成，没有手改 state 文件、没有重启）

- 调 `POST /api/stickers/remove {id:"c_ICSzQu1u49HHI8uuN3Ay7Idw"}` 删除了这 4 条（同一 id 一次清掉）。
  - 该接口是桥接自己的控制台接口，会同步 `saveStickerStoreSafe()`，不是直接编辑 `state/stickers.json`。
  - 删除前确认过：4 条都没有备注/标签（没有任何人工注释会丢），且字节不可恢复（链接过期 + 无本地缓存）。
  - 结果：台账 86 → **82** 条。
- 复查：对剩余 **82 条**逐条请求 `/api/stickers/thumbnail` → **0 条失败**（图片全部可加载）。
- 面板刷新即可看到 4 张失效卡片消失，其余不受影响。

## 三、代码修复（防复发，`feat/file-archive`）

1. `src/sticker-lib.js`
   - `collectSticker()` 的 id 改为：有 md5 用 md5，否则用 **`sha1(url)` 前 24 位**，
     不再用 url 尾部 —— 不同链接不会再共用一个 id。
   - 新增 `md5Hex(buffer)`、`stickerCandidates(entries, id)`（同 id 全部候选）、
     `backfillStickerMd5(entries, {id, md5, url})`（只填空值且 url 必须匹配，防串图）。
2. `src/bridge.js`
   - `/api/stickers/thumbnail`：同 id 的条目**逐个候选**尝试（先本地缓存，再联网），
     成功后把字节按 md5 落 `state/sticker-files/<MD5>.img`，并把 md5 **回填进库**（`saveStickerStoreSafe`）。
     以后即使 QQ 直链过期，也能靠本地缓存长期显示。
   - 新增 `POST /api/stickers/repair`（控制台接口，默认**预演**）：
     扫描所有「无 md5」的收录表情 —— 能取到字节的算 md5、落缓存、回填（永久可显示）；
     取不到的列为 `dead`；只有 `{apply:true}` 且 id+url 都匹配时才删除该条（不会误删同 id 的其他表情）。
     返回 `{repaired, dead, failed, total}`。

## 四、验证

```
node --check src/{bridge,sticker-lib}.js                    通过
node scripts/test-sticker-repair.mjs                        5/5（新增：id 唯一、md5 回填、同 id 候选）
node scripts/test-audit-bridge.mjs                          全 PASS
node scripts/test-observe-learn.mjs / test-chat-file-archive / test-file-archive   全绿
```

线上复查：`GET /api/stickers?count=100` → total=82；逐条 thumbnail → 0 失败。

## 五、上线后建议

1. 重启后打开面板确认：表情注释页应无「图片已失效」。
2. 若以后又出现：先 `POST /api/stickers/repair {}`（预演）看 `repaired/dead` 明细，
   确认后再 `{apply:true}` —— 活的会补 md5 永久可显示，死的才会被删。
3. 已知限制：`repair` 目前只处理「无 md5」的条目（历史遗留无缓存类）。有 md5 但缓存缺失的条目，
   缩略图接口会尝试联网并回填缓存，不需要单独修。
4. 本次删除的 4 条没有任何人工注释；如果以后要删有注释的表情，建议先在面板确认或先备份
   `state/stickers.json`。
