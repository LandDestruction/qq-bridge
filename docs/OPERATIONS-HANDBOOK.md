# 运维手册（公开版）

> 本文件是主窗口 `MAIN-HANDOFF.md` 的**可公开子集**（去掉了内部协作、窗口编号、私人约定），
> 补上第三方安装与重建清单。目标：拿到包的人只靠这份 + `DELIVERY-README.md` 就能长期自己维护。

## 1. 环境事实

| 项 | 值 |
|---|---|
| 控制台 | **面板 `http://127.0.0.1:3101`**（常驻，桥接挂了也在）；桥接自己那份 `http://127.0.0.1:3100` 只在桥接活着时能开。token 在 `state/console-token`（首次启动自动生成） |
| 端口 | 网关 OneBot HTTP 3000 / WS 3001；桥接控制台 3100；面板常驻进程 3101（只发页面 + 把 `/api/*` 反代到 3100）；DSH 本地端点见 `config.dsh.baseUrl`；WorkBuddy2API 7863（可选）；本地 TTS 8765（可选）；STT 8791（可选）；ollama 11434（可选） |
| Node | ≥ 22.13（内置 `node:sqlite`） |
| 配置热加载 | `config.json` 的端口/令牌/会话目录类字段改了**必须重启**；其余字段 fs.watch 约 1 秒生效 |
| DSH 侧 | `cordis.patch.yml`（MCP/preset）改了**必须重启 DSH**，MCP 只在启动时加载 |
| 状态文件 | `state/` 是运行数据（消息库、token、摘要、好感度），**不要外发、不要提交** |
| 启动记录 | `state/boot-log.jsonl`；桥接日志 `logs/` 与 `state/bridge.log` |

## 2. 十个踩过的坑（按踩坑概率排序）

1. **只改了代码没重启**：`src/` 的改动要重启桥接才生效；`dsh/agent-presets` 的改动要重跑 `setup-dsh.mjs` 并重启 DSH。
2. **`.ps1` 编码**：PowerShell 5.1 读无 BOM 的 UTF-8 会当 ANSI，中文注释可能吞掉下一行 → 保持 ASCII 或存 UTF-8 with BOM。
3. **执行策略**：新会话直接跑 `.ps1` 会被拦，用 `powershell -NoProfile -ExecutionPolicy Bypass -File`。
4. **`config.json` 的 `socialV2` 是浅合并**：写一个子项会把整段默认替换掉（工具开关/唤醒/记忆全丢）。要么不写，要么整段写全。
5. **`config.example.json` 不是生产模板**：它带失效的降级模型与一处乱码标题，用 `config.template.json`。
6. **`dsh.baseUrl` 有自动发现**：显式填错端口反而连不上；不确定就先留空/用模板默认，启动后看日志。
7. **后台常驻进程占住管道**：用 `Start-Process` 起常驻 node 时把 stdout/stderr 重定向到文件，别直接挂调用方管道。
8. **重复进程**：反复启动会留下多个桥接/审批进程，先 `ops\status-all.ps1` 看清再动。
9. **`status` 类脚本的假红**：某些服务是「计划任务启动后脱离」的常驻进程，任务状态回到 Ready 不代表没在跑 —— **以端口为准**。
10. **token 不要手填**：控制台 token 自动生成；SnowLuma 的 accessToken 两边一致即可；DSH 的 launch token 桥接会自动发现。
11. **计划任务里写死的路径会随仓库搬家失效**：`QQBridge-Bridge` / `QQBridge-SnowLuma` 的动作指向某个绝对路径，文件不在了任务照样「成功」触发、wscript 立刻退出 —— 表现为开机不自动起、重启按钮点了没人拉起来。先跑只读检查：

    ```powershell
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/fix-scheduled-tasks.ps1
    ```

    要真正改任务（需管理员）：`... scripts/fix-scheduled-tasks.ps1 -Apply`。仓库里的隐藏启动器已改成「按自身位置找仓库根」，搬家后重新登记一次即可；没管理员权限时，可在老路径下放一个只做转发的兼容 `.vbs`。

12. **请求体编码：Windows 的 curl / PowerShell 5 按 GBK 发中文**：桥接已做两层兜底——① 控制台 `readBody` 先严格按 UTF-8 解，失败退 GB18030（日志会打「请求体不是 UTF-8，已按 GB18030 重新解码」）；② 发送侧再拦一道，正文里出现 U+FFFD 替换符就 400 拒发，不会再把乱码发进 QQ。老数据里的乱码行在控制台显示成 `⍰` + 「编码损坏」标记。自查命令：

    ```bash
    node scripts/test-encoding-guard.mjs
    ```

## 3. 运维三件套

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-all.ps1     # 起网关检查 + 桥接（可选服务只报告）
powershell -NoProfile -ExecutionPolicy Bypass -File ops\start-all.ps1 -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File ops\status-all.ps1   # 只读健康检查（-Json 可机读）
powershell -NoProfile -ExecutionPolicy Bypass -File ops\stop-all.ps1     # 只停本包的桥接，不动 DSH/网关
```

顺序：**SnowLuma → 桥接**（网关必须先于桥接，否则桥接启动时连不上，虽会自动重连但日志会很吵）。

## 4. 验收一个刚起来的实例

0. 浏览器开 `http://127.0.0.1:3101`（面板常驻进程）—— 桥接重启时页面不会失联，只会顶部出现「机器人已下线」，每 3 秒自动重试
1. `ops\status-all.ps1` → 3000/3001/3100 全绿（DSH 端口也应为绿）
2. 控制台 `http://127.0.0.1:3100` → 能看到会话/活动流，模式为 reserved2
3. 群里 @ 一句 → 10–60 秒内回复；控制台活动流出现该轮记录
4. 发一张图 → 回复内容能描述图片（若模型不支持视觉，会明确说看不到，而不是瞎编）
5. 让它在群里潜水/等待 → `qq_wait_for_messages` 正常返回，不会卡死整个桥接

