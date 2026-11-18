# 第三方组件清单（不随包，需自行安装）

> 原则：**我们只发自己的代码与人设；别人的软件与账号，指路不代装。**
> 许可状态查不到的写「待确认」，不猜。

## 1. DeepSeek Harness（DSH）——模型运行时

| 项 | 值 |
|---|---|
| 来源 | 官方下载 `https://download.deepseek.com/dsh-desk/`（更新源 `download.deepseek.com`） |
| 本机版本 | 0.2.1-rc.2（Electron 桌面版，安装后约 1.0 GB） |
| 要求 | Windows 10/11 x64；登录 DeepSeek 账号，或自行添加 OpenAI 兼容 provider |
| 与桥接的关系 | `config.dsh.baseUrl`；桥接通过本地 HTTP/WS 驱动 DSH |
| 许可 | **待确认**：安装目录只有 Electron/Chromium 第三方许可，未见产品 EULA/许可文本 → 不随包分发；如需随包请先向 DeepSeek 确认 |
| 不装的后果 | 桥接能启动但 `dshReady=false`，消息进不了模型 |

## 2. SnowLuma —— QQ 协议网关（OneBot 11）

| 项 | 值 |
|---|---|
| 来源 | GitHub `SnowLuma/SnowLuma` releases（本机用源码构建 v2.1.1） |
| 要求 | 一个可扫码登录的 QQ 号；开 OneBot WebSocket 3001 / HTTP 3000，设 accessToken |
| 与桥接的关系 | `config.snowluma.wsUrl/httpUrl/accessToken` |
| 许可 | **可有限再分发**：`SnowLuma Source-Available Non-Commercial License v1.0`。§3 允许非商业再分发（须附许可全文、保留版权声明；修改版公开发布需书面许可）；§4 禁止商业使用、禁止基于它另立项目 |
| 替代 | 任意 OneBot 11 实现（NapCat / Lagrange / go-cqhttp…），本项目只在 SnowLuma 上完整验证过 |
| 不装的后果 | 收不到任何 QQ 消息 |

## 3. WorkBuddy2API（可选）——OpenAI 兼容中转

| 项 | 值 |
|---|---|
| 来源 | GitHub `yreidev/workbuddy2api-panel`（Go 单文件，本机 v1.4.0，默认 127.0.0.1:7863） |
| 要求 | 自己的 WorkBuddy 账号；账号使用受上游条款约束 |
| 与桥接的关系 | `dsh.provider=workbuddy2api`，provider 需在 DSH 的 `cordis.patch.yml` 里注册 |
| 许可 | AGPL-3.0（再分发需附许可与源码获取方式；网络服务需向使用者提供源码） |
| 建议 | 不随包；用官方 DeepSeek 账号可完全绕开 |

## 4. 其他运行时/工具

| 组件 | 来源 | 用途 | 许可 | 是否必需 |
|---|---|---|---|---|
| Node.js ≥ 22.13 | nodejs.org | 运行桥接（`node:sqlite`） | MIT 系 | 必需 |
| ffmpeg / ffprobe | ffmpeg.org（本机 winget 9.0.2 full build） | 视频抽帧、HEIC 转换、音频转码 | **待确认**：gyan full build 为 GPL，随包需履行 GPL 义务 | 可选 |
| Python 3 + faster-whisper | pypi | 语音转写（默认 127.0.0.1:8791） | MIT；Whisper 权重 MIT 系 | 可选 |
| ollama + qwen3:8b | ollama.com | 本地兜底模型（11434） | ollama MIT；qwen3 Apache-2.0 | 可选 |
| 本地 TTS（RVC） | 自建 | 音色合成（8765） | 音色涉及真人声音权利 | 可选、**不随包** |

## 5. 账号与数据边界

- QQ 号、群号、模型 key、控制台 token、DSH 登录态 —— **全部由使用者自己产生**，包里没有
- 群聊记录、群友上传的图片/语音、表情收藏、好感度与印象 —— 属群友数据，**不外发**
- 若你要把本系统再转给别人：先删 `state/`、`logs/`、`config.json`，再按 `scripts/build-delivery.mjs` 重新出包
