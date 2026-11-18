# 交接｜simpleMode 转存：按 7 位 BOOTH 号归档到同名文件夹

分支 `feat/booth-dir`（从 `main` `80fe729` 新开；已合并进 `main`，桥接已于 2026-10-26 07:04 重启；线上 `config.json` 未改）。

## 一、改了什么

线上处于 `fileArchive.simpleMode = true`：只收「文件名以 7 位数字开头」的图片/压缩包。

**改动前**（`<root>` = `E:\booth-inbox`）：

```
<root>\<群号_群名>\<YYYY-MM>\9013048.zip
<root>\<群号_群名>\<YYYY-MM>\8664050.jpg
<root>\<群号_群名>\<YYYY-MM>\8664050_35種 Mew_Pose_Ver.3.zip
```

**改动后**：转存触发时，按文件名开头的 7 位 BOOTH 号新建（复用）同名文件夹：

```
<root>\<群号_群名>\9013048\9013048.zip
<root>\<群号_群名>\8664050\8664050.jpg
<root>\<群号_群名>\8664050\8664050_35種 Mew_Pose_Ver.3.zip
```

- 同一个号的所有文件（压缩包 + 同号图片）落进**同一个** `${7位号}/` 目录；
- 目录按需 `mkdir -p` 自动生成；同名文件冲突仍走 `名字 (1).ext`，不覆盖；
- 群文件夹名仍沿用 `<群号_群名>`（`state/group-names.json` 缓存），群名拿不到就只用群号；
- **只有恰好 7 位**才算 BOOTH 号：`20240101.zip`（8 位日期）、6 位号、字母开头都不归类，
  继续走原来的 `<群号_群名>/<YYYY-MM>/`，避免造出 `2024010/` 这种垃圾目录；
- 非 simpleMode（BOOTH 元数据/分类模式）**行为完全不变**。

覆盖的转存入口：

| 入口 | 文件 |
|---|---|
| `/转存` 引用的聊天文件段、普通文件段 | `archiveChatFileSegments`（`src/file-archive.js`，按每个文件自己的文件名算目录） |
| 群文件上传 notice（`group_upload`） | `handleGroupFileUpload`（`src/bridge.js`，直接把 `rawName` 传给 `simpleArchiveDir`） |
| 图片附件（simpleMode 下文件名带 7 位号才收） | `archiveMediaAttachment`（`src/bridge.js`；simpleMode 下保留原名，不再存成 `图片-N.png`） |

新增纯函数（`src/file-archive.js`）：

```js
simpleBoothId(fileName) // 恰好 7 位 → '8664050'；8 位日期/6 位/字母开头 → ''
simpleArchiveDir(cfg, groupId, whenMs, fileName) // 有号 → <群号_群名>/<7位号>；否则 <群号_群名>/<YYYY-MM>
```

## 二、存量文件怎么办（可选，一次性）

线上 `E:\booth-inbox` 里已经有 3 个同号文件躺在 `2026-10` 里。新代码只影响**之后**的转存；
要把存量也整理进号文件夹，跑：

```powershell
# 预演：只打印计划，不动文件
node scripts/migrate-simple-booth-folders.mjs

# 真搬（先备份 state/messages.db；逐个 sha256 校验）
node scripts/migrate-simple-booth-folders.mjs --apply
```

脚本行为：

- 只处理 `rel_path` 形如 `<...>/<YYYY-MM>/<文件>` 且文件名恰好 7 位开头的条目；
- 目标 `<...>/<7位号>/<storedName>`；目标已存在则加 `(1)`；
- 搬完重算 sha256 与台账比对，不一致回滚该条；
- 同目录的 `meta_rel` / `thumb_rel`（旧 BOOTH 元数据/缩略图）跟着进新目录并更新台账；
  台账引用已失效（指向更早的 `state/files` 布局）时**保留原值不清空**，并按文件名
  `<boothId>.meta.*` / `<boothId>.thumbnail.*` 兜底搬同目录里的 sidecar；
- 8 位日期、6 位号、无号图片一律不动；
- 可重复执行（第二次「没有需要整理的条目」）。

**线上已执行（2026-10-26 07:05）**：合并 + 重启后跑 `--apply`，8 个文件全部搬进号目录，
sha256 全部校验通过；`9013048.meta.json` / `9013048.thumbnail.jpg` 也跟进了 `9013048/`。
空出来的 `2026-10/` 目录已删除。

## 三、验证

```
node scripts/test-simple-booth-dir.mjs
  ✅ 7 位解析（含 8 位日期/6 位号/字母开头反例）
  ✅ 目录布局（有号 / 无号 / 群名缺失 / 群名清洗）
  ✅ archiveChatFileSegments 真落盘：同号进同目录、8 位日期留年月、重名 (1)
  ✅ 存量脚本：预演、--apply、台账+sidecar 同步、重复执行幂等
  ✅ 桥接两处转存入口都传了文件名

node scripts/regression-all.mjs   # 46/46 套件通过
```

## 四、风险 / 回滚

- 7 位数字规则本身没变（还是线上 simpleMode 的闸门）；变的是**目录层级**。
  已有按 `<YYYY-MM>` 整理的脚本/习惯需要知道新路径。
- `9013048` 这种 QQ 网关数字文件名在旧逻辑里也会被当 BOOTH 号收进来；现在会多一层同名目录
  （与 simpleMode「只收 7 位号」的取舍一致）。
- **回滚代码**：`git revert <本提交>` 后重启桥接；新转存的文件会回到 `<YYYY-MM>/`。
- **回滚存量迁移**：迁移前有 `state/messages.db.bak-booth-dir-*` 备份；
  把 `<7位号>/` 里的文件移回同群 `<YYYY-MM>/`，再用备份还原 `messages.db` 的 `rel_path`。
  建议先跑预演、确认列表再 `--apply`。
- 线上 `config.json` **未改**；桥接于 2026-10-26 07:04 重启过一次（合并后生效）。

## 五、上线状态 / 还剩的验证

已完成：

1. `feat/booth-dir` 已合并进 `main`（含迁移脚本 sidecar 修复）。
2. 桥接已重启（07:04:26，新的 simpleMode 归类代码生效）。
3. 存量 8 个文件已归到 `9013048/`、`8664050/`、`9040444/`、`9041635/`（sha256 校验通过），
   空出来的 `2026-10/` 已删除。

建议你再发一条 `/转存`（引用带 7 位号的文件）做一次**新转存**实测：日志里应出现
`... → 100000001_扣1复活牢大\<7位号>\<文件>`，而不是 `2026-10\`。
