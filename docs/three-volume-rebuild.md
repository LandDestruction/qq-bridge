# 三卷包：怎么只重打 part1-core（T22 起，T26 最新一次重打）

> 这套包 = 整机可迁移的 QQ 机器人（运行时 + 桥接 + 可选语音/模型），不是只有桥接。
> 现有目录：`<本机路径>\qq-bot-full-20261027-2215`（首版）与
> `<本机路径>\qq-bot-full-20261028-0615`（T26 最新一次只重打 core 的版本；每次重打新开目录）。

## 1. 为什么只重打 core

首版（2215）的 `app` 来自 `dist/delivery/qq-bot-system-20261027-1934`，而那之后的
T15/T16/T17/T19/T20 才加上 `/client` 页、desktop WebView2 宿主、安装器与客户端回归：

- `public/client.html` / `public/ui-preview.html`（客户端页）
- `desktop/`（WebView2 宿主源码）+ `scripts/desktop/build-host.ps1`
- `scripts/installer/` + 根目录 `build-installer.ps1`（安装包）
- `scripts/test-installer.mjs`、`scripts/test-client-ui.mjs` 等回归

`part3-voice.zip`（9,762,316,869 B ≈ 9.09 GiB）与 `part4-models.zip`（12,537,385,606 B ≈ 11.68 GiB）
里的本机 TTS 与 Ollama 模型**没有变化**，重打等于白搬 ≈20.8 GiB、白算一次 SHA256，所以本轮跳过。

## 2. 脚本

`scripts/build-full-bundle.ps1`（从主窗口工作区的同名脚本搬进仓库；逻辑未改，
只加了 `-DeliveryDir` 参数，便于指向本窗口刚出闸的交付包）。

它做四件事：
1. 装 `runtime/`：DSH 程序、DSH 家目录（去 `sessions`/`attachments`/`.credentials.yaml`）、
   SnowLuma（去 `data/`、`onebot_*.json`）、wb2api（去 `auths/`）；
2. 把**指定的交付包**整份放进 `app/`，再补 `app/node_modules`；
3. 脱敏：用真实 `config.json` 里的令牌/QQ/群号/API key 逐文件替换成占位符，
   顺手清 `<本机路径>\` 这类本机路径；
4. 生成 `README-FIRST.md` / `INSTALL.ps1` / `MANIFEST.json`，`tar` 以 **store** 模式压 zip，
   最后写 `SHA256SUMS.txt`。

## 3. 命令（只打 core）

```powershell
# 1) 先出「过双闸」的交付包（只读真实 config/state）
node scripts/build-delivery.mjs --config <真实 config.json> --state <真实 state 目录>
node scripts/verify-delivery.mjs --dir <stage> --json      # 要 ok:true、隐私 0

# 2) 只打 core（voice/models 不碰）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-full-bundle.ps1 `
  -DeliveryDir <上一步的 stage 目录> -SkipVoice -SkipModels -Stamp <yyyyMMdd-HHmm>
```

产物固定写到 `<本机路径>\qq-bot-full-<stamp>\`（新目录，不覆盖旧的）。

## 4. 参考数字（2026-10-28 06:06 那次重打，stamp `20261028-0615`；你手上包的 stamp 看目录名）

> 每次重打 stamp / 体积 / sha256 都会变，**以产物目录里的 `SHA256SUMS.txt` 为准**；
> 下表是「上一次重打」的实测值，只用来对照「重打有没有成功变大一截」，不是永恒真理——
> 文档跟着包走，包一重打这些数就会落后一轮，这是正常的。

| 项 | 值 |
|---|---|
| 目录 | `<本机路径>\qq-bot-full-20261028-0615` |
| `part1-core.zip` | **2,679,524,694 B ≈ 2,555.4 MiB**（首版 2,660,023,632 B ≈ 2,536.8 MiB） |
| sha256 | `546f053cbd9ba00da769a2e561764aa6387a08b61c5caf9bda02e66e9da0e329` |
| zip 条目 | 47,554 |
| 内嵌 app | `qq-bot-system-20261028-0605`（913 文件 / zip 163,000,528 B ≈ 155.45 MiB / sha256 `1e0a4ae3…`） |
| 构建耗时 | 约 2 分钟（复制 2.5 GiB + store 压缩） |

体积只涨了 19,501,062 B（≈18.6 MiB）：`/client` 页 + desktop 宿主源码 + 安装器 + 新文档，
比首版多的部分都是文本/小文件（表情库体积不变）。

**未重打、原样沿用 2215 目录的两卷**（本轮没有重新计算哈希；下面两行的值抄自
`qq-bot-full-20261027-2215\SHA256SUMS.txt`，那套包本轮未改动）：

```
f35b3b22ed1fbe773a1c857ce41d55216179409395144e080235d5e6e715f37c *part3-voice.zip
45a353a3d16cf8453c1b4f9556d09107eff552dd6b76644f1cc2dd75c303f9d4 *part4-models.zip
```

## 5. 校验清单（拿到包先跑）

```powershell
# 1) 哈希
(Get-FileHash part1-core.zip -Algorithm SHA256).Hash.ToLower()   # 应等于 SHA256SUMS.txt
# 2) 关键内容（应全 YES；app/config.json 应为 NO）
Add-Type -AssemblyName System.IO.Compression.FileSystem
$a=[IO.Compression.ZipFile]::OpenRead('part1-core.zip')
'public/client.html','desktop/Host.cs','scripts/installer/Installer.cs','build-installer.ps1' |
  ForEach-Object { "$_ => " + [bool]($a.Entries | Where-Object { $_.FullName -like "*$_*" }) }
$a.Dispose()
```

## 6. 坑（本轮踩到的）

1. **PowerShell 变量名大小写不敏感**：给脚本加 `-Delivery` 参数时，它和脚本里已有的
   `$DELIVERY` 是**同一个变量**，随后写死的 `$DELIVERY = "...1934"` 会把参数值覆盖掉 ——
   第一次重打（stamp 0348）因此仍然装了旧 app，zip 里没有 `public/client.html`。
   现在参数叫 `-DeliveryDir`。**判断有没有打对，就看 zip 里有没有 `public/client.html`。**
2. **`tar --options zip:compression=store`**：2.5 GiB 约 1 分钟；别改成 Deflate，白耗 CPU
   （里面全是已压缩的 exe/dll/模型）。
3. **交付包里不要再放 `scripts/build-full-bundle.ps1`**：它含构建机绝对路径和日期数字
   （`20261027` 这种 8 位连号），会让交付包隐私闸报 `qq-like-number`。
   已在 `delivery-manifest.json` 的 `exclude.paths` 排除。
4. `MANIFEST.json` 里 `voiceMB`/`modelsMB` 为 0 是**本轮跳过**的意思，不是包缺件；
   体积与哈希看第 4 节的表。
5. **需要用户提供/拍板的**（本轮没动）：
   - 若本机 TTS 或 Ollama 模型以后有变，才需要重打 part3/part4；
   - 三卷都没有代码签名，首次运行会有 SmartScreen 提示；
   - DSH 家目录里的技能/插件版本随构建机，换机器前建议跑一次 `node app/scripts/boot-smoke.mjs`。
