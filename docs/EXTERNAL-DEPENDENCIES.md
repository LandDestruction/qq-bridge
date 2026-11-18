# 外部依赖：本包**不包含**什么，需要你自己装什么

> 这个压缩包只有 **QQ Bridge 桥接本体**（Node.js 代码 + 脚本 + 文档 + 前端页面 + STT 工具）。
> 它要跑起来，必须依赖下面这些**独立软件/服务**——它们都不在包里，需要单独安装与配置。本文说明每个是什么、怎么装、桥接里哪个配置项对接它。

---

## 一句话架构

```
QQ ←→ SnowLuma（QQ 协议网关）←→ QQ Bridge（本包）←→ DeepSeek Harness（agent 运行时）←→ 模型 API（WorkBuddy2API / 官方 DeepSeek / 小米 MiMo / ollama…）
                                              ↘ ffmpeg（抽帧/转码） ↘ Python + faster-whisper（语音转写）
```

---

## 1. SnowLuma —— QQ 协议网关（**不包含**）

| 项 | 说明 |
|---|---|
| 它是什么 | 独立的 QQ 机器人框架（OneBot 11 兼容），负责登录 QQ、收发消息、提供 HTTP/WebSocket 接口 |
| 为什么不在包里 | 它是第三方软件（有自己的安装包/账号体系），本包只通过标准 OneBot 接口连它 |
| 桥接怎么连 | `config.json` → `snowluma.wsUrl`（默认 `ws://127.0.0.1:3001`）、`snowluma.httpUrl`（默认 `http://127.0.0.1:3000`）、`snowluma.accessToken`（与 SnowLuma 的 OneBot token 一致） |
| 最低要求 | 一个可登录的 QQ 号 + SnowLuma 已启动且 OneBot WS/HTTP 服务监听在本机 |
| 不装会怎样 | 桥接启动后 `SnowLuma 已连接` 不会出现，所有 QQ 收发全不可用 |

> 同类替代：任何 OneBot 11 实现（NapCat / Lagrange / go-cqhttp 等）只要提供同样的 WS/HTTP + accessToken，桥接也能跑；但本项目只在 SnowLuma 上做过完整验证。

---

## 2. WorkBuddy2API —— 模型网关（**不包含**）

| 项 | 说明 |
|---|---|
| 它是什么 | 一个 OpenAI 兼容的模型聚合网关（`/v1/chat/completions`），把多个上游模型池化后统一暴露 |
| 为什么不在包里 | 它是独立服务，且通常带自己的账号/密钥/上游池 |
| 桥接怎么用 | `config.json` → `dsh.provider = "workbuddy2api"`、`dsh.baseUrl`（默认 `http://127.0.0.1:7863/v1`）；模型清单与降级链在 `dsh.model` / `dsh.modelFallbacks` |
| 不装会怎样 | 聊天主链路不可用；但可以改用**官方 DeepSeek**（见下）或其他 OpenAI 兼容端点替代 |

> **可以不用它**：把 `dsh.provider` / `dsh.baseUrl` / `dsh.model` 换成任意 OpenAI 兼容服务即可，例如：
> - 官方 DeepSeek：`https://api.deepseek.com/v1`，模型 `deepseek-chat`
> - 小米 MiMo：`https://api.xiaomimimo.com/v1`，模型 `mimo-v2.6-pro`
> - 本地 ollama：`http://127.0.0.1:11434/v1`，模型 `qwen2.5:7b-instruct-q4_K_M`

---

## 3. DeepSeek Harness (DSH) —— agent 运行时（**不包含**）

| 项 | 说明 |
|---|---|
| 它是什么 | 本项目依赖的 agent 框架：管理会话、preset、工具调用、模型选择、事件流 |
| 为什么不在包里 | 它是独立应用（安装包/版本更新独立），本包通过它的本地 HTTP/WS 接口驱动 |
| 桥接怎么连 | `config.json` → `dsh.baseUrl`（不填则自动发现本机 DSH 端口） |
| 版本要求 | 项目在 DSH 0.1.7 上验证；`docs/guides/DSH_020_ADAPTATION.md`、`DSH_021_ADAPTATION.md` 记录适配点 |
| 必装插件/配置 | MCP server 指向本包的 `src/mcp-host-server.js` / `mcp-snowluma-safe.js` / `mcp-web-search-safe.js`；`qq-chat-v2` preset 需要注册到 DSH profile（见 `docs/guides/DSH_SETUP.md`） |
| 不装会怎样 | 桥接能启动，但 `dshReady=false`，消息无法进入 agent，只有本地兜底（已基本停用） |

