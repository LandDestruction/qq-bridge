# 交接｜施工 C 第二批：为什么「没有存文件的功能」+ 补上聊天文件转存

分支 `feat/file-archive`。本文把**实测**和**推断**分开写；没真机跑过的一律标推断。

## 一、先给结论

### 1) 用户在群里「发文件」时，桥接实际收到的是什么？
**实测：消息事件的 `file` 段（不是 group_upload 通知）。**

证据：

- 线上消息库 `qq-bridge-src/state/messages.db`（只读打开）里，群 100000001 有一批这样的行：
  `2026-10-25T10:11:30 [文件Onyx_Hair_v1.0.zip]`、`10:12:22 [文件🩸【Assassin Duty】🩸.zip]`、
  `11:38:47 [文件9013048.zip]`、`10:09:44 [文件8644148.png]`，以及 `12:06:43` 那句
  `[引用 nice：[文件9013048.zip]]@大肥鱼小姐 转存@nice @nice`。
- SnowLuma 把 QQ 的 file 元素映射成 OneBot `file` 段（`C:\SnowLuma\index.mjs:17226-17247`）：
  `{type:'file', data:{file, file_id, file_size, name, size, id, url, file_hash}}`
  —— 同一个信息三种写法，桥接只读了 `name`。
- 桥接对它的处理：`segmentsToText` 的 `case 'file'` 只拼文本 `[文件${d.name}]`
  （`src/bridge.js` 的 segmentsToText）；`extractMediaFromSegments` 只把
  jpg/png/… 当图片、mp4/… 当视频，其余文件**直接丢掉**；`handleIncoming` 里**没有任何转存调用**。
  所以这种消息对模型来说就是一行文本，文件字节从未落盘 —— 与状态一致（`state/files` 至今不存在，
  `file_archive` 表 0 行）。

### 2) `handleGroupFileUpload`（`bot.onNotice('group_upload')`）会不会触发/静默失败？
**实测：事件注册与白名单都正常；本次一条日志都没有 → 这条链路没被触发。**
推断：QQ 里「把文件拖进聊天窗口」发的是**聊天文件消息**（file 段），
只有「上传到群文件列表」才产生 `group_file_upload` 事件；用户这次走的是前者。

实测依据：

- 线上 `config.json` 的 `fileArchive = {enabled:true, groups:["100000001"], maxFileMb:200, …}`，
  启动日志三次出现「文件保存白名单：100000001…」（`state/bridge.log` 512/539/564 行）。
- 注册点存在且失败会被 `try/catch` 记日志：`群文件转存失败：群 … 文件 …`；
  缺 `file.id`、超限、重复也各有日志。**三种日志都没有**，所以不是静默失败，是没事件。
- SnowLuma 侧 `group_file_upload → convertOnly → convertAndDispatch`
  （`C:\SnowLuma\index.mjs:32326`），下发 `group_upload` notice
  （`index.mjs:18452-18464`，字段 `file:{id,name,size,busid}`）。这段**没有真机验证过**（不重启线上）。

静默失败的风险点（已在第二批顺手加固/记录）：
- `get_group_file_url` 的 url 是不带鉴权的 rkey 直链（`index.mjs:189667` composeGroupFileUrl），
  若网关要求 cookie/Referer 会 403 —— 现在会落 `群文件转存失败：…HTTP 403` 日志，不再无声。
- 文件本身过期（`dead_time`）后拉直链会失败 —— 同样有日志。

### 3) 机器人为什么说「没有存文件的功能」？
**实测：preset 里的安全规则就是这么写的，模型说的是它视角里的真话。**

`plugins/qq-agent-presets/presets/qq-chat.patch.yml:20`（qq-chat-v2 同）：
> 1. 你只负责在 QQ 群里正常聊天……**你没有任何本地工具：不能执行命令、不能读写文件**、
> 不能启动程序、不能查看系统信息——不要假装或尝试做这些事，**工具不存在就是不存在**。

