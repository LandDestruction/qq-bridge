# 交接｜施工 C 第四批：图片也转存 + 每轮「转存结果」事实 + 观察群表情补全

分支 `feat/file-archive`。本文把**实测**与**推断**分开写。

## 一、两个现象的结论

### 1) 「转存一下这张图片」→ 台账零条，机器人却说存好了

**实测（读线上 state/messages.db + code）**

- 20:19:26 那条是 `[引用图片] 转存一下这张图片`：当前消息里**没有 image 段**，图片在**被引用的那条消息**里。
- 转存链路此前只覆盖：`group_upload` 事件、当前消息的 `file` 段。**image/media 完全不在转存范围**，
  引用消息里的附件也没有任何处理。所以台账当然是 0。
- 机器人会“编成功”，是因为上一批只注入了**静态能力说明**（`archiveCapabilityHint`：
  「群友上传的群文件、聊天里发的文件都会自动保存」）。模型据此推断“我说过会自动存 = 已存”，
  没有事实校验。**这比不转存更糟**，本批加了硬闸门（见 B）。

### 2) 观察群 100000005 的表情没进库

**实测（读线上 state/stickers.json）**：不是“一条都没收”，而是**收了 1 条但按 source 查不到**：

```
{"id":"c_ICSzQu1u49HHI8uuN3Ay7Idw","source":"qq","collectedFrom":"观察群 100000005",
 "collectedBy":"我是狗妈老公","md5":"","url":"https://multimedia.nt.qq.com.cn/download?...rkey=...",
 "createdAt":"2026-10-25T12:20:39.321Z"}   ← 20:20:39 本地时间，正是那条观察群消息
```

- 根因一：`src/sticker-lib.js` 的 `normalizeStickerEntry` 把 source 一律归一成 `qq|manual|ai`，
  所以按 `source` 过滤永远是 0 —— 只能翻 `collectedFrom`。
- 根因二（**推断**，依据 SnowLuma 的段映射 + 那条 entry 有 url 才成功的形态）：
  QQ 表情在网关里常常是 `image` 段但 `url` 为空（只有 `file`），或 `face` 段只有 `id`。
  `planObserveLearning` 原来 `if (!url) continue` 直接跳过，**且不留日志**。
- 本轮修了这两点（见 C），并加诊断日志以便下一轮用真实形态验证。

## 二、改了什么

### A. 图片/表情纳入转存（白名单群；观察群永不落盘）

- `src/file-archive.js`
  - `findActiveArchiveBySha(db,{groupId,sha256})`：图片按**内容**去重（同一张连发两次只存一份）。
  - `archiveImageAttachment({db,rootDir,groupId,buffer,fileName,fileId,mimeType,...,maxBytes})`
    → `{status:'ok'|'dup'|'skipped'|'failed', name, bytes, id?, reason?}`；
    落盘规则与 file 段完全一致（`<群号>/<YYYY-MM>/`、`.tmp`→rename、sha256、60/120 天），
    台账 `category='image'`、`category_source='media'`、`source='image'`。
- `src/bridge.js`
  - `resolveMediaList(mediaList, key)` 新增 `key`：媒体管线**已经**为“给模型看图”下载到 buffer，
    这里直接复用这份 buffer 转存，**不二次下载**。
  - `archiveMediaAttachment(key, media, buffer, index, mimeType)`：白名单群才落盘；
    非白名单群只记一条 fact（`该群不在文件保存白名单`）；观察群直接跳过（双保险，
    观察群本来就在 `onGroupMessage` 最前分流）。
  - **引用消息里的附件也转存**：`resolveReplyInfo` 现在带出 `fileSegments` 与 `media`
    （各最多 3 条，不缓存完整原始消息）；`handleIncoming` 检测 reply 段 → 转存被引用消息里的
    文件（`archiveChatFileSegments`）与图片/表情（`fetchOneBotImage` + `archiveMediaAttachment`）。
    这条正是这次实测失败的那条路径。

### B. 每轮注入「转存结果」事实，不许模型编

- 新增 `formatArchiveFactsBlock({isWhitelisted,facts})`（`src/file-archive.js`）：
  - 有成功：`【本轮转存结果】本轮已转存 1 个附件：a.png（12.0 KB，台账 id=7）`
  - 有重复：`本轮附件已在本地（未重复转存）：old.zip（台账 id=3）`
  - 有失败/超限：`本轮附件未转存：big.zip（213.0 MB 超过 200 MB 上限）`
  - 一个都没有：`本轮没有可转存的附件（这条消息里没有文件/图片，或该群不在白名单）。`
  - 结尾硬句：`只有上面写了「已转存」才可以说存好了；否则必须如实说没存。文件内容你看不到，不要假装读过或猜内容。`
- `src/bridge.js`：`archiveFactsByKey: Map<key, fact[]>`（有界 20 条）+ `pushArchiveFacts`；
  `withArchiveFactsHint(key, promptText)` 取代 `withArchiveCapabilityHint`，在两处 prompt 投递点
  （一代/二代）各注入一次，注入后清空该 key 的 fact。文件段、图片、引用附件都汇入同一批 fact。