## 5. 极端情况重建清单（只有代码 + 文档）

按顺序，每步都有判据：

| # | 动作 | 判据 | 失败处置 |
|---|---|---|---|
| 1 | 装 Node 22.13+ | `node -v` | 低于 22.13 重装 |
| 2 | 装 DSH 并登录模型账号 | DSH 内能新建会话并对话 | 账号/网络问题；DSH 闭源，装不上换机器 |
| 3 | 装 SnowLuma 并扫码 + 开 OneBot | `/get_login_info` 返回 QQ 号 | 端口冲突改 3000/3001；风控换小号 |
| 4 | 解压本包 + `npm install` | exit 0，`node_modules/@snowluma` 存在 | 网络/代理；postinstall 失败会导致连不上网关 |
| 5 | `copy config.template.json config.json` 填 4 项 | `JSON.parse` 通过 | 常见是逗号/中文引号 |
| 6 | `node scripts/setup-dsh.mjs <profile>` | 输出 MCP×3 + preset×2 | profile 名错 → 看 `~/.dsh/profiles` 实际目录 |
| 7 | 重启 DSH | 新会话有 QQ preset + `mcp__snowluma__*` 工具 | 没重启 / 写错 profile |
| 8 | `node scripts/setup-doctor.mjs` | exit 0 | 按提示逐项修 |
| 9 | `ops\start-all.ps1` | status-all 全绿、3100 可开 | 看 `logs/bridge-stderr.log` |
| 10 | 群里 @ 一句 | 有回复 | 控制台活动流 → 入站有没有到；再看 MCP 是否加载 |

## 6. 角色卡（人设）怎么换

- 角色卡：`roles/<角色名>.md`（文件名即角色名），格式见 `roles/README.md`
- 选择：`state/current-role.json` → `{ "role": "<角色名>", "mode": "active" }`
- 首启提示：`state/initial-prompts.json`，格式 `{ "group:<群号>": { "text": "...", "createdAt": 0 } }`，上限 `socialV2.initialPromptMaxChars`（默认 2000 字符）
- 改完下一条消息生效，不用重启（除非改动的是 preset prefix，那要重跑 setup-dsh + 重启 DSH）

## 7. 备份与迁移

- 要保留的只有 `state/`（消息库、摘要、好感度、表情、黑话）与 `config.json`
- 迁移到新机器：装好 §2 的依赖 → 拷贝整个目录（含 `state/`）→ 重跑 `setup-dsh.mjs`（绝对路径会重算）→ 重启 DSH → 起服务
- **只备份 `state/` 里的消息库与配置即可**；`logs/` 不必留

## 8. 自动更新源（D2：本地目录）

外壳（`dist/desktop/QQDeepSeekBot.exe`）托盘里「检查更新」读的是 `config.json` 的 `desktop.updateUrl`
指向的一份 JSON 清单。清单格式（`desktop/UpdateVersion.cs` 的 `TryParse` 只认这几个字段）：

```json
{ "version": "0.1.1", "url": "http://127.0.0.1:7899/QQDeepSeekBot-Setup-0.1.1.exe",
  "sha256": "…64 位十六进制…", "notes": "可选" }
```

`url` 必须是 **http(s)**——壳里的 `FetchUpdate` 用 `HttpWebRequest`，不读 `file://`。
所以「本地目录更新源」= 目录 + 一个本地 HTTP 小服务：

```powershell
# 1) 准备目录（安装包 + latest.json）
node scripts\make-update-manifest.mjs --exe dist\installer\QQDeepSeekBot-Setup-0.1.1.exe `
     --version 0.1.1 --base http://127.0.0.1:7899 --out <本机路径>\latest.json --notes "0.1.1 更新说明"

# 2) 把目录用 HTTP 伺服出来（只读、只服务该目录、挡 ..）
node scripts\update-server.mjs --dir E:\qq-updates --port 7899

# 3) config.json 的 desktop.updateUrl 指过去，然后自检（不用开窗口）
#    exit 0 = 已是最新、1 = 有更新、2 = 读不到更新源（没配 / 服务没起 / 清单不合法）
dist\desktop\QQDeepSeekBot.exe --root "<仓库根>" --check-update
#    结果同时写进 logs\desktop-update.log：update-check: remote=… local=… cmp=… url=…
```

- `desktop.updateUrl` 留空 = 关闭更新检查（托盘点「检查更新」只提示未配置）。
- 真实发版：改 `scripts/installer/version.txt` → 重新打安装包 → 用上面第 1 步生成清单 → 替换目录里的 exe。
  壳下载完会校验 `sha256`，再静默运行安装包（`/S`）并重启自己。
- 想给局域网其它机器用：`--host 0.0.0.0`，清单里的 `url` 也要换成那台机器的地址。
- 清单校验口径是「大版本号比较」（`UpdateVersion.Compare`），`0.1.1 > 0.1.0`，`1.0.0 > 0.1.9`。