而桥接的转存**不需要模型做任何事**，所以 preset 与桥接是矛盾的：桥接在后台存文件，模型却被告知
「不能读写文件」。这个 patch 文件由 `scripts/build-agent-preset-patches.mjs` 从
`dsh/agent-presets/<preset>/` 生成（文件头写着「请勿手工编辑」），改它要动 preset 源+重装，
所以这一批采用**桥接侧提示拼接**（下一节），不改生成物。

## 二、改了什么

### 1) 聊天消息里的文件也转存（主修复）
- `src/file-archive.js` 新增：
  - `chatFileSegments(segments)`：摘出 `file` 段，兼容 `file_id`/`id`、`file_size`/`size`、`name`/`file`。
  - `storeArchivedFile({db, rootDir, …})`：**统一的**落盘+记账实现（目录 `<群号>/<YYYY-MM>/`、
    重名 `(n)`、`.tmp`+rename、sha256、分类、cleanup_at）。notice 事件与聊天 file 段都走它。
  - `archiveChatFileSegments({segments, groupId, cfg, deps})`：白名单群才动手；下载优先用段自带
    `url`，没有才回退 `get_group_file_url(file_id, busid)`（这就是「用的接口和字段」，写在注释里）；
    超限/失败/重复都返回给模型看的说明，不静默丢。
  - 台账加 `source` 列（`notice` / `chat`），并做了幂等迁移（`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`，
    不动现有数据）——线上那份 0 行的旧表在重启后会自动补列。
- `src/bridge.js`：
  - `segmentsToText` 增加 `fileNotices` 参数；`case 'file'` 优先用转存结果：
    `[文件名（已转存到本地，id=7，内容未读取）]` / `[文件名（已在本地，id=7，没有重复转存）]` /
    `[文件名（未转存：超过 200MB 上限）]` / `[文件名（转存失败：…）]`。
  - `handleIncoming` 在做文本前调用 `archiveChatFileSegments`（只对 group），成功后写日志
    `聊天文件已转存：…`，规则分类不出结果的还走原有 AI 分类。失败只记日志，**不影响这条消息照常投递**。
  - 群文件上传事件处理器改为调用 `storeArchivedFile`（同一套规则，不重复实现）。
  - 非白名单群：函数直接返回 `null` → 不下载、不记账、文本仍是原来的 `[文件名]`，行为完全不变。

### 2) 让机器人「知道自己有这个能力」
- 新增 `archiveCapabilityHint(cfg, groupId)`（`src/file-archive.js`），只对白名单群返回文案；
  `src/bridge.js` 的 `withArchiveCapabilityHint` 在两处 prompt 投递点（一代/二代）拼到末尾。
- 文案要点：本群已开启文件自动转存（群文件 + 聊天文件），**不要再说「我没有存文件的功能」**；
  用户问起如实说「已经存到本地了，但我没有读取文件内容」；不要假装读过、不要猜内容。
- **没有新增 MCP 工具**（符合要求：加工具必须重启 DSH）。
- 为什么不改 preset：`plugins/qq-agent-presets/presets/*.patch.yml` 是生成物，源头在
  `dsh/agent-presets/**`；改生成物会在下次 `build-agent-preset-patches` / 安装时被覆盖。
  桥接侧提示还能按「这个群有没有开转存」条件拼，避免在没开转存的群多付 token。

### 3) 不瞎猜
- 给模型的说明里每个成功项都带「**内容未读取**」；preset 层面的「不能读写文件」也仍未违背
  （桥接存的文件模型没有读的通道）。
- 能力提示明确要求「文件内容你看不到，不要假装读过、也不要猜内容」。

## 三、验证（全部绿）

