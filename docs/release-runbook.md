# 发布 Runbook（打包 / 验证 / 回滚）

> 一页纸。命令逐条可直接复制。所有数字都是 **2026-10-26 23:47 在 `feat/w6` 工作树实跑 `-DryRun` 的实测值**（该工作树与 main 同源；main 上若多了别的新文件，正常会略高几十——判据是「normal 三位数 / full 四千多」，不是精确相等）。
> 打包规则唯一真源：`scripts/pack-exclude.json`。**不要改脚本里的硬编码名单**，要加排除项就改这个 json。

## 0. 一句话原则

**敏感文件宁可不进包** —— 漏掉一个正常文件只是少个文档，放进一个 `config.json` / `state/` / 本机路径就是凭据与隐私外泄。

---

## ① 正常出包

两种包，按用途选一个（都在仓库根目录执行）：

```powershell
cd <本机路径>\qq-bridge-src

# 普通包（不含 node_modules，给能自己 npm install 的人）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-project.ps1

# 完整包（含 node_modules，开箱即用，体积大）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-project-full.ps1
```

产物（脚本写的是仓库下的 `dist\`）：

| 文件 | 说明 |
|---|---|
| `dist\qq-bridge-<yyyyMMdd-HHmm>.zip` | 包本体 |
| `dist\qq-bridge-<yyyyMMdd-HHmm>.zip.sha256` | 校验和，格式 `<sha256>  <文件名>` |

要交付/上传时复制到 Downloads（`dist\` 本身不进包，别把它当交付目录）：

```powershell
Copy-Item dist\qq-bridge-*.zip* <本机路径>\Downloads -Force
Get-ChildItem <本机路径>\Downloads\qq-bridge-*.zip | Select-Object Name,Length,LastWriteTime
```

成功时脚本最后三行长这样：

```
PACK OK: <仓库>\dist\qq-bridge-<stamp>.zip (6.14 MB)
SHA256: <64 位小写十六进制>
MANIFEST.tsv included in zip
```

Zip 内含 `MANIFEST.tsv`（全量文件清单+字节数）与 `PACK-INFO.txt`，收包的人可据此核对。

> 交付前先验哈希（两边一致才算传成功）：
> ```powershell
> Get-FileHash <本机路径>\Downloads\qq-bridge-*.zip -Algorithm SHA256 | Format-List
> ```

---

## ② 出包前后必查（三道闸，缺一不可）

### 闸 1：先 DryRun，确认 stage 文件数合理

`-DryRun` 会完整复制+脱敏+过扫描器，但**不写 zip**，只把 stage 留在 TEMP 供检查：

```powershell
cd <本机路径>\qq-bridge-src
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-project.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-project-full.ps1 -DryRun
```

实测基线（**数字对得上才继续**）：

| 模式 | stage 文件数 | stage 体积 | 耗时 | 命令 |
|---|---|---|---|---|
| normal | **599** | **7.57 MB** | ~3 s | `scripts\pack-project.ps1 -DryRun` |
| full | **4889** | **29.0 MB** | ~14 s | `scripts\pack-project-full.ps1 -DryRun` |

> 2026-10-28 03:16（w6/T19，`feat/w6` 基于 main `3ffbf98`）：白名单补了 `desktop/`（T20 的 WebView2 宿主源码，含 `Host.cs`/`Brand.cs`/`app.manifest`/`README.md` 共 4 个文件——之前交付包里没有宿主源码，对方拿到包编不出 `QQDeepSeekBot.exe`）。同一个提交里 `desktop/vendor`（首次构建下载的 SDK 缓存，91 个文件约 9.4 MB）、`dist/`、`*.exe` 一律排除（`scripts/pack-exclude.json` 与 `scripts/delivery-manifest.json` 双份真源都加了规则，打包器是白名单制，不写规则就会把 SDK 缓存带进包）。相对 w2-pack1 的 426 / 4716，多出的 173 个文件里 169 个是这一天其它窗口合入的页面/文档/脚本（`public/client.html`、`public/ui-preview.html`、`docs/ui-*.md` 等），只有 4 个来自 `desktop/`。
>
> 2026-10-27（w2-pack1）：白名单补了 `dsh/`、`plugins/`、`assets/`、`config.template.json`，所以比旧基线（373 / 4663）多 53 个文件。这三个目录是 DSH 侧安装的输入——少了 `dsh/`，对方跑 `setup-dsh.mjs` 会 ENOENT `dsh/agent-presets/qq-chat/preset.yml`（已实证）。`roles/` 仍**不**随包（私人角色卡）。

通过时长这样：

```
[pack-egress-scan] stage：<本机路径>\AppData\Local\Temp\qq-bridge-pack-<stamp>-<pid>（599 个文件）
[pack-egress-scan] ✅ stage 通过：无敏感文件名，且内容里没有本机绝对路径。
DRYRUN OK: stage ready at <本机路径>\AppData\Local\Temp\qq-bridge-pack-<stamp>-<pid> (no zip written)
```

差太多就是有问题：normal 五百多、full 四千多；突然翻倍或掉到几十都要先查 `pack-exclude.json`。**normal 包里必须能看到 `dsh/agent-presets/qq-chat-v2/`、`plugins/qq-agent-presets/`、`config.template.json` 三样**，缺任何一样对方都装不起来；同时要能看到 `public/client.html`（桌面壳的页面）与 `desktop/Host.cs`＋`scripts/desktop/build-host.ps1`（宿主的源码与构建脚本），但**不能**看到 `desktop/vendor/`、`dist/`、`*.exe`（SDK 缓存与二进制不进包）。

> ⚠️ 实测坑：本机 TEMP 有清理机制会**在一两分钟内回收**这些 stage 目录（本次两次复现），所以要看内容就紧跟着下一步，别过几分钟再回来。

### 闸 2：扫描器必须 0 违规（`--stage`）

打包脚本在写 zip **之前**会自动跑它；手动复查用（把 `<stage>` 换成上一步打印的路径）：

```powershell
cd <本机路径>\qq-bridge-src
node scripts/pack-egress-scan.mjs --stage "<本机路径>\AppData\Local\Temp\qq-bridge-pack-20261026-2348"
```

| exit | 含义 | 能不能出包 |
|---|---|---|
| **0** | 通过：无敏感文件名、无本机绝对路径 | ✅ 可以 |
| **1** | 有敏感文件或残留路径（会逐条列出） | ❌ 中止 |
| **2** | stage 不存在或 **0 个文件** | ❌ 中止 |

**这条必须是 0。** 非 0 时脚本会直接抛错、**不写 zip**，stage 留在 TEMP 给你看原因。

### 闸 3：zip 内部不得含 state / token / 本机绝对路径

不解压直接查（先 `Add-Type` 一次即可）：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = (Get-ChildItem <本机路径>\Downloads\qq-bridge-*.zip | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$z = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  # ① 不该出现的路径与文件名
  $bad = $z.Entries | Where-Object {
    $_.FullName -match '(^|/)(state|logs|audio|\.git)/' -or
    $_.FullName -match '(^|/)(config\.json|\.env[^/]*|privacy-rules\.json)$' -or
    $_.FullName -match '(^|/)[^/]*\.(log|bak[^/]*)$'
  }
  if ($bad) { Write-Host "❌ 禁止项：" ($bad.FullName -join ' | ') } else { Write-Host '✅ 无 state/logs/audio/.git/config/.env/log/bak' }
  # ② 文本内容里不该残留本机绝对路径
  $hits = @()
  foreach ($e in $z.Entries) {
    if ($e.Length -gt 2MB) { continue }
    if ($e.FullName -match '\.(png|jpg|jpeg|gif|webp|ico|mp4|webm|wav|mp3|zip|exe|dll|node|woff2?|ttf|zst|db|sqlite|wasm)$') { continue }
    $sr = New-Object IO.StreamReader($e.Open()); $txt = $sr.ReadToEnd(); $sr.Close()
    if ($txt -match 'C:\\Users\\PC') { $hits += $e.FullName }
  }
  if ($hits) { Write-Host "❌ 残留本机路径：" ($hits -join ' | ') } else { Write-Host '✅ 内容无本机绝对路径' }
} finally { $z.Dispose() }
```

