# 发布包说明（RELEASE-MANIFEST）

这个文件随每个发布包一起发出去，说明**包里有什么、怎么装、怎么校验**，以及打包时做了哪些安全处理。

- 版本：见包内 `package.json` 的 `version`
- 打包脚本：`scripts/pack-release.mjs`（`node scripts/pack-release.mjs --help`）
- 三种产物：
  - `QQDeepSeekBot-<version>-<yyyymmdd>-src.zip` —— 源码包（最小，目标机自己 `npm ci`）
  - `QQDeepSeekBot-<version>-<yyyymmdd>-src-offline.zip` —— 离线源码包（自带生产依赖，目标机不用联网装依赖）
  - `QQDeepSeekBot-<version>-<yyyymmdd>-full.zip` —— 额外带 `installer/` 安装程序（零依赖双击安装）
  - 体积差异与原因见文末「为什么源码包只有 ~15 MB」。

## 包里有什么

```
QQDeepSeekBot-<version>-<yyyymmdd>-src.zip           （-src-offline 多一层 node_modules/）
├─ src/                 桥接主程序（Node ESM，无编译步骤）
├─ public/              本地控制台页面（新版客户端控制台）
├─ client/              控制台前端源码分片（构建后落到 public/client.js）
├─ scripts/             安装/构建/测试/自检脚本（只收「换台机器也能跑」的那些）
├─ plugins/             DSH 插件
├─ dsh/                 DSH 侧适配辅助文件
├─ docs/                给使用者看的文档（快速开始/配置/素材库指南/安全边界…）
├─ node_modules/        （仅 -src-offline 包）生产依赖，解压即可 `npm start`
├─ installer/           （仅 -full 包）Windows 安装程序 QQDeepSeekBot-Setup-*.exe
├─ package.json         `npm start` = `node src/bridge.js`
├─ package-lock.json    锁定依赖版本
├─ config.example.json  配置模板（复制成 config.json 再填）
├─ README.md / README.en.md / LICENSE
└─ docs/RELEASE-MANIFEST.md   本文件
```

**不带**：`config.json`（你的真实配置）、`state/`（令牌、台账、缓存）、`dist/`、日志、本机部署脚本（watchdog / 计划任务 / 重启器）。
`node_modules/`：默认源码包不带（目标机 `npm ci` 自己装）；`-src-offline` 包**带生产依赖**（不含 devDependencies）。

## 安装（三步）

