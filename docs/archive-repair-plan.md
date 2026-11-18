# 归档修复方案 + dry-run 工具（T11）

> 工具：`scripts/repair-archive-plan.mjs`（默认 dry-run，**本轮禁止 `--apply`**）
> 依据：T4 审计 `docs/archive-audit.md` 的 D1–D6
> 约束：禁止真删 / 真移 / 真改名任何归档文件；台账只在 `--apply` 时改，且本轮不执行
> 时间：2026-10-26 23:05（北京时间）

## 0. 先说最重要的一件事：归档根在 T4 审计之后被外部删除过一次

T11 的工具第一次跑起来就报基线不一致，顺着查下去发现**不是工具算错，是磁盘变了**：

| 时刻 | 事实 | 证据 |
|---|---|---|
| 22:55 | T4 审计：归档根 **22 个文件 / 239.43 MB**（原件 20 + 旁挂 2），台账 18 行全部在盘、sha256 18/18 相符 | `docs/archive-audit.md` §6 输出快照 |
| 22:58:59 | `<本机路径>\_未分类\100000001_扣1复活牢大\` 的修改时间 | `Get-ChildItem` 显示该目录 mtime = 2026/10/26 22:58:59，目录已空 |
| 23:03 | 计划器首次运行：归档根只剩 **10 个文件 / 222.90 MB**（原件 8 + 旁挂 2） | 本文件 §5 输出快照 |
| 23:04 | 台账仍是 18 行 active，没有任何 `deleted_at`；其中 **#1 #2 #3 #4 #5 #7 #8 #9 #10 #11** 的 `rel_path` 已不存在 | 只读打开 `messages.db` 副本查询 |

**文件去哪了：12 个都在 Windows 回收站里，sha256 与台账完全一致**（`E:\$Recycle.Bin` 下 `$R*` 文件）：

```
台账 active 18 行；在回收站里按 sha256 找回 10 行
  #1  图片-引用1.png      ← $RNJB60N.png    #7  图片-引用1 (3).png ← $R9JCVU8.png
  #2  图片-引用1.jpg      ← $RCYQH67.jpg    #8  图片-引用1 (4).png ← $RD67UQB.png
  #3  图片-引用1 (1).png  ← $RBLNVGY.png    #9  图片-引用1 (5).png ← $RFUEOZY.png
  #4  图片-引用2.png      ← $R5BQXI8.png    #10 图片-引用1 (7).png ← $RGU3VOA.png
  #5  图片-引用1 (2).png  ← $RW09XF6.png    #11 图片-引用1 (8).png ← $RCIUUV7.png
磁盘缺失 10 行：#1 #2 #3 #4 #5 #7 #8 #9 #10 #11
其中回收站也没找到的：无
```

另外 T4 里那 2 个「无台账孤儿」也一起进了回收站（`$R3PS996.png` 184043 B = `图片-引用1 (6).png`，`$RGK5TM4.jpg` 115759 B = `图片-引用1 (1).jpg`），所以**现在计划器不再产出 D1 项**，孤儿问题暂时不存在了。

- 判断删除方式：走的是**回收站**（`$R*` + `$I*` 索引），不是 `del`/`Remove-Item`（那些不进回收站），是 Explorer 或调用 Shell API 的程序干的。
- 排除本工具：`repair-archive-plan.mjs` 只做 `readdir/stat/readFile` + `readOnly` 打开台账；审计脚本同样只读。两者都没有 `unlink/rename/rmdir` 分支（`--apply` 分支也只执行 SQL UPDATE）。
- 桥接没清理：`bridge.log` 里 20:15 / 20:45 / 21:21 三次清理轮询都打印「simpleMode 已开启……**不执行自动清理**」，22:58 前后没有任何清理日志。
- 结论：**文件是被外部（人工/资源管理器）删掉的，可完整恢复**。谁删的需要主窗口/用户确认，本工具不做猜测。

所以下面所有修复动作都分成两条分支：**先恢复**（推荐）或**先标记删除**。

## 1. 修复项总览

| 项 | 来源 | 动作类型 | 影响 | 拍板人 |
|---|---|---|---|---|
| D7 | 本次新发现 | 恢复文件 **或** 台账标记 deleted | 10 行 / 16.24 MB | **用户**（两选一） |
| D3 | T4 D3 | 台账 UPDATE（2 处列值） | #6 的 meta/thumb 指向 | w1（低风险，可直接做） |
| D2 | T4 D2 | 台账 UPDATE（7 行 booth_id） | #12–#18 | w1（低风险，幂等） |
| D4 | T4 D4 | 改脚本落点 或 标 legacy | `scripts/migrate-archive-simple-layout.mjs` | w1 |
| D1 | T4 D1 | 已随本次删除消失（在回收站） | 2 个孤儿文件 | 用户决定是否恢复 |
| D5 | T4 D5 | 统一旁挂命名（`<id>.meta.*` → `meta.json`） | 仅在重开 enrich 时需要 | 用户/w1 |
| D6 | T4 D6 | 分类词表 `image` → `图片` | 10 行 | 用户（与保留期口径绑定） |

## 2. 逐项方案

### D7（最高优先）台账 10 行指向已不存在的文件

**现状**：#1–#5、#7–#11 共 10 行，16.24 MB，`deleted_at` 全为 NULL，`sha256` 都在。

**分支 A：恢复文件（推荐，数据不丢）**

1. 打开回收站，把 12 个 `图片-引用*.png/.jpg` 还原（或把 `$R*` 文件按 §0 的对照表复制回去）。
2. 还原后校验（只读，不写台账）：

```powershell
cd <本机路径>\w4
node scripts\audit-archive-simple.mjs --root 'E:/booth-inbox' --db "$env:TEMP\w4-audit\messages.db" --sha
# 期望：布局偏差 0、台账缺文件 0、sha256 18/18 相符
```

3. 恢复后**不需要**任何台账改动（`rel_path` 本来就没变）。

**分支 B：不恢复，把台账标记删除**

```sql
-- 只示意；本轮不执行，且必须先在台账副本上演练
UPDATE file_archive
   SET deleted_at = ?, delete_reason = 'external-deleted'
 WHERE id IN (1,2,3,4,5,7,8,9,10,11);
