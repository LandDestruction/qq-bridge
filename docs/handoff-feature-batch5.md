# 交接｜施工 C 第五批：转存范围收窄（只图片 + 压缩包）+ 上限 2.5GB + 真流式落盘

分支 `feat/file-archive`。用户拍板（原话要点）：「只转存图片和压缩包，不要将表情包纳入转存，
并且单个文件的转存上限应设置为 2.5G」。

## 一、改了什么

### 1) 显式类型白名单（`src/file-archive.js`，可单测的纯函数）

```js
export function shouldArchiveAttachment({ kind, segType, fileName, emojiId, subType })
export function describeArchiveSkip({ fileName })   // → "类型不在转存白名单（.mp4）"
```

| 来源 | 结果 |
|---|---|
| `image` 段 / `media.kind==='image'` | ✅ 转 |
| `file` 段 + 压缩包扩展名（zip rar 7z tar gz tgz bz2 xz zst，大小写不敏感） | ✅ 转 |
| `file` 段 + 图片扩展名（jpg jpeg png gif webp bmp heic） | ✅ 转 |
| `face` / `mface` 段，`media.kind` 为 `face`/`sticker` | ❌ 绝不转 |
| image 段但带表情标记（`emojiId` 或 `subType==='1'`） | ❌ 判不准就不转 |
| 其它（mp4/mov/pdf/docx/txt/mp3…） | ❌ 跳过并留日志 |

应用位置：
- 聊天 `file` 段：`archiveChatFileSegments` 里先过滤，**不满足就不下载**，产出
  `facts`（status=skipped，原因带扩展名）与 `deps.logSkip` 日志；
- 群文件上传事件（`handleGroupFileUpload`）：先 `shouldArchiveAttachment`，跳过时
  `logArchiveSkip('group:<gid>', 文件名, 原因)`；
- 图片/表情（媒体管线 buffer）：`archiveMediaAttachment` 对 `face`/`sticker` 直接 return（并记一行折叠日志），
  `archiveImageAttachment` 内部再挡一次（表情标记 → skipped）。
- 跳过日志**同类每小时折叠一行**（`archiveSkipLoggedAt`），既不刷屏又能查「发了却没存」。

### 2) 上限 2.5GB + 真流式落盘

- `MAX_FILE_MB` / `DEFAULT_MAX_FILE_MB` = **2500**（2.5GB；配置超过会被夹到 2500）。
- `src/safe-fetch.js` 新增可单测的 `streamBodyToFile(body, destPath, { maxBytes, timeoutMs })`：
  - 逐块消费响应体（async iterator / web stream 都支持），**边写边计数、边 `sha256.update`**，
    绝无 `Buffer.concat` 整段；
  - 越界立即停止：主动 `iterator.return()` 断开、关写流、删 `.tmp`，抛 `code='ARCHIVE_TOO_LARGE'`（带已写入字节数）；
  - 空闲超时（`timeoutMs`，每来一块重置）、写盘错误、中断都在 `finally` 清理临时文件。
- `safeFetchToFile(url, destPath, { maxBytes, timeoutMs })`：逐跳 SSRF 校验、Host/SNI 固定、
  多地址重试不变；写盘委托给 `streamBodyToFile`；返回
  `{ url, statusCode, bytes, sha256, contentType, truncated }`（超限时 `truncated=true` 且 tmp 已删）。
  兼容旧的数字第三参（`safeFetchToFile(url, dest, maxBytes)`）。
- `handleGroupFileUpload` 与聊天 `file` 段都走 `safeFetchToFile(...{maxBytes})`；
  台账的 `bytes/sha256` 直接取返回值，不再自己算。
- `src/bridge.js` 的 `fileArchiveDeps().downloadToFile` 已改为对象参数，并新增 `logSkip`。

### 3) 配置

- `config.example.json`：`fileArchive.maxFileMb` = **2500**，并加
  `_comment_archiveTypes` 说明「只转存图片（…）与压缩包（…）；表情包与其它类型一律不转存」。
- **线上 `config.json` 没动**（按你的要求由你改+重启）。

### 4) 上一批的两件事（同批保留）

- 每轮事实块（`formatArchiveFactsBlock`）：已转存/已存在/未转存+原因/无附件，硬句
  「只有写了「已转存」才可以说存好了」。