1. **准备环境**：装 [Node.js 22 LTS 或更高](https://nodejs.org/)（`node -v` 应 ≥ `v22.13.0`）。
   本程序**不带** DeepSeek Harness（DSH）、也不带 SnowLuma/OneBot 网关——那两个要你自己装好并在 `config.json` 里填地址与 token。
   > 如果你拿到的是 `-src-offline.zip`：依赖已经在包里，**跳过第 2 步的 `npm ci`**，也不需要 `bootstrap.ps1`
   > （那个脚本会去联网装依赖；离线场景直接进第 3 步即可）。
2. **解压 + 装依赖**：
   ```powershell
   # Windows（PowerShell）；macOS/Linux 用 npm ci 那两行即可
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
   ```
   等价的手动步骤：
   ```bash
   npm ci                     # 只会装 package.json 里那几个依赖（-src-offline 包可跳过）
   cp config.example.json config.json   # 然后按 docs/CONFIG-FIELDS.md 填最少 4 项
   node scripts/setup-doctor.mjs        # 体检：哪项没配、怎么修
   ```
3. **启动**：`npm start`，然后打开 `http://127.0.0.1:3100/?token=<state/console-token>`。
   控制台令牌在首次启动后生成于 `state/console-token`（**不要外发**）。

> 如果拿到的是 `-full.zip`：`installer/` 里有安装程序，双击装即可（自带 Node 运行时，不需要上面 1–2 步）。

## 校验完整性（sha256）

打包时会在发布说明里给出 sha256。Windows：

```powershell
Get-FileHash .\QQDeepSeekBot-0.2.1-r1-20261030-src.zip -Algorithm SHA256
```

macOS / Linux：`sha256sum QQDeepSeekBot-*.zip`。与发布说明里的值一致再用。

## 为什么源码包只有 ~15 MB（是不是少了东西？）

不是少东西。源码包里**全部是本仓库自己写的代码、页面和文档**；依赖、运行时、桌面客户端都不在源码包里，
由另外两种交付形态补上。下面的数字都是打包时实测的（`pack-release.mjs` 的清单 + zip 中央目录统计，
版本 `0.2.1-r1` / 20261030）。

| 组成部分 | 实测体积 | 在哪个包里 |
|---|---|---|
| 源码与文档共 678 个文件（src 291、scripts 293、client 38、docs 27、public 10，其余为配置与说明） | 未压缩 22.4 MB → zip 15.3 MB | 三种包都有 |
| 其中 `public/bgm`（3 个背景音乐 mp3） | 8.3 MB | 三种包都有 |
| 其中 `docs/images`（界面截图） | 3.1 MB | 三种包都有 |
| 生产依赖 `node_modules/`：120 个顶层包 / 4205 个文件 | 21.3 MB（未压缩；zip 里约 6.2 MB） | 仅 `-src-offline.zip` |
| Node 运行时 `node.exe` | 88.0 MB | 仅 `-full.zip`（在安装包里） |
| WebView2 三个 DLL（桌面壳用，运行时不随包、靠系统 Edge） | 0.9 MB | 仅 `-full.zip` |
| 桌面客户端 `QQDeepSeekBot.exe` | 0.2 MB | 仅 `-full.zip` |
| 安装程序 `QQDeepSeekBot-Setup-*.exe`（上面这些压缩后的整体） | 55.65 MB（解压后 133.9 MB） | 仅 `-full.zip` |

**三种交付形态对照**（体积为实测 zip 大小）：

| 形态 | 实测体积 | 目标机需要什么 | 适用场景 |
|---|---|---|---|
| `-src.zip` | 15.3 MB / 678 文件 | Node ≥ 22.13，且能联网 `npm ci` | 有开发环境、想要最小包 |
| `-src-offline.zip` | 21.5 MB / 4883 文件 | Node ≥ 22.13（**不需要联网**装依赖） | 目标机没网、但愿意装 Node |
| `-full.zip` | 70.9 MB / 680 文件 | 什么都不用装，双击安装 | 非技术朋友、开箱即用 |

> 注意：**DSH（DeepSeek Harness）与 SnowLuma/OneBot 网关永远不随包**——它们有各自的分发与许可，
> 需要使用者自己装好并在 `config.json` 里填地址与 token。所以再大的包也不会替你把这两个「装上」。

## 安全处理（打包时做的两件事）

**① 净化**：包内的文本副本里，真实 QQ 号（取自本机 `config.json` 的 owner/allow 等字段）替换为 `123456789`，本机绝对路径 `E:\qq-project` → `<repo>`、`<本机路径>` → `<本机路径>`。
只改 zip 里的副本，**不动工作区**；净化后还有残留会直接中止打包（exit 1）。

**② 硬闸**：打包前扫全部文本文件，以下三类**必须 0 命中**，否则不产出 zip：

| 类别 | 规则（匹配「值」不匹配「名字」） |
|---|---|
| 令牌 | `state/console-token` 的实际值（逐字比对） |
| API key | `sk-` 后接 20+ 位字符、`bigmodel` 附近的长十六进制串、配置里非空的 apiKey 真值 |
| Cookie | `_plaza_session_id` 的长值、`booth_session` 的值、请求头里带 booth 的整条 cookie、BOOTH 登录态的 cookie 数据形状 |

> **唯一例外**：测试夹具里刻意写的假凭据（以 test/fake/dummy 开头之类、或值里带 `abc123`)在 `scripts/test-*.mjs` 与 `scripts/fixtures/**` 内放行，并在打包日志里逐条列出「按测试假值放行」。
> 理由：这些测试要真跑就得带假凭据；不放行只能把测试删了或者每次打包必红，那才是变相放松。换成真 key 混进测试文件照样会被拦。

`-src-offline.zip` 里的 `node_modules/` 同样逐文件过上面两道闸（它是第三方代码，跟仓库代码一视同仁）；
打包时还会额外检查包里没有 `node_modules/.bin`、`.cache`、`.package-lock.json` 这些目标机不需要的运行时垃圾。

## 许可证与再分发

本包按仓库 `LICENSE` 分发；第三方组件与再分发边界见 `docs/THIRD-PARTY.md`、`docs/开源说明.md`（若包内没有这份，说明打包时仓库还没写，请以 `LICENSE` + `docs/THIRD-PARTY.md` 为准）。
DSH、SnowLuma、模型服务各有自己的许可与条款，不随本包提供。