```

回滚：`UPDATE file_archive SET deleted_at = NULL, delete_reason = '' WHERE id IN (1,2,3,4,5,7,8,9,10,11);`

> 注意：分支 B 会永久放弃这 10 个文件；只要回收站没被清空，分支 A 随时可做。**建议先 A。**

### D3 台账 #6 的 `meta_rel` / `thumb_rel` 悬空（纯 UPDATE，零文件操作）

- 现状：指向 `100000001\3D衣装\9013048 zip\meta.json` / `...\thumbnail.jpg`（旧布局，磁盘已无）。
- 真实文件：`100000001_扣1复活牢大\9013048\9013048.meta.json`、`9013048.thumbnail.jpg`。
- 计划器已自动找出替代值，命令：

```powershell
node scripts\repair-archive-plan.mjs --root 'E:/booth-inbox' --db <messages.db 副本>
# 看 D3-6-meta_rel / D3-6-thumb_rel 两项的 SQL
```

- 回滚（逐条，原值）：

```sql
UPDATE file_archive SET meta_rel  = '100000001\3D衣装\9013048 zip\meta.json'       WHERE id = 6;
UPDATE file_archive SET thumb_rel = '100000001\3D衣装\9013048 zip\thumbnail.jpg'   WHERE id = 6;
```

### D2 回填 7 条 `booth_id`（纯 UPDATE，幂等）

```sql
UPDATE file_archive SET booth_id = ?, booth_url = ?
 WHERE id = ? AND booth_id = '';   -- 计划器对 #12–#18 逐条给出参数