- `archiveChatFileSegments` 返回值新增 `facts`（ok/dup/skipped/failed）。

### C. 观察群表情收集补全 + 诊断

- `src/observe-learn.js`
  - `planObserveLearning`：**不再要求 url**。image/mface/face 段都收，附带
    `{url, md5, file, faceId, type, summary}`；32 位 hex 的 `file` 当 md5。
  - 新增 `describeObserveStickerSegments(event)`：只给 `{type, hasUrl, hasFile, filePrefix(32), faceId}`，
    **绝不含完整 url**（url 里有 rkey，落日志就是泄露）。
  - `applyObserveLearning` 改为 async（允许 hook 异步取字节），逐个 `await hooks.collectSticker`。
- `src/bridge.js`
  - `logObserveStickerShapes`：每群每小时最多一行，格式
    `观察群 <gid> 表情段形态：image(url=no,file=ABCD...,face=-) | face(url=no,file=-,face=13)`。
  - `collectObserveSticker`：md5 → 直接入库；否则 url → 入库；都没有 → `fetchOneBotImage` /
    `fetchFaceMedia` 拿字节，**自己算 md5**，原图落 `state/sticker-files/<md5>.img`，再入库；
    仍拿不到 → `观察群表情未捕获：段缺少 url 且 file 不可解析（群 …, type=…, file=前32字符）`。
  - `observeLearnFromGroupMessage` 改为 async，调用点 `await`。
- `src/sticker-lib.js`：`source` 保留 `观察群 <数字>`（不再一律归一成 qq），便于按 source 验收查询；
  `collectedFrom` 照旧写。

### D. 顺带回答：`feedSlangWindow` 是内存还是落盘？

**结论：黑话窗口是纯内存（`slangWindows = new Map()`），进程重启即丢**（每群最多 80 条未抽取的消息）。
已抽取、已确认的词条走 `saveSlang()` 落盘（`state/slang*.json`），那部分不丢。
**未改**：要不要给窗口做持久化会影响状态文件结构与清理策略，留给你决定（不做也能跑，只是重启后
丢失最近一小段学习素材）。

## 三、验证（全部绿）

```
node --check src/{bridge,file-archive,observe-learn,sticker-lib}.js      通过
node scripts/test-chat-file-archive.mjs   20/20（新增 facts 四态、图片落盘/去重/超限、事实块文案）
node scripts/test-observe-learn.mjs       14/14（新增无 url 段进计划、异步 hook 失败、source 保留、诊断不含 url）
node scripts/test-file-archive.mjs        全部通过
node scripts/test-observe-learn.mjs / test-audit-bridge / test-storage-card /
     test-media-queue / test-archive / test-safe-fetch-bounded               全绿
```

## 四、线上怎么验收（需审阅重启）

1. 重启后，请用户在 100000001 **直接发一张图片**（不要引用）：
   - 日志应出现 `图片已转存：群 100000001「图片-1.png」…（台账 #N）`；
   - `/api/files/stats` 的 `files.active` +1，`state/files/100000001/<年月>/图片-1.png` 存在；
   - 问机器人「图片存了吗」→ 应说「存到本地了，台账 id=N，但我没读内容」。
2. 再**引用一张图片**说「转存这张」：同样应落盘（引用路径已接）。
3. 引用一个 zip 说「转存」：应落盘并给出台账 id（这条之前完全没处理）。
4. 观察群（100000005）发 2~3 个表情后：
   - 日志出现一行 `观察群 100000005 表情段形态：…`（说明真的是哪种形态）；
   - `state/stickers.json` 里 `source` 能被 `观察群 100000005` 直接查到；
   - 若日志出现 `观察群表情未捕获：…`，把那行原文发我，按真实形态再补获取路径。
5. 机器人若回答“没存”，必须能在上一条日志/台账里找到 **未转存原因**（不许无据编造）。

## 五、已知限制 / 风险

- **图片转存发生在「给模型投递 prompt」那一刻**（复用媒体管线的 buffer）。若某个白名单群消息
  因为静默/未唤醒而没有投递，图片不会落盘；事实块会如实说“本轮没有可转存的附件”，不会撒谎。
- 引用消息只解析**最近 3 条** file 段 / 3 个媒体（防极端消息撑爆）；超出部分不转存但仍有日志。
- 非白名单群也会收到“本轮没有可转存的附件/该群不在白名单”的事实块（每轮约 40 token），
  这是为了彻底堵住“没存却说存了”。
- 观察群表情缓存落 `state/sticker-files/<md5>.img`，不参与 60/120 天清理（表情库属于长期学习数据）。
- 未做：图片/表情的 OCR 或内容理解（模型本来也看不到文件的“内容”，提示里已写死不许假装读过）。

## 六、待确认

1. `state/sticker-files` 的表情缓存要不要也纳入容量治理（目前无上限）。
2. 黑话窗口要不要持久化（当前内存，重启丢窗口）。
3. 观察群表情的 `face` 段走 `fetchFaceEntity`，若网关不支持会一直失败；诊断日志能第一时间看出来。