```
node --check src/file-archive.js && node --check src/bridge.js        通过
node scripts/test-chat-file-archive.mjs                              13/13 通过（新）
node scripts/test-file-archive.mjs                                   全部通过
node scripts/test-observe-learn.mjs                                  10/10
node scripts/test-audit-bridge.mjs                                   全部 PASS
node scripts/test-storage-card.mjs                                   31 项全过
node scripts/test-media-queue.mjs                                    通过
node scripts/test-archive.mjs                                        21/21
```

新增测试覆盖（`scripts/test-chat-file-archive.mjs`）：
- 白名单群 file 段 → 调用下载、断言**下载 URL**、落盘名 `<群号>/<YYYY-MM>/a.zip`、台账 `source=chat`；
- 非白名单群 / `enabled=false` → 返回 null，**0 次下载、0 行台账、目录为空**；
- 超限（声明大小 & 实际截断两种）→ 不下载不落盘，说明含「超过 1MB 上限」；
- 幂等：同 file_id 第二次不再下载、台账仍 1 行；
- 没有 url 时回退 `get_group_file_url(file_id, busid)`，参数原样传递；
- 下载失败 → 「转存失败：文件下载失败：HTTP 403」，不落盘；
- 同名不同 file_id → `a.zip` 与 `a (1).zip`；
- 清理过（`deleted_at`）后允许重新转存；
- `chatFileSegments` 三套字段写法；`storeArchivedFile` 写 source；
- 旧表迁移补 `source` 列且幂等；
- `archiveCapabilityHint` 只对白名单群出文案。

## 四、线上怎么验收（需要审阅重启，施工不重启）

1. 重启桥接（审阅窗口操作）。启动日志应仍打印「文件保存白名单：100000001…」。
2. 在 100000001 群里**直接往聊天窗口发一个文件**（不是上传到群文件列表）。
   预期：
   - `state/bridge.log` 出现 `聊天文件已转存：群 100000001「…」… → 100000001/<YYYY-MM>/…`；
   - `state/files/100000001/<YYYY-MM>/` 下出现该文件；
   - `curl /api/files/stats` 的 `files.active` +1、`byGroup` 有 100000001。
3. 再问机器人「你把我刚才的文件存下来了吗？」预期答案大意：「已经存到本地了，但我没有读取文件内容」，
   **不应**再出现「我没有存文件的功能」。
4. 拿同一个文件再发一次：预期日志「已在本地…没有重复转存」，不重复占盘。
5. 群文件列表上传（另一条链路）：目前仍未真机验证；若有 `group_upload` 事件，
   预期日志 `群文件已转存：…`（与第一批相同）。
6. 非白名单群发文件：不应有任何新日志与 `state/files` 写入。

## 五、已知风险 / 回滚

- 风险：图片/视频以「文件」形式发时会被转存一次，媒体管线还会再取一次字节（重复下载）；
  体积大的图片文件会占用 `state/files` 直到保留期清理。介意就把 `fileArchive.maxFileMb` 调小。
- 风险：白名单群每一轮 prompt 多约 **90 token**（能力提示）。这是「不会再否认功能」的代价；
  如果嫌贵，可改成只在含文件的消息里拼（需要再改一处）。
- 风险：旧台账 `ALTER TABLE ADD COLUMN` 在极端并发（两个进程同时迁移）下可能抛错，已 try/catch
  且下一次 `ensureFileLedger` 会补齐；单实例部署无此问题。
- 回滚：`git revert` 本批提交即可；`source` 列保留不影响旧代码（旧 INSERT 不含该列，默认 ''）。

## 六、未做 / 待确认

- `get_group_root_files` 定时补漏（进程离线期间漏掉的群文件）仍未做。
- 观察群同时又在文件白名单时：观察群在 `onGroupMessage` 最前分流、不进 `handleIncoming`，
  因此**不会**触发聊天文件转存。要不要给观察群也存文件，需要用户拍板。
- preset 源文件（`dsh/agent-presets/**`）里的「不能读写文件」措辞没有改；桥接侧提示已能抵消，
  但若要更根本，建议由 preset 归属方加一句「桥接可能自动转存文件，保存≠你能读」。