```

- 与 `src/file-archive.js:1023` 的 `backfillBoothColumns()` 同口径；`WHERE booth_id = ''` 保证重复执行无副作用。
- 回滚：`UPDATE file_archive SET booth_id = '', booth_url = '' WHERE id IN (12,13,14,15,16,17,18);`

### D4 迁移脚本落点过期

- 现状：`scripts/migrate-archive-simple-layout.mjs:60-62` 仍把合规文件搬去 `<群号_群名>/<YYYY-MM>/`，而运行时（`b44d97a` 之后）是 `<群号_群名>/<7位号>/`。
- 两个选项（都要 w1 拍）：
  1. **改脚本**：`relNew` 改成 `path.join(groupFolder(gid,names), boothId, stored)`（仅当 `simpleBoothId` 命中），无号的仍去 `_未分类/`；
  2. **标 legacy**：文件改名 `migrate-archive-simple-layout.legacy.mjs` + 头部写「已被 `migrate-simple-booth-folders.mjs` 取代」。
- 回滚：`git checkout -- scripts/migrate-archive-simple-layout.mjs`（选项 2 则 `git mv` 回来）。
- 本轮**不改**，只报告（计划器 `D4-migrate-script-stale` 项会持续提示）。

### D1 两个孤儿文件

- 已随本次删除进回收站（`$R3PS996.png` / `$RGK5TM4.jpg`），当前磁盘上不存在 → 计划器不再产出该项。
- 若分支 A 恢复 `_未分类`，孤儿会**重新出现**（磁盘有、台账无）。届时二选一：
  - 补台账行（需要知道 group_id/file_id/上传者，可从 `messages.db` 的原始消息找）；
  - 确认与 `(5)`/`(7)` 重复后删掉（**必须先比对 sha256**，本轮不做）。

### D5 旁挂命名双轨（只在重开 enrich 时才动手）

- 现状：`9013048.meta.json` / `9013048.thumbnail.jpg`（旧布局遗留），而现行代码写 `meta.json` / `thumbnail.<ext>`（`file-archive.js:1190`、`:1196`）。
- 重开 enrich 前建议先改名成 `meta.json` / `thumbnail.jpg`，否则同一目录会出现两份元数据。
- 回滚：改回原名（`git` 不管归档文件，需要记一条 rename 日志）。

### D6 分类词表统一（可选，先定 simpleMode 去留）

- 现状：`image×10`（`category_source=media`，旧代码）、`图片×4`、`压缩包×3`、`3D衣装×1`。
- 修法：`UPDATE file_archive SET category = '图片' WHERE category = 'image';`
- 影响：`isClassified()` 对两者都返回 true，**保留期不变（120 天）**；只是面板/统计分桶不再分裂。
- 回滚：`UPDATE file_archive SET category = 'image' WHERE id IN (1,2,3,4,5,7,8,9,10,11);`
- **要用户先回答**：simpleMode 是长期开启吗？如果将来关掉 simpleMode、要按「未分类 60 天」清理，那这 10 行现在就该归到「未分类」语义，而不是只改个名字。

## 3. 推荐执行顺序

1. **D7 分支 A**：从回收站还原 12 个文件 → 跑 `audit --sha` 确认回到 22 文件 / 239.43 MB、sha256 18/18。（用户操作，我做校验）
2. **D3 + D2**：两条纯 UPDATE，先备份 `messages.db`，再 `--apply`；跑一次 `audit --sha` 复核「悬空 0、booth_id 0 空」。
3. **D4**：w1 决定改脚本还是标 legacy（不涉及线上数据）。
4. **D1（若已恢复）**：比对 sha256 后决定补台账还是去重（需要用户拍）。
5. **D5 / D6**：等用户对「simpleMode 长期去留」表态后再做。

## 4. 回滚手册（统一口径）

| 改动 | 备份/回滚 |
|---|---|
| 台账（D2/D3/D6/D7-B） | 工具 `--apply` 会先 `copyFileSync(messages.db, messages.db.bak-repair-<stamp>)`；回滚 = 停桥接 → 用备份覆盖 → 起桥接。DB 自身也支持按 §2 的逆 SQL 逐条回滚 |
| 归档文件（D1/D5） | 不删不移：恢复只在「回收站 → 原路径」方向做；rename 前记 `old → new` 清单，回滚照单改回 |
| 脚本（D4） | `git revert` / `git checkout --` 单文件即可，不涉及线上数据 |

## 5. dry-run 输出快照（2026-10-26 23:05）

命令：

```powershell
cd <本机路径>\w4
# 台账副本（不碰运行中的库）
$tmp = Join-Path $env:TEMP 'w4-audit2'
Copy-Item '<本机路径>\qq-bridge-src\state\messages.db'     $tmp -Force
Copy-Item '<本机路径>\qq-bridge-src\state\messages.db-wal' $tmp -Force
Copy-Item '<本机路径>\qq-bridge-src\state\messages.db-shm' $tmp -Force

node scripts\repair-archive-plan.mjs --root 'E:/booth-inbox' --db "$tmp\messages.db"
# 机器可读：加 --json
```

输出（节选，完整输出见运行记录）：

```
模式：dry-run（默认，不改任何东西）
归档根：E:\booth-inbox
台账：...\messages.db（18 行，有效 18）
基线：10 个文件 / 222.90 MB（原件 8 + 旁挂 2）  ⚠️ 与审计基线不一致（期望 22/20/2）
计划项：5 个（台账更新 3、文件系统改动 0、需用户拍板 2）
⚠️ 台账有 10 行、共 16.24 MB 的文件已不在磁盘上（见 D7）；所以磁盘基线比 T4 审计时少，不是本脚本造成的。

▸ [db-update] 台账 meta_rel 悬空 — D3-6-meta_rel
▸ [db-update] 台账 thumb_rel 悬空 — D3-6-thumb_rel
▸ [db-update-batch] booth_id 回填（7 条） — D2-booth-id-backfill
▸ [code-report] 存量迁移脚本落点已落后于运行时布局 — D4-migrate-script-stale
▸ [db-mark-or-restore] 台账还有 10 行指向已不存在的文件 — D7-ledger-missing-files
（dry-run：以上动作一条都没有执行；本轮禁止 --apply）
```

## 6. 验收对照

| T11 验收要求 | 结果 |
|---|---|
| dry-run 与审计数字一一对应 | 工具内置基线断言：T4 快照 22/20/2，当前 10/8/2；**不一致原因已定位到 D7 的外部删除**，不是工具算错。恢复文件后重跑应回到 22/20/2（工具会打印 ✅） |
| 不执行 `--apply` | 全程只跑 dry-run；`--apply` 分支另有两道硬闸（基线不一致 `exit 3`、有 D7 `exit 4`），本轮一次没跑 |
| 禁止真删/真移/真改名 | 工具没有任何 `unlink/rename` 调用；D1/D7 只登记「保留/恢复」，文件操作留给用户 |
| 文档给出每项命令与回滚 | §2 每项都有 SQL/命令 + 逐条回滚；§4 汇总 |

## 7. 需要用户拍板的三件事

1. **D7 走 A 还是 B**：从回收站还原那 10 个文件（推荐），还是把台账标记删除？
2. **simpleMode 长期开启吗**：决定 D6 是「只改词表」还是「归到未分类语义（60 天）」。
3. **D4 改脚本还是标 legacy**：改脚本会动 1 个既有迁移脚本，标 legacy 只是重命名 + 注释。
