# state/ 与凭据外发边界清单

> 本文回答一个问题：**`scripts/pack-project*.ps1` 打出来的 zip 里，哪些东西绝对不能有？现在真的挡住了吗？**
> 清单可直接机械执行：`node scripts/pack-egress-scan.mjs`（只报路径与大小，不读内容、不打印任何令牌）。

## 0. 结论先说

1. **打包不是从 git 取文件，而是 `Copy-Item -Recurse` 复制工作树**（`pack-project.ps1:26-33`）。所以
   `.gitignore` 对打包**完全无效**，打包只认脚本里那份硬编码名字表 `$excludeNames`
   （`pack-project.ps1:36`：`state, node_modules, .git, logs, dist, config.json`）。
2. 用现有的 `scripts/privacy-scan.mjs` 实测主仓库：**75 处命中、涉及 23 个文件**（本机用户名路径
   `%USERPROFILE%` 下的用户目录路径、本机盘符路径 `E:\<主仓库>\…`）。把这份结果和打包面求交后：
   **这 23 个文件一个不漏，全部会进包**（`docs/` 与 `scripts/` 都是 includeDirs）。
3. 已经发过的包就是这样：`dist/qq-bridge-20261026-1501.zip`（327 条目）里确实有
   `docs/CHANGELOG.md`、`docs/PROJECT-OVERVIEW.md`、`scripts/check-qqbridge.ps1` 等命中文件。
4. 另外发现一个**反向**的坑：排除规则按名字递归删，full 包会把依赖里的 `node_modules/*/dist`
   整片删掉（实测 **2029 个文件 / 20 个包**），使「可直接离线运行」的 full 包实际跑不起来。

## 1. 边界怎么定义的

| 层 | 机制 | 管不管用 |
|---|---|---|
| 仓库层 | `.gitignore` | 管 git 提交，**不管打包** |
| 内容层 | `scripts/privacy-scan.mjs`（本机路径/QQ 号/凭据，只扫 git 会收的文件） | 管「提交了什么」，**不管「包里有什么」** |
| 打包层 | `pack-project*.ps1` 的 `$excludeNames` + `*.bak*` + 根目录 `*.py` | **唯一真正决定包里有什么的东西** |
| 交付前 | 本文件 + `scripts/pack-egress-scan.mjs` | 把上面两层对齐，回答「会不会进包」 |

## 2. 禁入包清单（可机械执行）

对应 `scripts/pack-egress-scan.mjs` 里的 `SENSITIVE_PATH_RULES`（id 一一对应）。

| # | 路径 / 模式 | 为什么禁 | 现有防线 | 现状 |
|---|---|---|---|---|
| 1 | `state/`（`messages.db`、`messages.db-wal/-shm`、`social-v2.json`、`stickers.json`、`token-usage.jsonl`、`console-token`、`bridge.lock`、`tool-calls.jsonl`、`*.wav/*.mp4` 等） | 消息库、记忆、表情收藏、令牌用量、锁文件——全是真实聊天数据 | 名字表 `state` + 不在 includeDirs | ✅ 双保险 |
| 2 | `logs/`（`bridge-stdout.log`、`bridge.err.log`…） | 日志含真实 QQ 号、群号、消息片段 | 名字表 `logs` + 不在 includeDirs | ✅ 双保险 |
| 3 | `config.json` | 真实账号、白名单群/人、本机路径、语音库目录 | 名字表 `config.json` + 不在 includeFiles | ✅ |
| 4 | `config.json.bak-*` / `config.json.bak-*`（根目录现有 8 个） | 旧配置同样含真实 ID | `*.bak*` 删除（`pack-project.ps1:40`） | ✅ |
| 5 | `audio/`（语音库） | 用户个人音频素材 | **仅**「不在 includeDirs」 | ⚠️ 单薄（见 G5） |
| 6 | `.env` / `.env.*` | 环境变量与密钥 | 无任何规则 | ❌ 见 G4 |
| 7 | `*.log`（散落在 `src/`、`docs/`、`public/` 的） | 同上 | 只挡目录名 `logs` | ❌ 见 G3 |
| 8 | `__pycache__/`、`*.pyc`（`tools/` 有 `.py`，会生成） | 本机解释器路径、字节码 | 无 | ❌ 见 G2 |
| 9 | `.npm-cache/` | 本地缓存 | 无 | ❌ 见 G2 |
| 10 | `scripts/privacy-rules.json` | **含真实 QQ 号与本机路径**（.gitignore:53 明写「不入库」） | 无 | ❌ 见 G2 |
| 11 | `docs/audits|design|legacy|research/`、`docs/qq-bridge-PUBLISH_PLAN.md`、`docs/qq-bridge-SECURITY_AUDIT.md`、`docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md` | .gitignore:61-68 明列的「原始开发文档/内部审计」，含本机路径 | 无 | ❌ 见 G2 |
| 12 | 根目录内部 md（`TOKEN_COST.md`、`LOCAL_MODEL_SIZING.md`、`ARCH_REVIEW.md`…） | .gitignore:17-31 明列 | 无（且不在 includeFiles，暂时安全） | ⚠️ 靠「不在清单」 |
| 13 | `*.db` / `*.sqlite*` | 数据库文件 | 无（只在 `state/` 下出现） | ⚠️ 靠位置 |
| 14 | `console-token`、`token-usage*`、`cookies.json`、`credentials.json`、`.netrc` | 凭据/登录态 | 无 | ⚠️ 靠位置 |
| 15 | `*.pem` / `*.key` / `*.pfx` / `id_rsa*` | 私钥证书 | 无 | ⚠️ 靠位置 |
| 16 | `*.bak` / `*.bak-*`、`*.bak-c`、`*.bak-20261025-*` | 备份快照 | `*.bak*` 删除 | ✅ |
| 17 | `dist/`（历史 zip 里含上面所有东西） | 旧包可能含泄漏内容 | 名字表 `dist` + 不在 includeDirs | ✅ |
| 18 | `state/setup-dsh-test-home/` 下的 junction 指回仓库自身 | 遍历会成环 | 本扫描器与 privacy-scan 都跳过 reparse point | ✅ |