- 观察群表情：无 url 时走 `fetchOneBotImage`/`fetchFaceEntity` 拿字节、算 md5、落
  `state/sticker-files` 再入库；失败留 `观察群表情未捕获：…`；段形态诊断日志不含完整 url；
  `source` 保留 `观察群 <群号>`。

## 二、验证（全绿）

```
node --check src/{file-archive,safe-fetch,bridge,observe-learn,sticker-lib}.js   通过
node scripts/test-chat-file-archive.mjs   24/24
node scripts/test-file-archive.mjs        18/18
node scripts/test-observe-learn.mjs       14/14
node scripts/test-safe-fetch-bounded.mjs  10/10
node scripts/test-audit-bridge.mjs        全 PASS
node scripts/test-storage-card.mjs        31 项
node scripts/test-media-queue.mjs         通过
node scripts/test-archive.mjs             21/21
config.example.json JSON.parse            通过
```

新增断言（本批）：
- **类型矩阵**：image 段 / zip / RAR 大写 / 7z / tar.gz / jpg-as-file / `kind=image` → ✅；
  face / mface / `kind=face` / `kind=sticker` / 带 `emojiId` / `subType=1` / mp4 / pdf / docx / txt / 无扩展名 → ❌。
- **类型过滤行为**：mp4+pdf+zip 混在一条消息里 → `download` 只调用 1 次（仅 zip）、台账只有 zip、
  两条 skipped fact、`logSkip` 逐条触发、annotation 写「未转存：类型不在转存白名单（.mp4）」；
  face+mface 消息 → `download` 0 次、facts 0、archived 0。
- **流式超限**：假响应体 4×1KB、上限 1500 → 只拉到第 2 块就中止（`pulled=2`）、
  `iterator.return` 被调用、抛 `ARCHIVE_TOO_LARGE` 且 `bytes=1024`、`.tmp` 已删。
- **流式成功**：两块共 6 字节 → 落盘内容正确、`sha256` 64 位、`bytes=6`（分块消费，未整块读）。
- 既有：流式 `downloadToFile` 落盘/截断清理、`storeDownloadedFile` 流式算摘要、图片 sha256 去重、
  事实块三态文案、旧台账 `source` 列迁移、观察群 0 下载。

## 三、线上怎么验收（等你改 config + 重启）

1. `config.json`：`fileArchive.maxFileMb` 改 `2500`（或删该键，默认即 2500）；重启，
   启动日志应显示 `单文件上限 2.5 GB（2500MB）`。
2. 在 100000001 发一个 **zip**（几十 MB 即可）：日志 `聊天文件已转存…`，台账有 bytes/sha256；
   发一个 **mp4**：日志 `转存跳过（group:100000001）：v.mp4 —— 类型不在转存白名单（.mp4）`，
   台账零条，问机器人它会说没转存（事实块里是 skipped + 原因）。
3. 发一张 **图片**：落盘 + 台账 id；发一个 **表情**：不落盘、不产生图片台账（跳过日志每小时一行）。
4. 发一个 **>2500MB** 的文件：应被拒绝、`.tmp` 不残留、日志明确说超限；
   同时观察 Node 常驻内存不随文件大小上涨（核心验收点）。
5. 观察群（100000005）发 2~3 个表情：`state/stickers.json` 里 `source` 可查到
   `观察群 100000005`；若日志出现 `观察群表情未捕获：…` 把那行原文给我。

## 四、已知限制 / 风险

- 流式下载没有真实网络单测（SSRF 拒绝 localhost，离线起不了可下载的假服务）。
  `streamBodyToFile` 的「分块消费 + 越界中止 + 删 tmp」已经用假响应体钉住；
  `safeFetchToFile` 本体只有入口守卫测试（拒绝 file:// 与 127.0.0.1）。上线 300MB 实测最关键。
- 2.5GB 单文件仍然没有磁盘余量预检；不支持断点续传（失败从头再来，空闲 120s / 总 3h 上限）。
- 表情包缓存 `state/sticker-files` 无容量上限（观察学习数据，暂不清理）。
- 图片转存发生在「给模型投递 prompt」那一刻（复用媒体 buffer）；没投递的消息不落盘，
  但事实块会如实说没有附件——不会谎称已存。