两条都 `✅` 才能交付。期望输出：

```
✅ 无 state/logs/audio/.git/config/.env/log/bak
✅ 内容无本机绝对路径
```

> 说明：包里出现 `token-ledger.js`、`TOKEN_USAGE_CONSOLE.md`、`test-token-usage.mjs` 是**正常的**——它们是额度统计的代码和文档，不是凭据。别看到 "token" 就报警。

---

## ③ 常见失败与处置

### exit 2：stage 是空的 / 不存在

```
[pack-egress-scan] ❌ stage 是空的（0 个文件）：<路径> —— 拒绝把空包当通过
```

含义：复制阶段什么都没拿到（路径写错、源目录被移走、`$env:TEMP` 权限异常）。
**这是刻意设计的**：空 stage 如果不判失败，会被当成「一个违规都没有」而放行一个空包。

处置：
1. 看 DryRun 打印的 stage 路径是否真的存在、里面有没有 `src/`；
2. 确认在**仓库根目录**执行（脚本按自身位置推算 root，但相对路径要对）；
3. 重新跑一次 `-DryRun`；仍为空就查 `$env:TEMP` 剩余空间与杀软拦截。

### exit 1：有敏感文件 / 残留本机路径

扫描器会点名到具体文件：

```
[pack-egress-scan] ❌ 1 个敏感文件名进了 stage：
   - state/messages.db  1024B  [runtime-dir,sqlite]
[pack-egress-scan] ❌ 1 个文件内容里仍残留本机绝对路径（脱敏没覆盖到）：
   - docs/leak.md  行 1  [local-user-path]
[pack-egress-scan] 处理：① 把该文件加进 scripts/pack-exclude.json 的 removePaths；② 或扩 sanitize 规则。
```