## 3. 现有排除缺口（每条都有实测证据）

### G1（最严重）打包不跑 privacy-scan，也不看 .gitignore
- `pack-project.ps1` 全程没有调用 `privacy-scan.mjs`；`docs/`、`scripts/` 是整目录复制。
- 实测：`node scripts/privacy-scan.mjs --json`（主仓库）= **75 处 / 23 个文件**；
  `node scripts/pack-egress-scan.mjs --root <主仓库> --privacy-json <上一步 json>` = **23/23 全部会进包**。
- 已发 zip 佐证：`dist/qq-bridge-20261026-1501.zip` 的 327 个条目里有 `docs/CHANGELOG.md` 等命中文件。
- 危害：**和「有没有提交」无关**——哪怕仓库一直干净，zip 照样把本机用户名和盘符路径发出去。

### G2 名字表太窄：`.gitignore` 里 8 类私有物没有对应排除
`$excludeNames` 只有 5 个名字；`.gitignore` 还声明了 `__pycache__/`、`*.pyc`、`.npm-cache/`、
`scripts/privacy-rules.json`、`docs/{audits,design,legacy,research}/`、`docs/qq-bridge-PUBLISH_PLAN.md`、
`docs/qq-bridge-SECURITY_AUDIT.md`、`docs/guides/{PROJECT_GUIDE,VOICE}.md`——**全都没有打包排除**。
本机目前恰好没生成这些文件（只扫到 3 个 `.bak`），属于「下次一定中」。

### G3 `*.log` 只挡目录名，不挡文件
`.gitignore:12` 有 `*.log`，打包只删名为 `logs` 的目录。`src/`、`docs/` 下任何 `*.log` 会照样进包。

### G4 `.env` 完全没有规则
本机目前没有 `.env`，但 `scripts/*.ps1` 一类脚本将来要读环境变量时就会生成；一旦生成必进包。

### G5 `audio/` 的保护等级与 `state/`、`logs/` 不对称
`audio/` 既不在 `$excludeNames`，也不在 includeDirs——目前安全**只因为没人把它加进 includeDirs**。
后来者改一行 `includeDirs` 就会把用户语音素材打进包，而且没有任何兜底。

### G6 文本脱敏扩展名漏了一半格式
`pack-project.ps1:58` 的 `$textExt` 只有 `.js .mjs .json .md .html .txt .ps1 .bat .vbs .yml .yaml`，
**没有 `.jsonl`、`.tsv`、`.css`、`.csv`、`.log`、`.py`**；且只替换 7 个硬编码 QQ/群号
（`pack-project.ps1:49-57`），新增群号不覆盖。将来若 `docs/` 放了 `.jsonl` 样本，真实号码原样出门。

### G7（反向缺陷）按名字递归删 → full 包把依赖的 `dist/` 删没了
`pack-project-full.ps1:37-40` 对 stage 全树按名字删 `dist`，而 npm 包的编译产物大量放在 `dist/`。
实测 full 模式：会进包 2615 个文件，被排除规则删掉 **2032** 个，其中 **`dist` 占 2029 个**
（20 个目录，含 `node_modules/@snowluma/sdk/dist`、`@modelcontextprotocol/sdk/dist`、
`@hono/node-server/dist`…）。后果：full 包自称「已含 node_modules，可直接离线运行」，实际缺入口文件。

