# 归档系统升级（M6）状态：P0 / P1 / P2 到哪了

> 规格：`M6-archive-upgrade-spec.md`（default-workspace）。参考笔记：`VRChat 素材库实现笔记.md`。
> 硬约束：真库只读、写操作只在副本/临时目录、不重启桥接、不动 config、不改 BOOTH 凭据。

## 1. 批次状态

| 批次 | 内容 | 状态 | 证据 |
|---|---|---|---|
| P0 | contentKey / 规则版本号 / 原子写+ownWrites / fileOpsMu / 路径校验 | ✅ 完成 | D23，`test-archive-contentkey` 18/18、`atomic` 11/11、`lock` 13/13、`path` 18/18 |
| P1 | 回收站 / ZIP 目录表 / 重复判定 / 缩略图信号量 / mtime 增量 | ✅ 完成 | D28，`p1-recycle` 12/12、`p1-zip` 12/12、`p1-maintain` 15/15 |
| P2-11/13/16 | 全局暂停 `pausedUntil` / 说明文件 sidecar / 任务断点落盘 | ✅ 完成（未接线） | D31，`p2-pause` 28/28、`p2-progress` 26/26、`p2-sidecar` 32/32 |
| P2-12/14 | Range 断点续传 / 封面 dHash（阈值 10） | ✅ 完成（未接线） | 本批，`test-archive-p2-transfer` 13/13 |
| P2-15 | 控制台权限表化（未登记默认 admin） | ✅ 已由现有全局闸满足 | `src/bridge.js:5009-5018`：带 `x-agent-token` 的请求只放行 `/api/status`、`/api/socialV2/*`、`/api/send/*`、`/api/images/*`、`/api/authorize/read`，其余一律 403「该接口仅控制台可用」。`test-affinity-endpoint` 的 8/8 里有两条实证 |

## 2. 本批新增能力（`src/archive-p2.js`）

- `downloadFileResumable({ url, destPath, tempDir, fetchRange, maxBytes, maxRetries })`
  - 只有收齐才 `rename` 到目标文件；中断保留 `.part`，下次从 `Range: bytes=N-` 接着传。
  - 强校验器：`ETag` / `Last-Modified` 变了就丢弃旧分片重下（`If-Range` 由 `resumeFetchHeaders` 生成）。
  - 服务器忽略 Range 回 200 时**从头写**，绝不追加（防 `abc` + `abcdef` 拼坏）。
  - 416：本地分片已等于总大小 → 直接落盘；对不上 → 丢弃重来一次。
  - 有限重试（默认 3 次，指数退避、可注入 `sleep`）；429/5xx 才重试，404 直接失败。
  - `maxBytes` 超限立刻抛错，不产生目标文件。
  - **网络层由调用方注入** `fetchRange`：生产端应复用 `src/safe-fetch.js` 的 SSRF 校验，别在归档模块里自己开 socket。
- `sameCover(a, b, { threshold = 10 })`：复用 `src/image-hash.js` 的 9×8 dHash 与 `hammingDistance`，
  但阈值与表情（1）**不共用**；无效/空 hash 一律判不同（不知道就不合并）。
- `parseContentRange` / `resumeFetchHeaders`：纯函数，便于单测与复用。

## 3. 还没做的（明确写出来，别当已完成）

1. **接线**：`archive-p2.js` 目前是「能力 + 纯函数」，没有接进 `file-archive.js` 主流程：
   - `deps.downloadToFile` 仍走 `safeFetchToFile`（无 Range）；要用续传需先给 `safe-fetch.js` 加 Range 支持，
     或在 bridge 里用 `safeFetchToFile` 校验 URL 后注入 `fetchRange`。
   - 暂停/断点/sidecar 的触发点（何时 `recordArchiveHttpFailure`、何时 `markTaskItem`、商品资料何时写回）
     也还没接。
2. **dHash 落库**：`file_archive` 还没有 cover_dhash 列；要先加列 + 回填，才谈「同图合并」。
3. 控制台展示：「本次跳过 N 条旧结论 / 全部重来」按钮（P0 的后端能力已有，UI 未做）。
4. 真库写操作：按规格要求，动 `E:/booth-inbox` 或台账前先报主窗口。

## 4. 怎么验证

```powershell
node scripts/test-archive-contentkey.mjs   # P0
node scripts/test-archive-atomic.mjs
node scripts/test-archive-lock.mjs
node scripts/test-archive-path.mjs
node scripts/test-archive-p1-recycle.mjs   # P1
node scripts/test-archive-p1-zip.mjs
node scripts/test-archive-p1-maintain.mjs
node scripts/test-archive-p2-pause.mjs     # P2
node scripts/test-archive-p2-progress.mjs
node scripts/test-archive-p2-sidecar.mjs
node scripts/test-archive-p2-transfer.mjs  # 本批：续传 + 封面 dHash
```

以上 11 套已全部挂进 `scripts/regression-all.mjs` 的 `ARCHIVE_CORE`（D35 基线：合计约 1.5s）。
