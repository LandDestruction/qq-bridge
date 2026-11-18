# 交接｜施工 C 第一批：群文件转存 + 生命周期清理 + 两个新白名单

```
分支: feat/file-archive
改动文件:
  docs/file-archive-survey.md            新增：阶段 1 调研简报（实测证据 + 待确认项）
  docs/handoff-feature-batch1.md         新增：本交接
  config.example.json                    新增 fileArchive / observe 两段示例（默认关闭）
  src/file-archive.js                    新增：配置收敛、文件名/路径、台账表、60/120 天保留期、
                                         清理任务（可注入时钟与删除函数）、规则分类
  src/observe-learn.js                   新增：观察学习配置、分流决策、学习计划/执行（hooks 注入）
  src/safe-fetch.js                      新增 safeFetchBinary（通用二进制 + 字节上限 + SSRF 逐跳校验）
  src/bridge.js                          接线：group_upload 转存、观察群分流、每日清理、/api/files 四个端点
  scripts/test-file-archive.mjs          新增：18 项离线单测（内存 SQLite + 假时钟）
  scripts/test-observe-learn.mjs         新增：10 项离线单测（假实现断言「只学不发」）
  scripts/audit-bridge-harness.mjs       VM 注入新模块（否则 loadConfig 在审计环境里 ReferenceError）

为什么:
  用户要求：白名单群里的群文件由机器人转存，未分类 2 个月、已分类 4 个月清理；
  另设「观察学习」白名单：这些群只看不说，只收集词汇与表情包。

怎么验的:
  L1  node --check src/file-archive.js src/observe-learn.js src/safe-fetch.js src/bridge.js
      → 全部通过
  L2  node scripts/test-file-archive.mjs   → 18/18 通过
      node scripts/test-observe-learn.mjs  → 10/10 通过
      回归：node scripts/test-audit-bridge.mjs → 全部 PASS
            node scripts/test-storage-card.mjs → 31 项全过
            node scripts/test-media-queue.mjs  → 通过
            node scripts/test-archive.mjs      → 21/21
            node scripts/test-config-diff.mjs  → 全过
  L3/L4 未做：施工树没有 state/，按 COLLAB §3/§5 不在工作树起桥接；
        真机收发群文件、直链是否需要 cookie、清理任务实跑都要审阅合并后验证。

需要审阅注意:
  1. **事件来源已实测**（不是猜）：SnowLuma `C:\SnowLuma\index.mjs:18452-18464` 有
     `convertGroupFileUpload`，`index.mjs:18577` 注册在 CONVERTERS、`index.mjs:32326` 在
     EVENT_PIPELINE，下游是 OneBot notice `group_upload`，字段
     `{group_id, user_id, file:{id,name,size,busid}}`（注意是 `id` 而不是 `file_id`）。
  2. **配置必须重启才生效**：`fileArchive` / `observe` 在 loadConfig 里搬运，
     运行期改 config.json 不会热加载（与其它段一致）。
  3. 转存只在 `fileArchive.enabled=true` 且群号在 `groups` 里时发生；
     不在白名单的群完全不进这条链路（不打日志、不下载）。
  4. 清理只删 `state/files` 下**自己转存的副本**，不碰 QQ 侧原文件；
     每行日志：删除数 / 释放字节 / 缺失 / 失败 / 下次运行时间。
  5. 每天 `cleanupHour`（默认 4 点）跑一次，启动补跑一次；已关掉 `fileArchive.enabled`
     但台账里有历史文件时**仍会清理**（否则旧文件永远占盘）。
  6. 分类：先用扩展名规则（`category_source=rule`），认不出才用**现有 DSH 会话**
     （`cfg.fileArchive.category.preset` 默认 `qq-chat`，模型即 `cfg.dsh.model`，默认
     `deepseek-flash`）问一次；失败不影响转存与清理。人工可用
     `POST /api/files/category {id, category}` 覆盖，cleanup_at 会**立刻重算**。
  7. 观察群语义：在 `bot.onGroupMessage` 最前面拦截，不进入 `handleIncoming`——
     不唤醒、不回复、不扣私聊额度。**观察优先于 allow.groups**；观察群里被 @ / 被引用
     当前也**不回**（代码注释已标「待确认」，等用户拍板）。
  8. 观察群的表情学习只写**本地表情学习库**（`sticker-lib.collectSticker`，
     `policy=understand-only`），**不动 bot 的 QQ 收藏夹**（不用 collectStickerV2）。
  9. `/api/files`、`/api/files/stats`、`POST /api/files/cleanup`、
     `POST /api/files/category` 已就绪，控制台页面（施工 B）可直接接；
     存储卡要显示的「占用」看 `files.activeBytes` / `byGroup[].bytes`。
 10. 未做（下阶段候选）：
     - `get_group_root_files` 定时补漏（进程不在线时漏掉的群文件）；
     - 观察群的表情只存了 url/md5，没有把字节落库（QQ 直链会过期，是否需要持久化要定）；
     - 控制台表单目前还没有 fileArchive/observe 的编辑项（前端归 B）。

已知风险 / 回滚方式:
  - 风险：群文件直链是带 rkey 的临时链接，若网关要求 cookie/Referer，转存会失败并
    在日志里给出 `文件下载失败：HTTP xxx`；不影响其它功能，可先观察日志再补请求头。
  - 风险：单文件下载复用现有 `requestOnce` 的「读入内存」路径，上限由
    `fileArchive.maxFileMb`（默认 200）收紧；超大文件会被截断并拒绝落盘
    （不会写入半截文件）。要支持更大文件再改成流式落盘。
  - 回滚：`git revert <commit>` 即可；功能默认 `enabled=false`，不配置就不生效。
    数据侧只需删除 `state/files/` 与 `state/messages.db` 里的 `file_archive` 表
    （不影响 messages 表）。
```

## 验收清单（可复跑）

```bash
node --check src/file-archive.js
node --check src/observe-learn.js
node --check src/safe-fetch.js
node --check src/bridge.js
node scripts/test-file-archive.mjs      # 18 项
node scripts/test-observe-learn.mjs     # 10 项
node scripts/test-audit-bridge.mjs
node scripts/test-storage-card.mjs
node scripts/test-media-queue.mjs
node scripts/test-archive.mjs
```

## 待确认项（等用户/审阅拍板）

1. 观察群里 @ 机器人 / 引用机器人，要不要回？当前实现：**不回**。
2. 「两个月 / 4 个月」按 30 天/月折算成 60/120 天（任务书口径）；若要自然月需改一处常量。
3. 观察群收集的表情是否要把字节持久化到本地（现在只记 url/md5，直链过期后只剩元数据）。