### G8 先复制后删除
排除发生在 `Copy-Item` 之后（`:26-33` → `:36-42`）。normal 包只复制 includeDirs，风险低；
但一旦有人把 `state/` 加进 includeDirs，明文数据会先落 `%TEMP%` 再被删。

### G9（记录，不在本任务修）打包不含 `roles/`、`plugins/`、`dsh/`、`assets/`
不是泄漏问题，是可用性问题——另派任务。

## 4. 修复建议（由 w1 串行安排；本任务只出方案，未改打包行为）

| # | 建议 | 针对 |
|---|---|---|
| S1 | 打包入口加闸：先跑 `privacy-scan.mjs --json`，有命中就中止（非 0 不出包） | G1 |
| S2 | 把 `$excludeNames` 从「名字」升级为「glob 清单」，一次性覆盖 .gitignore 全部敏感项（`.env*`、`*.log`、`__pycache__`、`*.pyc`、`.npm-cache`、`privacy-rules.json`、docs 私有目录与文件…） | G2/G3/G4 |
| S3 | 更彻底：改用 `git archive`（只含已跟踪文件、天然尊重 .gitignore）+ 保留现有 stage 脱敏；full 版用 `git ls-files` 复制源码，再单独补 `node_modules` | G1/G2/G8 |
| S4 | 打包后对 `MANIFEST.tsv` 跑 `node scripts/pack-egress-scan.mjs --root <stage>`，0 违规才发布（本脚本就是为此写的） | G1 回归 |
| S5 | `$textExt` 改成「二进制扩展黑名单」而非白名单，一次覆盖 `.jsonl/.csv/.css/.py` 等 | G6 |
| S6 | 把 `audio/` 加进 `$excludeNames`，与 `state`/`logs` 对齐 | G5 |
| S7 | full 包排除 `dist` 时限定「仅 stage 根目录」，或直接不删递归的 `dist`；修完重跑扫描器确认 `blocked.byName.dist = 0` | G7 |
| S8 | 长期：把本清单第 2 节当唯一真源，新增敏感路径 → 同时改 `.gitignore` + ps1 + 本表 + 扫描器规则（三处不一致就会漏） | 全部 |

## 5. 怎么机械执行

```powershell
# ① 内容闸（已有）：本机路径 / QQ 号 / 凭据，只扫 git 会收的文件
node scripts/privacy-scan.mjs --json > $env:TEMP\privacy.json

# ② 打包面闸（本任务新增）：算出这次打包到底会带走什么，按敏感清单核对
node scripts/pack-egress-scan.mjs                         # 普通包
node scripts/pack-egress-scan.mjs --mode full             # full 包
node scripts/pack-egress-scan.mjs --privacy-json $env:TEMP\privacy.json   # 与①求交

# ③ 自测（临时目录造夹具，不碰仓库）
node scripts/pack-egress-scan.mjs --selftest               # 期望 21/21

# ④ 清单回归（改 pack 脚本或 pack-exclude.json 后必须跑；每条规则都有探针）
node scripts/test-pack-exclude.mjs                         # 期望 26/26
```

- 退出码：`0` = 打包面上没有敏感文件；`1` = 有（这次不要发）；`2` = 用法/环境错误。
- 输出只有**路径 + 字节数 + 命中的规则 id**，不读文件内容、不打印任何令牌。
- `--json` 给机读结果（含 `blockedByName`，可用来盯 G7 的 `dist` 计数）。
- 与 `privacy-scan` 的分工：前者看**内容**、后者看**打包面**；两个都绿才发。

## 6. 实测记录（2026-10-26，主仓库 main 工作树）

| 检查 | 命令 | 结果 |
|---|---|---|
| 内容闸 | `node scripts/privacy-scan.mjs --tracked-only` | ❌ 75 处 / 23 个文件（本机路径为主，另有 QQ 号/高熵串误报项） |
| 打包面（普通） | `node scripts/pack-egress-scan.mjs` | ✅ 0 路径违规；会进包 354 文件 / 4.83 MB；挡掉 3 个 `.bak*` |
| 打包面（full） | `node scripts/pack-egress-scan.mjs --mode full` | ✅ 0 路径违规；会进包 2615 文件 / 17.43 MB；挡掉 2032（`dist` 2029 + `*.bak*` 3） |
| 求交 | `--privacy-json` | ❌ **75 处命中的 23 个文件全部会进包** |
| 已发 zip | 只读列 `dist/qq-bridge-20261026-1501.zip` 条目 | 327 条目，含 `docs/CHANGELOG.md`、`docs/PROJECT-OVERVIEW.md`、`scripts/check-qqbridge.ps1` 等命中文件 |