---

## 4. ffmpeg / ffprobe —— 媒体处理（**不包含**）

| 项 | 说明 |
|---|---|
| 用途 | 视频抽帧拼图、音轨抽取、缩略图缩放、HEIC 转 JPEG、TTS 音频格式转换 |
| 桥接怎么配 | `config.json` → `socialV2.voice.ffmpegPath`（绝对路径或 PATH 里的 `ffmpeg`） |
| 不装会怎样 | 视频只保留时长/文件名，做不出九宫格与转写；缩略图不缩放；HEIC 图片无法读 |

---

## 5. Python 3 + faster-whisper —— 语音转写（**不包含**）

| 项 | 说明 |
|---|---|
| 包内有什么 | `tools/stt_cli.py`（单次转写）与 `tools/stt_server.py`（常驻服务，推荐） |
| 包内**没有**什么 | Python 运行时、faster-whisper 与其模型权重（`Systran/faster-whisper-small` / `medium`） |
| 安装 | `pip install faster-whisper`；首次运行会自动下载模型到 `~/.cache/huggingface` |
| 桥接怎么配 | `socialV2.stt.{model,videoModel,lang,service:{enabled,port,model}}`；默认走常驻服务 `127.0.0.1:8791`，服务不可用时回退 CLI |
| 不装会怎样 | 视频只出画面帧，没有语音转写；`/api/status.sttService.running` 恒为 false |

---

## 6. 小米 MiMo（可选，高峰期模型）—— 外部 API，**不包含**

- 桥接的「高峰期便宜模型」默认指向 `https://api.xiaomimimo.com/v1`、模型 `mimo-v2.6-pro`；
- key 配在 `config.json` → `socialV2.peakPause.localModel.apiKey`（或环境变量 `XIAOMI_MIMO_API_KEY`）；
- 要在 **DSH 自己的模型选择器**里也出现，需要把 provider 写进 DSH 的 `cordis.patch.yml` 并重启 DSH（本包不带 DSH 配置）；
- 没有 key / 不想用：把 `socialV2.peakPause.enabled` 设为 `false`，全时段走主模型即可。

---

## 7. 可选组件

| 组件 | 用途 | 不装的影响 |
|---|---|---|
| ollama | 本地兜底模型（`qwen3:8b` 等） | 主模型全挂时没有本地兜底；`socialV2.localFallback.enabled=false` 即可忽略 |
| 本地 TTS 服务（如 `127.0.0.1:8765`） | `socialV2.tts.provider="local"` 时使用 | 用 QQ 官方语音（`provider="qq"`）或 edge-tts（`provider="edge"`）替代 |

---

## 8. 最小可运行清单（只聊天）

1. 安装 **Node.js ≥ 22.13**（需要内置 `node:sqlite`）
2. 装 **SnowLuma** 并登录一个 QQ，开启 OneBot WS/HTTP
3. 装 **DSH**，把本包的三个 MCP server 注册进去，注册 `qq-chat-v2` preset
4. 任意 **OpenAI 兼容模型端点**（官方 DeepSeek / MiMo / WorkBuddy2API / ollama）
5. 复制 `config.example.json` → `config.json`，填 `snowluma.accessToken`、`dsh.baseUrl`、模型与白名单
6. `node src/bridge.js`（或 `start.bat`）

要「视频能听、图能缩、HEIC 能看」再加 **ffmpeg**；要「视频能转写」再加 **Python + faster-whisper**。

---

## 9. 常见坑

- **端口对不上**：SnowLuma 的 WS 默认 `3001`、HTTP `3000`；桥接控制台 `3100`；ollama `11434`；STT 服务 `8791`。
- **token 不一致**：`snowluma.accessToken` 必须等于 SnowLuma 的 OneBot access token，否则 WS 被拒。
- **DSH 的 MCP 只在启动时加载**：改完 `cordis.patch.yml` 必须重启 DSH，`qq_*` 工具才会出现。
- **`state/` 不能外发**：里面是消息库、令牌、日志、表情缓存；本包已默认排除。
- **Windows PowerShell 5.1 读 UTF-8**：`scripts/*.ps1` 只用 ASCII 写；自己改脚本时别塞中文，否则会解析失败。
