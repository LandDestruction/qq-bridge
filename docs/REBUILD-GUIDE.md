# 灾备手册：拿到一份包，把整套机器人系统重新跑起来

> 读者假设：**原机器可能没了、原来的人可能不在**，你手上只有这份交付包和这堆文档。
> 本手册写的是「怎么重建」，不是「怎么开发」。开发看 `docs/FOLDER_MAP.md`，日常运维看 `docs/OPERATING.md`，出包看 `docs/release-runbook.md`。
> 全文不含任何真实 token / QQ 号 / 群号 / 群友昵称 / 本机绝对路径：一律写作 `<QQ号>`、`<群号>`、`<仓库根>`、`<本机路径>`。

---

## 0. 先判断你在哪种情况（30 秒）

| | 你现在的处境 | 去哪节 | 需要重新申请账号吗 | 现实耗时（熟手 / 生手） |
|---|---|---|---|---|
| **A** | 机器还在，只是坏了（进程崩、配置改坏、升级失败、迁移后路径变了） | [§A](#a-机器还在只是坏了) | 不需要 | 15–30 分钟 / 1–2 小时 |
| **B** | 机器没了，换一台新电脑，但**账号和 key 你都还有** | [§B](#b-机器没了换一台新机器) | 部分（DSH 可能要重新登录） | 60–120 分钟 / 半天 |
| **C** | **只有这个 zip**：源码仓库、原机器、原来的 key 全没了 | [§C](#c-只有这个包连源码仓库都没了) | **要，5 样**（见 §C2） | 2–6 小时，其中大半在等审核/扫码/下载 |

一句话判据：**能不能在 1 分钟内说出你的模型 key 和 QQ 小号密码？** 能 → A 或 B；不能 → C。

不管哪一节，先跑这一条命令，它会告诉你「你现在缺什么、下一步做第几步」（详见 §G）：

```powershell
node scripts\verify-rebuild.mjs
```

---

## 1. 这台「机器人系统」到底是什么

### 1.1 五个部件的链路

```
QQ 客户端（对方的号，扫码登录）
   ↕
SnowLuma  —— QQ 网关（第三方；OneBot v11：HTTP :3000 / WebSocket :3001）
   ↕  OneBot WS + accessToken（两边必须一致）
qq-bridge —— 本仓库（Node >= 22.13；控制台 :3100）
   ↕  DSH 本地 HTTP/WS（DSH 桌面应用，本机常见 :13707）
DeepSeek Harness（DSH，模型运行时；启动时加载 MCP 与 preset）
   ↕
模型 API（DSH 内已登录的 DeepSeek 账号，或自加的 OpenAI 兼容端点）
```

**三件必须记住的事**：

1. **桥接不直接调模型**。它只把 QQ 消息变成 DSH 的 prompt、把回复发回 QQ。所以「用哪个模型」在 DSH 里定，`config.json` 的 `dsh.provider/model` 只是偏好。
2. **MCP 工具是 DSH 启动时加载的**。`qq_*` 工具不在，二代仿真模式就什么都干不了（不会看未读、不会回、不会潜水）。**改 MCP/预设后必须重启 DSH，重启桥接没用。**
3. **人设是四件套**：`roles/*.md` 角色卡 + `state/current-role.json` 选择 + `dsh/agent-presets/qq-chat-v2/` 的预设前缀 + `socialV2.initialPromptMaxChars`。缺一样，交付出去的是「会回话的客服」，不是原来那个它。

### 1.2 端口表（谁占哪个口）

| 端口 | 谁在听 | 用途 | 起不来会怎样 |
|---|---|---|---|
| 3000 | SnowLuma | OneBot HTTP（取成员、直链） | 部分功能退化，消息还能收 |
| 3001 | SnowLuma | OneBot WebSocket | **收不到任何 QQ 消息** |
| 3100 | qq-bridge | 控制台 / REST（无 token 访问返回 401） | 抢不到就启动失败 |
| 13707 | DSH 桌面应用 | 桥接用的本地端点（因机而异，桥接可自动发现） | `dshReady=false`，消息进不了 agent |
| 7863 | wb2api 中转 | 可选，OpenAI 兼容 | 用到它才需要 |
| 11434 | ollama | 可选，本地兜底 | 不影响主链路 |
| 8791 / 8765 | STT / 本地 TTS | 可选 | 语音能力缺失 |

### 1.3 启动顺序（顺序错了会看到假故障）

**DSH → SnowLuma →（可选的本地模型服务）→ qq-bridge → 打开控制台**。

反过来先起桥接，它会报 `dshReady=false` 并反复重连；这不是桥接坏了，是 DSH 没起来。

### 1.4 哪些数据「丢了就重建不出来」

| 路径 | 里面是什么 | 丢了会怎样 |
|---|---|---|
| `state/` | 消息库、`social-v2.json`（会话/未读/唤醒）、`console-token`、`affinity.json`、`people.json`、表情库、`token-usage.jsonl` | **记忆与人格关系全断**：跨会话摘要、好感度、表情、群友档案归零，且**没有任何办法重建**（这些是几个月聊出来的） |
| `config.json` | 白名单、token、模型选型 | 要重填，能重建但费时 |
| `roles/` + `state/current-role.json` | 人设 | 人设还在但「它不记得自己是谁」；角色卡本身丢了就真丢了 |
| `dsh/` + `plugins/` | MCP 与预设（DSH 侧） | 可重装（`scripts/setup-dsh.mjs`），但 preset 里的调校是手写的 |
| `logs/` | 排障证据 | 只影响定位问题，不影响运行 |

> **结论**：`state/` 是唯一不可再生的东西。§A 第一件事就是备份它，§F 有日常备份清单。

---

## A. 机器还在，只是坏了

适用：进程崩了/起不来、配置被改坏、刚做完目录迁移、DSH 升级后连不上、两实例互抢。**账号与 key 都还在。**

### A0 先做三件事，再动手修（顺序不能反）

**① 先停写。** 带病运行的桥接会继续写 `state/`，你修的每一下都可能覆盖掉还能救的数据。

```powershell
# 找还在跑的桥接：锁文件里的 PID + 命令行兜底
Get-Content state\bridge.lock -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*bridge.js*' } |
  Select-Object ProcessId, CommandLine
```

看到 PID 就 `Stop-Process -Id <PID> -Force`，然后确认控制台端口真的空了：

```powershell
Get-NetTCPConnection -LocalPort 3100 -ErrorAction SilentlyContinue
```

**判据**：这条命令**没有输出**（没有监听）。有输出说明还有实例活着，回到上一步。

**② 全量备份（这一步别省）。** 备份到另一块盘或 U 盘，**不要在同一个目录里复制**：

```powershell
robocopy state "<备份盘>:\qqbot-backup\state-%DATE%" /E /R:1 /W:1
copy config.json "<备份盘>:\qqbot-backup\config-%DATE%.json"
robocopy roles "<备份盘>:\qqbot-backup\roles-%DATE%" /E
```

**判据**：备份目录里的 `state\social-v2.json` 能打开、`state\console-token` 存在。大小与原目录同量级（不是 0 字节）。

**③ 留证。** 把这两段日志拷出来再往下走，修的时候它们会被覆盖：

```powershell
copy logs\bridge-stdout.log "<备份盘>:\qqbot-backup\stdout-%DATE%.log"
copy state\bridge.log "<备份盘>:\qqbot-backup\bridge-%DATE%.log"
```

### A1 恢复顺序（照着顺序做，每步都有判据）

| # | 动作 | 命令 | 判据（怎么知道这步成了） | 失败怎么办 |
|---|---|---|---|---|
| 1 | 检查 Node | `node -v` | `v22.13` 以上 | 低于就重装 Node 22 LTS；`node:sqlite` 缺失会让桥接直接起不来 |
| 2 | 起 DSH 并登录 | 从桌面启动 DSH | DSH 里能新建会话并正常对话 | 见矩阵 #1/#2；装不上只能换机器 |
| 3 | 确认 MCP 与 preset 还在 | `node scripts\setup-dsh.mjs desktop`（幂等，重复跑安全） | 输出里有 MCP 三条 + preset 两条 | profile 名不对就去 `%USERPROFILE%\.dsh\profiles` 看真实目录名 |
| 4 | **重启 DSH** | 关掉 DSH 再开 | 新会话的预设列表里有「QQ 聊天角色（二代仿真）」，工具里能看到 `mcp__snowluma__*` | 没出现 = 没重启，或 setup 写到了别的 profile |
| 5 | 起 SnowLuma | 打开 SnowLuma，扫码登录 | 界面显示在线；`Get-NetTCPConnection -LocalPort 3001` 有监听 | 见矩阵 #4/#5 |
| 6 | 核对 config.json | `node -e "JSON.parse(require('fs').readFileSync('config.json','utf8'))"` | 无输出即合法 | 有输出说明 JSON 坏了，用 §A0 的备份覆盖回来 |
| 7 | 起桥接 | `node src\bridge.js`（或 `start.bat`，带崩溃自拉） | 日志出现「SnowLuma 已连接」「dshReady=true」，`http://127.0.0.1:3100` 能打开 | 见 §A2 与矩阵 #6 |
| 8 | 确认模式与白名单 | 打开控制台 | 模式是 **reserved2（二代仿真）**；`allow.groups` 里有目标群 | 见矩阵 #9 |
| 9 | 真机一句 | 群里 @ 它一下 | 10–60 秒内有回复；`state\bridge.log` 有本轮记录 | 没反应看矩阵 #9/#13 |

**如果 config.json 已经彻底坏了**（备份也没了）：`copy config.template.json config.json`（包内应有；没有就用 `config.example.json` 当骨架但**要删掉 `modelFallbacks` 里失效的 `scnet` 那几条**，并把 `workspaceTitle` 的乱码改掉）。然后只填这 4 个值：`ownerQQ`、`allow.groups`、`snowluma.accessToken`、`dsh.baseUrl`（不确定就留空，桥接会自动发现）。

### A2 「坏了」的四种典型长相

**① 起不来 / 一启动就退出**

- 日志：`bridge already running in another window`（退出码 2）→ 已有实例在跑，别起第二个。两个实例会互抢 3100、互相覆盖 `social-v2.json`，**这是最脏的一种事故**。
- 日志：`EADDRINUSE` → 3100 被占，见矩阵 #6。
- 什么日志都没有 → 看 `logs\bridge-stdout.log` 尾部；再看是不是 `.ps1` 被执行策略拦了（矩阵 #7）。

**② 起来了，但每轮只回「agent 处理出错」（群里永远零回复）**

- 日志关键行：`workspace/invalid-path ... ENOENT ... realpath`。
- 根因：会话在 DSH 侧挂的工作目录已不存在（典型是目录迁移/改名后）。桥接复用旧会话 → DSH 每轮抛错 → 每轮重复坏。
- 处置（新版自带守卫，重启即自愈）：**重启桥接**即可；旧版需手动把这个会话从 `state\social-v2.json` 的会话映射里删掉，让它重建。新版行为见 `scripts\test-session-cwd-guard.mjs`。
- 判据：群里再发一句有回复；日志不再出现 `invalid-path`。

**③ 有回复，但「不是它了」**

按这个顺序查，别一上来改代码：

1. `state\current-role.json` 指的角色卡还在不在（`roles\<角色卡>.md`）；
2. `config.json` 的 `dsh.provider/model` 是不是指向了一个不存在的模型（见矩阵 #3）；
3. DSH 侧 `cordis.patch.yml` 里的 preset 段还在不在（`setup-dsh.mjs` 重跑能补）；
4. 如果它「变笨/变冷淡」：先读 `docs/why-silly.md`，别急着调参数——多半是思考强度与提示前缀，不是坏了。

**④ state 里的 JSON 半截 / 数据回退**

- 现象：好感度突然全没、表情少了一半、未读乱跳。
- 根因：两个实例同写，或写盘时被强杀。当前版本用原子写缓解，但**双实例照样会互相覆盖**。
- 处置：停所有实例 → 用 §A0 的备份覆盖 `state\` → 只起一个实例。**永远不要「边跑边覆盖」**。

### A3 本节需要对方自备什么

| 自备 | 说明 |
|---|---|
| 能登录原机器桌面 | 若是远程/无头机器，先解决远程访问 |
| 一块可写的备份盘 | 不允许在原盘原地备份（磁盘坏了会一起没） |
| DSH 账号 / 模型 key | 通常 DSH 里还存着；若要重新登录就需要 |
| QQ 手机（扫码） | SnowLuma 掉登录后要重新扫码，风控时还需要验证 |
| 15 分钟耐心 | 别跳步；跳一步，后面全是假故障 |

---

## B. 机器没了，换一台新机器

适用：旧电脑报废/重装/换人接手，但**账号和 key 你都有**。目标只有一个：**群里说一句，它有反应。**

### B0 先看这张「自备清单」（发给别人时直接抄这段）

| 必须自备 | 具体 | 没有会怎样 |
|---|---|---|
| Windows 10/11 x64 | 8 GB 内存起、10 GB 空闲盘 | 跑不动 / 装不下 |
| **Node.js 22.13+** | 官网 LTS 安装包 | `npm install` 与启动直接失败（用到内置 `node:sqlite`） |
| **DSH 桌面应用** | 官方下载页自行安装（**我们不随包**，闭源商业应用） | 桥接起来了但 `dshReady=false`，消息进不了 agent |
| **模型账号或 key** | DSH 登录自己的 DeepSeek 账号，或在 DSH 里自加 OpenAI 兼容端点 | 没有模型层，它只会沉默 |
| **SnowLuma**（或其他 OneBot v11 实现） | 官方 releases 自行下载（第三方，非商业许可） | 收不到任何 QQ 消息 |
| **一个能扫码的 QQ 小号** | 建议不用主号 | 网关登不上，整个系统零输入 |
| 桥接交付包 | 本 zip | — |
| 可选 | ffmpeg（视频抽帧/转写）、Python + faster-whisper（语音转写）、ollama（本地兜底） | 对应能力缺失，其余正常 |

### B1 从零到「它有反应」的 10 步

> 每步都给了判据。**判据不过不要往下走**——后面每一步都会在错误的基础上报假错。
> 命令统一用 `powershell -NoProfile -ExecutionPolicy Bypass -File ...` 形式，避免执行策略（矩阵 #7）。

| # | 动作 | 具体命令 | 判据 | 失败处置 |
|---|---|---|---|---|
| 1 | 装 Node | 官网 LTS | `node -v` ≥ v22.13 | 低于重装；不要用便携版混 PATH |
| 2 | 装 DSH、登录账号 | 官方下载页 → 启动 → 登录 | DSH 里能新建会话并对话 | 矩阵 #1/#2/#3 |
| 3 | 解压包并装依赖 | `cd <仓库根>` 然后 `npm ci`（首次也可 `npm install`） | exit 0，且 `node_modules\@snowluma` 存在 | 矩阵 #8 |
| 4 | 生成 config | `copy config.template.json config.json` | 文件存在 | 模板缺失说明包不完整，见 §C4 |
| 5 | 填 4 个必填值 | 见 §B2 | `node -e "JSON.parse(require('fs').readFileSync('config.json','utf8'))"` 无输出 | 缺逗号/中文引号是最常见错 |
| 6 | 装 DSH 侧 | `node scripts\setup-dsh.mjs desktop` | 输出 MCP×3 + preset×2 | profile 名不对：去 `%USERPROFILE%\.dsh\profiles` 看实际目录名 |
| 7 | **重启 DSH** | 关掉再开 | 新会话有「QQ 聊天角色（二代仿真）」+ `mcp__snowluma__*` | 没重启 = 白做；写到别的 profile 也会看不到 |
| 8 | 装 SnowLuma、扫码、开 OneBot | 设 accessToken，端口 3000/3001 | `get_login_info` 能返回你那串 QQ 号 | 矩阵 #4/#5 |
| 9 | 启动并自检 | `node scripts\setup-doctor.mjs` 然后 `start.bat` | doctor exit 0；日志「SnowLuma 已连接」「dshReady=true」；3100 能开 | 按 doctor 的「→」逐条修 |
| 10 | 收尾验收 | 控制台切 reserved2，群里 @ 一句 | **10–60 秒内有回复**，控制台活动流有本轮 | 矩阵 #9/#13 |
| 11 | 一次重建自检 | `node scripts\verify-rebuild.mjs` | 全 ✓（或只剩「可选组件」的 ⚠） | 按输出的「下一步」回本节对应步骤 |

### B2 只填这 4 个值

```jsonc
{
  "snowluma": { "accessToken": "<SnowLuma 里你设的 OneBot token>" },
  "dsh":      { "baseUrl": "http://127.0.0.1:<DSH 端口；不确定就留空自动发现>" },
  "allow":    { "groups": ["<群号>"] },
  "ownerQQ":  <QQ号>
}
```

- `consoleToken` 留空会自动生成到 `state\console-token`，不用手填。
- **模板里的 `0` 也是占位**：`ownerQQ` 可能是 `0`、`allow.groups` 可能是 `[0]`，都必须换成真实值。留着 0 的表现是「日志全绿、群里全程沉默」（0 不属于任何群）；`scripts\verify-rebuild.mjs` 会把 0 判成未填。
- **不要往 config 里写 `socialV2`**：它是浅合并，写了哪怕一个子项，整套默认（工具开关/唤醒/记忆）就被这个小对象替换掉，表现为「它突然什么都不会了」。
- `workspaceTitle`、`agentPreset` 用默认即可。

### B3 时间估计（照实说，不吹）

| 人的状态 | A 档（重装同构） | B 档（全新机器） |
|---|---|---|
| 熟手（做过一次、账号都是现成的） | 15–30 分钟 | 60–120 分钟 |
| 生手（第一次见这套东西） | 1–2 小时 | 半天 |
| 卡点上限 | 模型 key 失效/额度 | DSH 安装包下载（约 1 GB）、QQ 扫码风控、npm 拉依赖 |

**不要对外承诺「30 分钟搞定全新机器」**——能承诺的只有 A 档。

### B4 本节需要对方自备什么

见 §B0 那张表，其中**只有这 5 样是硬的**：Windows 机器、Node 22.13+、DSH（自装）、SnowLuma（自装）+ QQ 小号、模型账号/key。

---

## C. 只有这个包（连源码仓库都没了）

适用：原机器没了、原仓库没了、原来的人也不在了，你手上只有一个 zip 加这堆文字。
**这一节的核心不是技术，是「哪些东西必须重新申请、要等多久」。**

### C1 包里应该有什么 <!-- 待 D43 manifest 定稿后对齐 -->

```powershell
# 解压后先数文件，再谈别的
Get-ChildItem -Recurse -File | Measure-Object | Select-Object Count

# 必须存在的 8 类东西（任缺一类，这个包不完整）
Test-Path package.json                                  # Node 工程与依赖清单
Test-Path src\bridge.js                                 # 桥接主进程
Test-Path scripts\setup-dsh.mjs                         # DSH 侧安装（MCP + preset）
Test-Path dsh\agent-presets\qq-chat-v2\agent.cordis.yml # 预设前缀（人格的骨架）
Test-Path plugins\qq-agent-presets\package.json         # DSH 插件
Test-Path assets                                        # 控制台静态资源
Test-Path config.template.json                          # 配置模板（全部占位符）
Test-Path docs\REBUILD-GUIDE.md                         # 本手册（能读到这句就说明在）
```

**判据**：上面每一行都是 `True`；文件总数与交付清单（`scripts\delivery-manifest.json`，若包内附带）一致。

**注意包里刻意没有的东西**（不是漏了，是**不能给**）：`state\`（真实群聊与群友 QQ）、`logs\`、`config.json`、`audio\`（真人声线）、私人角色卡、任何 token / key。
**唯一的例外**是表情库：`state\stickers.json` 与 `state\sticker-files\` 会随包（默认带、已脱敏、可删），见 [§E](#e-表情库是可选件吗)。

### C2 必须先申请的 5 样东西（按「等待时间」排序，先启动最慢的）

| # | 东西 | 从哪来 | 典型等待 | 没有会怎样 |
|---|---|---|---|---|
| 1 | **DSH 桌面应用** | 官方下载页（不随包） | 下载 ~1 GB，10–40 分钟 | 没有模型层，桥接永远是空壳 |
| 2 | **DSH 授权/账号** | 在 DSH 里登录自己的账号 | 登录 1 分钟；新号/企业授权可能要审 | `dshReady=false` 或会话建不起来 |
| 3 | **模型 key 或额度** | DeepSeek 账号余额，或自备 OpenAI 兼容端点 + key | 现成 1 分钟；充值/开额度 10 分钟–1 天 | 能收消息、生成不了回复（表现为「想了很久然后没声」） |
| 4 | **QQ 小号 + 扫码** | 自己注册/备用号，手机扫码 | 10 分钟；新号有风控冷期（数小时–1 天） | 零输入：一条消息都收不到 |
| 5 | **SnowLuma 安装 + OneBot 开启** | 官方 releases 自行下载（第三方，非商业许可） | 10–30 分钟 | 同上，收不到消息 |

> 顺序建议：**先点 DSH 下载（最久）→ 同时装 Node → 再弄 QQ 小号**。等 DSH 下完再开始扫码，总时间能压到 2 小时出头。

### C3 从 zip 到「群里说一句有反应」

技术步骤与 §B1 完全相同（第 1–11 步），只在最前面插两步：

| # | 动作 | 判据 |
|---|---|---|
| 0a | 解压到**短路径、纯英文**目录（如 `D:\qqbot`） | 路径里没有空格/中文（省掉一堆引号与编码坑） |
| 0b | 跑 §C1 的 8 行 `Test-Path` | 全 `True` |
| 1–11 | 照 §B1 走 | 同 §B1 |

### C4 先证明「这个包没坏」再动手（5 分钟，离线）

```powershell
node scripts\verify-rebuild.mjs      # 缺什么、下一步第几步，一次列清
node scripts\setup-doctor.mjs        # 环境面：依赖/端口/配置是否够启动
node scripts\test-session-cwd-guard.mjs   # 纯离线套件，不碰网络/state
node scripts\test-affinity.mjs            # 同上
```

**判据**：`verify-rebuild` 输出里「文件」段没有 ✗（缺文件说明包不完整，先找发包的人要）；两个 `test-*` 都是 exit 0。**离线套件能跑通 = 代码完整且 Node 版本够**。

### C5 本节需要对方自备什么

就是 §C2 那 5 样，外加：一台能长期开着的 Windows 电脑（机器人是常驻进程，笔记本周六关机它就掉线）、一个能收手机验证码的手机（QQ 风控）。

---

## D. 极端情况矩阵

> 每行格式：**现象 → 一句话根因 → 处置命令 → 怎么确认已恢复**。
> 这只是「常见坑」，不是穷举；拿不准时先跑 `node scripts\verify-rebuild.mjs` 看它怎么说。

| # | 现象 | 根因（一句话） | 处置命令 | 确认已恢复 |
|---|---|---|---|---|
| 1 | DSH 安装包下不动 / 装到一半被杀软删文件 / 双击没反应 | 网络被限速、杀软误判、系统版本不满足 | 换网络重下；把安装目录加杀软白名单；确认是 x64 系统 | DSH 能启动并登录，`Get-NetTCPConnection -LocalPort 13707` 有监听 |
| 2 | DSH 起来了，但桥接一直 `dshReady=false`，或日志里 agent 反复报错 | 桥接与 DSH 的协议代际不匹配（端点/认证方式变了） | `node scripts\verify-dsh-021-adaptation.mjs` 看适配检查；必要时把 DSH 换回文档标注的版本 | 日志出现 `dshReady=true`，群里发一句有回复；`/api/status` 里 `dshReady=true` |
| 3 | 能收消息、它「想了想」然后没声；或回复是空/报错 | 模型 key 失效、额度用光，或 `dsh.provider/model` 指向 DSH 里不存在的模型 | 在 DSH 里手动新建会话发一句，看是否报错；`node scripts\probe-model-routing-live.mjs` 看选到了哪个模型 | DSH 里能正常对话，且桥接日志里模型不再是失效项；群里回复正常 |
| 4 | SnowLuma 登录失败 / 掉线 / 扫码后马上掉 | QQ 风控、二维码过期、新号冷期、同号在别处登录 | 重新扫码；换手机网络；冷期就等；确认没有第二个进程用同号 | SnowLuma 界面显示在线，且 `Get-NetTCPConnection -LocalPort 3001` 有监听 |
| 5 | 启动报 `EADDRINUSE`，或 SnowLuma 说端口被占 | 3000/3001 被别的程序（或上一个 SnowLuma 实例）占了 | `Get-NetTCPConnection -LocalPort 3000,3001` 找出占用 PID 后停掉；或改 SnowLuma 的 OneBot 端口并同步 `config.snowluma` | 两个端口都可连；桥接日志「SnowLuma 已连接」 |
| 6 | 桥接启动即退出，提示控制台端口被占 / 打不开 3100 | 3100 被上一个实例占着（常见于「重启」其实起了第二个） | `Get-Content state\bridge.lock` 拿 PID → `Stop-Process -Id <PID> -Force`；确认 `Get-NetTCPConnection -LocalPort 3100` 无输出再启动 | 只有一个 node 进程跑 `bridge.js`；3100 能打开 |
| 7 | 双击 `.ps1` 一闪而过 / 报「禁止运行脚本」 | PowerShell 执行策略是 Restricted | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-project.ps1 -DryRun`（所有 .ps1 都用这个前缀） | 脚本正常输出到结束，无红字 |
| 8 | `npm ci` 报错 / 卡在 `@snowluma` / peer 冲突 | 网络到 npm 官方源慢、peer 依赖冲突、缺 `node_modules` 离线拷贝 | `npm config set registry https://registry.npmmirror.com` 后重试；或从能装的机器整目录拷 `node_modules`（**必须含 `@snowluma` 与 `.bin`**） | `node -e "require('js-yaml')"` 无报错；`node_modules\@snowluma` 存在 |
| 9 | 全程静默：SnowLuma 在线、桥接也起来了，群里就是不回 | `allow.groups` 里没有这个群（或写了全角数字/带了空格） | 打开控制台看白名单；改 `config.json` 的 `allow.groups`（热加载，约 1 秒生效，不用重启） | 群里 @ 一句 10–60 秒内有回复；控制台活动流有本轮记录 |
| 10 | 高峰时段回复变慢/换了个笨模型/偶尔报错 | 高峰走的备用模型（MiMo 等）不可用，**自动降级 fallback 是预期行为，不是 bug** | 什么都不用做；要确认就看 `docs/peak-mimo-verification.md` 与 `config.json` 的 `dsh.modelFallbacks` | 群里回复正常；降级链里有可用项；日志出现 fallback 记录但无异常退出 |
| 11 | 文字正常，但它「看不见图 / 听不见语音 / 视频只有个时长」 | 没配视觉模型（`dsh.visionModels` 里没有真正支持图片的模型）、没装 ffmpeg，或 STT 没起 | 装 ffmpeg 并进 PATH；`dsh.visionModels` 指到真实支持图片的模型；`socialV2.modelForMedia` 打开；STT 起在 8791 | 发一张图，它描述得出画面内容；`/api/status` 无媒体相关报错 |
| 12 | 好感度全没 / 表情少一半 / 未读乱跳 | 两个实例同写 `state`，或写盘时被强杀导致 JSON 半截 | 停掉**所有** node 进程 → 用备份覆盖 `state\` → 只起一个实例 | `state\social-v2.json` 能 `JSON.parse`；数据回到备份时刻；日志无并发写告警 |
| 13 | 每轮都记「agent 处理出错」，群里零回复，日志有 `workspace/invalid-path` / `ENOENT realpath` | 会话在 DSH 挂的工作目录已不存在（目录被移动/改名/删除） | 重启桥接（新版守卫会自动重建会话）；旧版删 `state\social-v2.json` 里对应会话映射 | 日志不再出现 `invalid-path`；群里再发一句有回复 |
| 14 | QQ 号被限/被踢：SnowLuma 频繁重连、发不出消息 | 触发风控（新号、发太快、敏感内容、多设备登录） | 停桥接 → 降频（`sendDelayMs` 调大）→ 换号或等风控解除 | SnowLuma 稳定在线 30 分钟无重连；能正常收发 |
| 15 | 突然全部 401 / 证书错误 / token 莫名失效 | 系统时间偏差过大（证书校验失败），或 `console-token` 被换掉 | 校准系统时间（自动同步）；读 `state\console-token` 用正确的 token 访问 /api/status | `curl -H "x-console-token: <token>" http://127.0.0.1:3100/api/status` 返回 200 |
| 16 | 表情库导入后出现重复卡片：面板里同一张表情占两张卡 | 同一张图被 QQ 重新编码后 md5 变了，而历史记录缺 `dhash` 认不出来；或早期版本重复收藏过 | **不用手动删。** 重启桥接后每轮会自动补 60 条 dHash，2–3 轮自动收敛（去重键 = dHash 汉明距离 ≤1 + fileid 身份键，见 `docs/handoff-sticker-dedupe.md`） | `GET /api/stickers` 的 `total` 稳定不再涨；面板里同一张只剩一张 |

---

## E. 表情库是可选件吗？

**默认带。但它可以删，删了不影响收发消息。**

| 项 | 内容 |
|---|---|
| 带什么 | `state/stickers.json`（数百 KB 量级，200+ 条表情记录）+ `state/sticker-files/`（200+ 个图片文件，约 150 MB，随收集增长） |
| 为什么带 | 表情是「像人」的一部分，而且是长期攒下来的，重建不出来 |
| 怎么删 | 删掉 `state/stickers.json` 与 `state/sticker-files/` 这两个路径即可 |
| 删了会怎样 | 文字聊天、收图、发语音、看图全部照常；只是它自己的表情包从「满的」变成「空的」，要重新攒 |
| 体积提醒 | 带表情的包会到 **120 MB+** 量级（大头是图片），下载/拷贝时别以为是包坏了 |

**这些图片来自群聊，可能包含群友头像或聊天截图。** 如果接收方不接受，按上表删掉这两个路径即可，其余功能不受影响。

### E.1 脱敏口径（发包方执行，接收方可以自查）

> 表情库是 `state/` 下唯一的白名单例外：**除它之外，`state/` 依旧整目录不随包**。

| 字段 | 处理 | 为什么 |
|---|---|---|
| `id` / `resId` / `emojiId` / `md5` / `dhash` / `url` / `fileid` / `policy` / `thumbStatus` / `useCount` / 时间戳 | **原样保留** | 删了表情就发不出去（`url` 里的 fileid/rkey 是功能必需的） |
| `collectedBy`（群友昵称） | → `<群友>` | 人名 |
| `collectedContext` / `lastContext`（抓取时的群聊原话） | 清空（或 `<已脱敏>`） | **这是群聊原文，必须清** |
| `source` / `collectedFrom`（形如 `group:<群号>`、`观察群 <群号>`） | 群号 → `<群号>`，保留「某个群」的语义 | 群标识 |
| `desc` / `localNote` / `tags` / `usage` | 保留，但同样过一遍群号/QQ 号脱敏 | 我们自己写的注释，没有隐私 |

**自查三句**（在解压目录跑）：

```powershell
# 1) 只查「该脱敏的字段」——url/fileid 里本来就有长数字（功能必需），不能整体扫
node -e "const j=require('./state/stickers.json');const a=Array.isArray(j)?j:(j.stickers||j.items||Object.values(j));const R=/(?<!\d)\d{6,9}(?!\d)/;const bad=a.filter(s=>R.test([s.collectedBy,s.collectedContext,s.lastContext,s.source,s.collectedFrom].filter(Boolean).join(' ')));console.log('可疑条数:',bad.length,'/',a.length)"
# 2) 不该有 .bak 备份文件
Get-ChildItem state -Filter "*stickers*.bak*"
# 3) 抓取时的群聊原文应该已经清空
node -e "const j=require('./state/stickers.json');const a=Array.isArray(j)?j:(j.stickers||j.items||Object.values(j));console.log('还留上下文的条数:',a.filter(s=>(s.collectedContext||'').length>2||(s.lastContext||'').length>2).length)"
```

判据：第 1 句「可疑条数: 0」、第 2 句无输出、第 3 句「还留上下文的条数: 0」。任一不合格，退回发包方。

> 为什么不能整体扫：`url` 里的 fileid/rkey 本身就是长数字串（实测 42 条命中 57 处），把表情发出去要靠它。整体扫会永远红，等于闸门失效。

---

## F. 灾前 10 分钟：平时该备份什么（建议写进日常）

```powershell
robocopy state "<备份盘>:\qqbot-backup\state" /MIR /R:1 /W:1
copy config.json "<备份盘>:\qqbot-backup\config.json"
robocopy roles "<备份盘>:\qqbot-backup\roles" /MIR
robocopy dsh   "<备份盘>:\qqbot-backup\dsh"   /MIR
```

- 频率：**改完配置就备份一次**；平时每天一次足够（`state/` 里最值钱的是 `social-v2.json`、`affinity.json`、`people.json`、表情库）。
- 别备份：`logs/`（没价值）、`node_modules/`（能重装）、`dist/`。
- 备份完做一次「能不能打开」的检查：`Get-Content <备份盘>:\qqbot-backup\state\social-v2.json -TotalCount 1` 有内容。

---

## G. 自检脚本：`scripts/verify-rebuild.mjs`

```powershell
node scripts\verify-rebuild.mjs            # 人读：✓/✗ 清单 + 最后一行「下一步做第几步」
node scripts\verify-rebuild.mjs --json     # 机读
node scripts\verify-rebuild.mjs --no-net   # 断网/不想探测端口时
```

它检查五件事，**只读、不写任何文件、不打印任何配置值**：

| 段 | 检查什么 | 失败意味着 |
|---|---|---|
| 环境 | Node 版本、PowerShell 版本、磁盘余量 | 这台机器现在还不具备条件（§B1 第 1 步） |
| 文件 | 交付清单（manifest）里每条在不在；`config.json` 的必填项是否还是占位符；表情库带没带（可删项，缺了只警告） | 包不完整（§C1/C4）或配置没填（§B2） |
| 服务 | 3000/3001/3100 能否连；`/api/status` 的 `dshReady` / `snowluma` / `paused` | 哪一环没起来（§A1 第 2–7 步） |
| 依赖 | `node_modules` 是否可用（能不能 `require('js-yaml')`）、DSH 是否可达 | §B1 第 3 步 / 矩阵 #8 |
| 文档 | 本手册引用的每个路径在不在包里 | 手册与包不同步（对方会照着手册踩空） |

最后一行永远只有一句：**「下一步：<手册小节号> — <一句话动作>」**。截图发给谁都看得懂。

退出码：`0` 全绿（可能有可选组件 ⚠）、`1` 有阻断项、`2` 用法错误。

---

## H. 相关文档

| 文档 | 什么时候看 |
|---|---|
| `docs/QUICKSTART.md` | 第一次上手，最短路径（与 §B 互补） |
| `docs/guides/DSH_SETUP.md` | DSH 侧的 MCP / preset 详细装法 |
| `docs/EXTERNAL-DEPENDENCIES.md` | 每个外部件的版本、许可、下载地址 |
| `docs/delivery-package-spec.md` | 交付包该有什么、什么不能给、三档交付口径 |
| `docs/release-runbook.md` | 出包/验证/回滚（给发包的人） |
| `docs/restart-acceptance.md` | 每次重启后要验的清单 |
| `docs/OPERATING.md` | 日常运维 |
| `docs/FOLDER_MAP.md` | 目录与脚本命名约定 |
| `docs/why-silly.md` | 它「变笨/变冷淡」时先看这个，别先改代码 |