> 结论：**打包面的「路径级」规则目前拦住了该拦的（0 违规），但「内容级」泄漏（G1）真实存在且已随包出门。**
> G1 的修法不在打包脚本里，而在 S1/S3/S4：内容闸必须是发布的前置条件。

## 7. 维护约定

- 新增任何「本机才有」的东西 → 同时更新 `.gitignore`、`scripts/pack-exclude.json`、本文件第 2 节、扫描器规则；
  只改一处等于没改（这三个清单已经漂移过一次，见 .gitignore:55-68 的注释）。
- 打包脚本改完必须跑 `--selftest`、两种模式的 `-DryRun`，把输出贴进提交正文。
- 不在本文件里抄真实 QQ 号、路径、令牌——本文件本身也会进包。

## 8. 落地状态（T13，2026-10-26）

`pack-project*.ps1` 已按第 4 节修好（仍只出包、不发布；未删任何仓库文件）：

| 缺口 | 修法 | 验证 |
|---|---|---|
| G1 打包不认 .gitignore、无内容闸 | stage 打完后强制 `pack-egress-scan.mjs --stage`，不通过就 `throw`、**不写 zip** | 负例：含 `state/` + 本机路径 → exit 1 |
| G2/G3/G4 名字表太窄 | 排除规则搬到**单一真源** `scripts/pack-exclude.json`（两个脚本共用），覆盖 `.env*`、`*.log`、`*.bak*`、`__pycache__`、`*.pyc`、`.npm-cache`、`privacy-rules.json`、`docs/{audits,design,legacy,research}` 与内部文档 | normal stage 里逐项 absent |
| G5 `audio/` 保护不对称 | `audio` 与 `state`/`logs` 同级：根目录删 + 任意层级同名删 | 同上 |
| G6 脱敏扩展名漏 | 改为**二进制扩展黑名单**（清单 `sanitize.binaryExtensions`），其余全按文本脱敏 | stage 本机路径 0 处；改过的 `.mjs` `node --check` 通过 |
| G7 full 包误删依赖 `dist` | `dist` 只在 **stage 根**删，不再递归 | full stage 里 `@snowluma/sdk/dist`、`@modelcontextprotocol/sdk/dist`、`@hono/node-server/dist` 均在 |
| G8 先复制后删除 | 新增 `-DryRun`：只 stage + 校验、不产 zip；闸门在写 zip 前 | normal/full DryRun 均 exit 0 |

顺带两个健壮性修复（都是踩出来的）：

- **空 stage 不再被当成「干净」**：闸门对「stage 不存在 / 0 个文件」直接判失败（exit 2）。
  起因：`modeExtra.full` 为空对象时 `@($null)` 让排除名单里多出一个空串，`Join-Path $stage ''` 返回
  stage 根目录本身 → 整个 stage 被自己删掉，而旧闸门看着 0 文件还报 OK。现在两份脚本都过滤空名、
  并对「要删的目标 == stage 根本身」直接 throw。
- **本机路径按内容脱敏**：stage 副本里把 `C:\Users\…` 与非 C 盘绝对路径替换为 `<本机路径>`（仓库文件
  不动，所以本机脚本照常能跑）。同时给 `privacy-scan.mjs` 的 `isNoise` 补了两条：大写常量/文件名带
  连字符（`AUDIT_2026-10-18_MEDIA_AND_WATERMARK`）与 HuggingFace 缓存名（`models--Systran--…`），
  这两类以前被误报成高熵密钥。

### 验收数字（2026-10-26 23:07 本机）

```text
normal -DryRun : stage 355 文件；闸门 0；在 stage 内跑 privacy-scan = 0 处
full   -DryRun : stage 4645 文件；闸门 0；node_modules/*/dist 保留
求交（stage）  : privacy 命中文件里，打包后仍泄漏 = 0
负例           : stage 不存在→2、空 stage→2、含 state/ 与本机路径→1
仓库侧         : privacy-scan 75→69 处、23→21 文件（剩余全是本机路径，属刻意保留）
```

> ⚠️ 一个反直觉但重要的结论：**源文件保留本机路径是刻意的**（这些脚本要在这台机器上跑），
> 所以「源仓库 privacy 红 69 处」与「发布包干净」可以并存。**判断发布是否安全，看 stage 的扫描
> 结果，不是源仓库的扫描结果。**