按报的路径分两种处置：
- **整个文件就不该进包**（私有笔记、审计稿、本机配置）→ 加进 `pack-exclude.json` 的 `removePaths`（路径相对 stage 根），或加 `removeNameGlobs`（按文件名通配，任意深度）；
- **文件本身该留，只是内容里有本机路径** → 扩 `pack-exclude.json` 的 `sanitize.patterns`（脱敏是**只改 stage 副本**，仓库文件不动）。

改完立刻回归，规则改动必须绿：

```powershell
cd <本机路径>\qq-bridge-src
node scripts/test-pack-exclude.mjs
```

实测基线：**26/26 通过**（其中就覆盖了「脏 stage → exit 1 点名文件」和「空 stage → exit 2」两条）。

### 打包很慢 / 中途被杀

full 包要复制 4290 个 node_modules 文件，实测 12.7 s；如果卡住先看 TEMP 空间。中途失败不会留半成品 zip（脚本先写 stage 再压缩；失败时 zip 根本没创建）。

---

## ④ 回滚

**删产物即可，没有任何副作用**：打包只读仓库、只写 `dist\` 与 TEMP 的 stage，不改仓库文件、不碰线上进程与 `state/`。

```powershell
cd <本机路径>\qq-bridge-src
Remove-Item dist\qq-bridge-*.zip, dist\qq-bridge-*.zip.sha256 -Force -ErrorAction SilentlyContinue
Remove-Item <本机路径>\Downloads\qq-bridge-*.zip, <本机路径>\Downloads\qq-bridge-*.zip.sha256 -Force -ErrorAction SilentlyContinue
# 顺手清掉残留的 stage（正常结束会自动删；-DryRun 和中断会留）
Get-ChildItem $env:TEMP -Directory -Filter 'qq-bridge-pack-*'  | Remove-Item -Recurse -Force
Get-ChildItem $env:TEMP -Directory -Filter 'qq-bridge-full-*'  | Remove-Item -Recurse -Force
```

要撤销的是「发了包」这件事本身：把已传出去的 zip 撤回/标记作废，然后按上面删本地产物。**仓库不需要回滚**（打包不写仓库）。

如果你改了 `pack-exclude.json` 或 `pack-project*.ps1` 才导致的错误，那才需要回滚代码：

```powershell
cd <本机路径>\qq-bridge-src
git checkout -- scripts/pack-exclude.json scripts/pack-project.ps1 scripts/pack-project-full.ps1
node scripts/test-pack-exclude.mjs   # 回到 26/26
```

---

## 附：一页速查

```
出包：  cd <repo>; powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-project.ps1        （full 换 pack-project-full.ps1）
预演：  同上 + -DryRun        → normal 426 文件 / full 4716 文件；normal 必须含 dsh/ plugins/ config.template.json
闸门：  node scripts/pack-egress-scan.mjs --stage <stage>   → 必须 exit 0
查包：  System.IO.Compression.ZipFile 列条目 + 扫文本          → 两个 ✅
交付：  Copy-Item dist\qq-bridge-*.zip* <本机路径>\Downloads -Force
回归：  node scripts/test-pack-exclude.mjs                    → 26/26
回滚：  删 dist\ 与 Downloads 里的 zip（+ 可选清 TEMP stage）；仓库无副作用
```
