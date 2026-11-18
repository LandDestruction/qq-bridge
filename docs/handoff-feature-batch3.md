# 交接｜施工 C 第三批：单文件上限提到 2.5G（含流式落盘）

分支 `feat/file-archive`。需求：**单文件 2.5G**（原默认 200MB、硬上限 1024MB 太小）。

## 关键结论：只改数字会 OOM

原来的下载路径 `safeFetchBinary()` 会把整个响应体读进内存（`Buffer.concat`），
2.5GB 单文件必然撑爆 Node 堆 → 进程被守护重启，还可能在 `state/files` 留下半截文件。
所以这批同时换了下载实现：**边下边写盘、边算 sha256，内存占用恒定**。

## 改了什么

- `src/file-archive.js`
  - `MAX_FILE_MB = 2560`（2.5 GiB，按 2560MB 算），`DEFAULT_MAX_FILE_MB = 2560`：
    不配 `maxFileMb` 时默认就是 2.5G，配置值超过 2560 会被夹到 2560。
  - 拆出 `allocateArchiveTarget()`：下载**前**先占好目录/不重名文件名/临时路径。
  - 新增 `storeDownloadedFile()`：接收已写好的临时文件 + 字节数（+ 可选 sha256），
    没给摘要时用 `sha256OfFile()` 流式计算，然后统一 rename + 记账。
  - `storeArchivedFile()`（buffer 路径）改为复用同一套 `allocateArchiveTarget` + finalize，行为不变。
  - `archiveChatFileSegments()` 优先用 `deps.downloadToFile`（流式）；没有才退回 buffer 实现。
    超限截断会删掉半截临时文件，不记账。
- `src/safe-fetch.js`
  - 新增 `safeFetchToFile(url, destPath, maxBytes)`：逐跳 SSRF 校验 + 固定 Host/SNI + 多地址重试；
    响应体直接 `pipe` 进 `createWriteStream(flags:'wx')`，边写边算 sha256；
    超过 maxBytes 立即断开、删除半截文件并返回 `truncated=true`；
    时限口径改为「**空闲 120s** 超时 + 总上限 3 小时」（2.5G 不可能 20 秒下完）。
- `src/bridge.js`
  - 群文件上传事件（notice）改为 `allocateArchiveTarget → safeFetchToFile → storeDownloadedFile`。
  - 聊天文件段的 deps 增加 `downloadToFile`（保留 `download` 兜底）。
  - 启动日志的「单文件上限」改成人类可读（`2.5 GB（2560MB）`）。
- `config.example.json`：`fileArchive.maxFileMb` 200 → **2560**。

## 验证

```
node --check src/file-archive.js src/safe-fetch.js src/bridge.js          通过
node scripts/test-chat-file-archive.mjs                                  17/17（新增 4 项流式用例）
node scripts/test-safe-fetch-bounded.mjs                                 10/10（新增 2 项入口守卫）
node scripts/test-file-archive.mjs                                       全部通过（默认/夹取改 2560）
node scripts/test-observe-learn.mjs / test-audit-bridge / test-storage-card /
     test-media-queue / test-archive                                      全绿
```

新增用例：
- `downloadToFile` 写目标临时文件 → 成功后改名、目录里只剩正式文件、台账 `bytes/sha256/source=chat`；
- 流式超限截断 → 半截文件被删除、0 行台账、说明含「超过 1.0 MB 上限被截断」；
- 下载器没给字节数 → 判失败并清理临时文件（不留空文件）；
- `storeDownloadedFile` 未给 sha256 时流式计算，摘要与落盘内容一致；
- `safeFetchToFile` 拒绝 `file://` 与 `127.0.0.1`，且不创建目标文件。

## 线上怎么验收（需审阅重启）

1. **`config.json` 里 `fileArchive.maxFileMb` 目前是 200（显式值），不改就一直只有 200MB。**
   请审阅把它改成 `2560`（或删掉这个键，默认即 2560）后重启。
2. 启动日志应显示：`单文件上限 2.5 GB（2560MB）…`。
3. 发一个 **300MB 左右**的文件（先别直接上 2.5G）：
   - 日志 `聊天文件已转存：…`，`state/files/100000001/<YYYY-MM>/` 出现文件；
   - 观察 Node 进程常驻内存**不应**随文件大小暴涨（这是本批的核心验证点）；
   - `sha256` 在台账里有 64 位十六进制。
4. 再发一个超过 2560MB 的文件：应看到「未转存：…超过 2.5 GB 上限」且不落盘。
5. 中断下载（断网/取消）后检查 `state/files` 里不应残留 `*.tmp-*` 文件（超限路径会主动删；
   进程被强杀时可能残留，属于已知项，见下）。

## 已知风险 / 回滚

- **未真机验证**：`safeFetchToFile` 的真实网络下载没有离线测（SSRF 校验会拒绝 localhost，
  离线起不了可下载的假服务）。上线后用 300MB 文件验证内存与落盘表现。
- 2.5G 单文件会占用磁盘直到保留期（未分类 60 天）；`/api/files/stats` 的 `activeBytes`
  与存储卡能看到占用，但**没有磁盘余量预检**（写满会抛错并留在日志里）。
- 下载**不支持断点续传**：失败会从头再来；单次空闲 120s 无数据判超时，总上限 3 小时。
- 进程被强杀时可能残留 `*.tmp-*`；不影响台账（没有对应记录），可手工清理，
  后续可加启动时清理（未做）。
- 回滚：`git revert` 本提交；旧代码不认识 `*.tmp-*` 也不影响（台账未引用）。
