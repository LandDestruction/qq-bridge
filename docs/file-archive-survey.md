# 群文件转存 / 观察学习 —— 阶段 1 调研简报（施工 C）

> 口径：**只有「我实际读过运行时源码/配置文件」的才标「实测」**，其余标「推断」。
> 本项目没有在施工树里起桥接（COLLAB §3/§5），所以**没有**真机收发过群文件；下面每条都标了证据位置。

## 1. 桥接现在能不能收到「群文件上传」？

**能，走 OneBot `notice` 的 `group_upload`。这条是实测确认的，不是推断。**

证据（SnowLuma 运行时源码 `C:\SnowLuma\index.mjs`，2026-10-25 本机读取）：

| 位置 | 内容 |
|---|---|
| `index.mjs:18452-18464` | `function convertGroupFileUpload(ctx, event)` → `notice(ctx, event, { notice_type: "group_upload", group_id: event.groupId, user_id: event.userUin, file: { id: event.fileId, name: event.fileName, size: event.fileSize, busid: event.busId } })` |
| `index.mjs:18577` | `CONVERTERS` 表里 `group_file_upload: convertGroupFileUpload` |
| `index.mjs:32326` | `EVENT_PIPELINE` 里 `group_file_upload: { handle: convertOnly }`（convertOnly → convertAndDispatch，转成 OneBot 事件下发给 WS） |
| `index.mjs:6141/6150` | 事件分类注释里明确列了 `group_file_upload`，对应 `case "group_file_upload"` |

**下发字段（实测自转写函数）**：

```json
{
  "time": 0, "self_id": 0, "post_type": "notice",
  "notice_type": "group_upload",
  "group_id": 0,
  "user_id": 0,
  "file": { "id": "", "name": "", "size": 0, "busid": 0 }
}
```

注意与 `get_group_root_files` 的差异：notice 里文件字段叫 `id`，**不是** `file_id`；`size` 不是 `file_size`。

桥接侧现状（实测 `src/bridge.js:14945`）：只订阅了 `bot.onNotice('notify', …)`（拍一拍）。
SDK 支持按类型订阅（`node_modules/@snowluma/sdk/dist/client/websocket-client.d.ts:45-46` 的
`onNotice(type, handler)` 重载），所以加 `bot.onNotice('group_upload', …)` 即可，**不需要改 SnowLuma**。

**兜底路径（也是实测的接口，不是猜的）**：`get_group_root_files` 可定时拉列表。

## 2. 下载一个群文件要什么

1. `get_group_file_url`（`index.mjs:9173-9192`）
   - 入参：`group_id`、`file_id`，可选 `busid`（`busidOr102(raw)`，默认 102）
   - 出参：`{ url }`，schema 只声明了 `url` 一个必填字段
   - 实现：`ctx.bridge.apis.groupFile.getUrl(groupId, fileId, busId)`
2. URL 是**带 rkey 的临时直链**（`composeGroupFileUrl` → `https://{downloadDns}/ftn_handler/{hex}/?fname={fileId}`）。
   - 响应里**没有**显式 TTL 字段 → **推断**：拿到后应立即下载，不要缓存 URL 跨任务使用；
   - 文件本身的过期时间是 `dead_time`（列表接口返回），不是 URL 的 TTL。
3. 大小/鉴权：
   - **没有**在 `get_group_file_url` 的 schema 里看到任何上限或鉴权参数（实测）；
   - 直链请求是否需要 cookie —— **未实测**（施工树不能连真实群发文件），因此实现里下载失败要有可读日志、
     且走 `safe-fetch` 的 SSRF 校验与字节上限，失败就记 `failed`，不阻塞后续事件。
4. 其它可用动作（`_snowluma-catalog.json` + 源码实测存在）：`get_group_root_files`、
   `get_group_files_by_folder`、`get_group_file_system_info`、`trans_group_file`、
   `delete_group_file`、`move_group_file`、`rename_group_file`、`download_file`、`upload_group_file`。
   **我们只用只读的三个**：`get_group_root_files`（补漏）、`get_group_file_url`（取直链）、本地写盘。

## 3. 现有模块能复用什么

| 模块 | 能复用的 | 不能复用 / 要新建的 |
|---|---|---|
| `src/message-db.js` | `openMessageDb` 的连接/PRAGMA 风格；`state/messages.db` 已有 WAL | **没有文件台账表** → 新建 `file_archive` 表（同库，`ensureFileLedger(db)`） |
| `src/storage-stats.js` | `collectStorageStats` 已统计 state/ 各项（加 `state/files` 目录即出现在 top 里）；`diskFree` | 不能统计「文件台账条数/可清理字节」→ 台账自己出 `/api/files/stats` |
| `src/media-queue.js` | 并发闸门（1~4） | 群文件下载/分类不是媒体管线，**不共用队列**，避免相互阻塞 |
| `src/safe-fetch.js` | `validateFetchUrl`（SSRF，禁内网/环回）、`requestOnce`（按字节预算读、多地址重试）、重定向逐跳校验 | `safeFetchBuffer` **只收图片**；新增 `safeFetchBinary`（通用二进制+字节上限），落盘由调用方做 |
| `src/sticker-lib.js` | `collectSticker(entries, info)` → 写**本地学习库**（`policy: understand-only`，不动 QQ 账号） | `collectStickerV2` 会 `add_custom_face` 改 bot 账号 → **观察群禁用**，只用本地库 |
| `src/slang-learner.js` / `feedSlangWindow` | 群聊文本进滚动窗口 → 黑话候选提取链路 | 观察群要能喂窗口但**不触发 AI 回复**；`handleIncoming` 的白名单早退发生在记录之前，需在 `onGroupMessage` 层分流 |

## 4. 结论与下一步

- 事件入口确定：`bot.onNotice('group_upload')`；兜底 `get_group_root_files` 定时补漏（第一批只做事件入口，补漏留阶段 3）。
- 落盘：`state/files/<群号>/<YYYY-MM>/<原文件名>`，重名加 ` (1)`；元数据入 `state/messages.db` 的 `file_archive` 表。
- 观察学习：在 `onGroupMessage` 最前分流 —— 命中观察群就 `feedSlangWindow` + `collectSticker`（本地学习库）后 return，
  不进入 `handleIncoming`（因此不会唤醒、不会回复、不会扣额度），日志明确写「观察群只学习不发言」。
- 未解决/待确认：
  1. 观察群里「@机器人 / 被引用」要不要回 —— 当前按「不回」实现，注释里标记待确认；
  2. 群文件直链是否需要 cookie/Referer —— 未实测，失败时日志会带 HTTP 状态码；
  3. 自然月 vs 30 天：按任务书用 30 天/月折算（60/120 天），若要自然月需另说。
