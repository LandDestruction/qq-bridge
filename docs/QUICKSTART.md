# 在干净机器上从零跑起来（Quickstart）

> 结论先说：**不能"解压即跑"**，但可以做到 **解压 → 装 3 个外部件 → 填 4 个值 → 一条命令自检 → 启动**。
> 本包已在 `scripts/` 里提供 `bootstrap.ps1`（一键检查+装依赖）和 `setup-doctor.mjs`（逐项体检）。

---

## 0. 你需要的机器

- Windows 10/11（本项目主要在 Windows 上验证；Linux/macOS 需要自己改启动脚本与路径）
- Node.js **>= 22.13**（必须，用到内置 `node:sqlite`）
- 一个可登录的 QQ 号
- 能访问模型 API 的网络

---

## 1. 三个必须自己装的外部件

| 外部件 | 作用 | 怎么来 |
|---|---|---|
| **SnowLuma** | QQ 协议网关（OneBot WS/HTTP） | 自己安装并登录 QQ，开启 OneBot WebSocket（默认 `3001`）与 HTTP（默认 `3000`），记下 access token |
| **DeepSeek Harness (DSH)** | agent 运行时（会话/preset/工具） | 安装 DSH；把本包的三个 MCP server 注册进去（见 `docs/guides/DSH_SETUP.md`）；注册 `qq-chat-v2` preset（`scripts/setup-dsh.mjs` 可辅助） |
| **模型端点** | 实际生成回复 | 任选：官方 DeepSeek `https://api.deepseek.com/v1`、小米 MiMo `https://api.xiaomimimo.com/v1`、WorkBuddy2API、或本地 ollama |

可选：**ffmpeg**（视频/缩略图/HEIC）、**Python + faster-whisper**（视频语音转写）。

详见 [`EXTERNAL-DEPENDENCIES.md`](EXTERNAL-DEPENDENCIES.md)。

---

## 2. 两条命令

```powershell
# 解压后进入目录
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
```
它会：检查 Node → 缺依赖就 `npm ci` → 没有 `config.json` 就从 `config.example.json` 复制 → 跑环境自检 → 打印下一步。

自检也可以单独跑（会逐项给 ✅/⚠️/❌ 和修复命令）：
```powershell
node scripts\setup-doctor.mjs
```

---

## 3. 要填的 4 个值（`config.json`）

```jsonc
{
  "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "填 SnowLuma 的 OneBot token" },
  "dsh": { "baseUrl": "http://127.0.0.1:<DSH端口>", "provider": "deepseek-official", "model": "deepseek-flash" },
  "allow": { "groups": ["你的群号"] },
  "ownerQQ": 你的QQ号
}
```
> DSH 端口每个机器不同，启动 DSH 后看它的界面/日志；也可以留空让桥接自动发现本机端口。
> 高峰期便宜模型在 `socialV2.peakPause.agent`（默认 `xiaomi-mimo/mimo-v2.6-pro`），不想用就把 `peakPause.enabled` 设为 `false`。

---

## 4. 启动与验收

```powershell
node src\bridge.js
# 或 start.bat
```
预期日志顺序：
```
SnowLuma 已连接：ws://127.0.0.1:3001
DSH 已就绪（模式: reserved2）
本地控制台已启动：http://127.0.0.1:3100
```
然后：
1. 打开 `http://127.0.0.1:3100/?token=<state/console-token 里的值>`
2. 在 `allow.groups` 的群里 @ 机器人一句，看它是否回复
3. 要全量自检跑：`node scripts\regression-all.mjs`（49 套，纯本地，不需要活 DSH 的会跳过）

---

## 5. 干净机器上的现实预期

| 步骤 | 时间 |
|---|---|
| 装 Node + 解压 | 5 分钟 |
| 装 SnowLuma / 登录 QQ | 10~20 分钟（大头是扫码登录与 OneBot 配置） |
| 装 DSH + 注册 MCP/preset | 10~30 分钟（取决于是否已有 DSH） |
| 填 config + 自检 + 启动 | 5 分钟 |
| **合计** | **约 30~60 分钟**，不是 3 分钟 |

**做不到"解压即跑"的原因**：SnowLuma 必须登录真实 QQ、DSH 是独立应用、模型要 key——这三样都不是一个 zip 能替代的，也不该被塞进源码包。

---

## 6. 常见坑（干净机器最容易踩）

1. **Node 太旧**：`node:sqlite` 不存在 → 升级到 22.13+。
2. **SnowLuma token 不一致**：桥接日志报 401 / WS 被拒 → `config.snowluma.accessToken` 必须与网关一致。
3. **DSH 的 MCP 只在启动时加载**：改完 `cordis.patch.yml` 必须重启 DSH，`qq_*` 工具才出现。
4. **端口占用**：3100 已有旧桥接 → 先停旧实例。
5. **PowerShell 5.1 读 UTF-8**：`scripts/*.ps1` 全 ASCII；自己改脚本别塞中文。
6. **控制台 404/401**：token 不对或 Host 不是回环地址；只接受本机访问。
