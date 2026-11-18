# 视频链路与本地兜底现状（2026-10-25 自检）

## 一、视频链路（只读核查，未改代码）

### 入口
- 消息段识别：`src/bridge.js:1610` / `:1635` 把视频段标成 `kind: 'video-file'`；`:12761` 统一归类；
- 触发分析：`src/bridge.js:12831` `for (const mv of safeMedia) if (mv?.kind === 'video-file') void enrichVideoFile(key, mv, msg);`
  —— fire-and-forget，不阻塞主消息流；
- 进函数即校验：`src/bridge.js:1943` `if (!media || media.kind !== 'video-file') return;`。

### 限额（`src/video-analyze.js`）
- `VIDEO_MAX_BYTES = 50 * 1024 * 1024`（50MB）、`VIDEO_MAX_SECONDS = 120`、`FRAME_COUNT = 9`、`cols = 3`。
- **>50MB**：不直接跳过，而是 `readBodyBounded(r.body, sizeCap)` 按字节截断，并打
  `[video] … 视频超过 X MB，已按字节截断到 Y MB（未整段读入内存）`；截断后的 mp4 可能无法解析，
  后续 ffmpeg 失败会走各自的日志分支。
- **>120s**：`secCap` 作为时长上限传给抽帧（`durationSec: min(dur, secCap)`）与音轨（`maxSeconds: secCap`），
  即**只分析前 120 秒**；日志只打总时长，**没有**单独一行说明「已截断到 120s」——已知的可见性缺口。

### 抽帧拼图
- 固定 3×3（9 帧、cols=3）。16:9 结果约 960×540，合理；
- **竖屏（9:16）会被拼成宽扁的 3×3 网格**，单帧被横向拉扁/留黑边——已知限制，未改代码（本批要求"不改除非真 bug"）。

### 语音转写
- 走 `extractAudioWav` + `transcribeWav`（`tools/stt_cli.py`，faster_whisper 1.2.1 可用）。
- 失败时 `said` 为空，给模型的说明里**不出现**「声音里说了…」，日志打 `无语音`。
- **缺口**：`无语音` 同时覆盖「视频本来没声音」与「STT 失败/超时」，二者不可区分；建议后续拆成两条文案。

### 线上实测（环境侧，非本次）
- `22:25:40 [video] group:100000001 视频分析完成：16s 有语音` —— 真群视频的抽帧 + 转写链路是通的。

## 二、本地兜底（ollama 已启动后）

- `GET http://127.0.0.1:11434/api/tags` → **200**，模型含 `qwen3:8b`（另有 qwen2.5:7b-instruct-q4_K_M、qwen2.5:0.5b）。
- 桥接 `GET /api/model` → `local: {enabled:true, active:false, model:"qwen3:8b", baseUrl:"http://127.0.0.1:11434",
  ok:0, fail:0, description:"本地兜底通道：待命"}` —— **已识别为待命**，不再报「本地模型没起」。
- 历史日志里 22:21–22:22 的三条「本地模型没起」发生在 ollama 启动之前，属预期。
- **超时评估**：`localFallback.timeoutMs = 10000`；qwen3:8b 冷加载常见 5–20s（首轮含权重载入），
  10s 有概率在「首轮冷启动」时超时。建议线上调到 **20000~30000**（配置项 `socialV2.localFallback.timeoutMs`），
  本窗口未改线上配置。

## 三、malformed tool-call JSON 的专用降级

- 纯文字/工具轮：优先切 `deepseek-account/deepseek-v4-pro` 重试（若可用）；
- **含图轮绝不切 pro**（pro 的 `seesImages=false`），保持 `deepseek-account/deepseek-flash`；
- 日志：`[malformed] → 切 <provider>/<model> 重试（含图轮保持视觉模型 | 纯文字/工具轮优先 pro）`；
- 静态断言：`scripts/test-malformed-retry.mjs` 断言 `hasMedia` 分支存在且优先候选是 pro。
