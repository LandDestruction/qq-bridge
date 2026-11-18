# 视频语音转写「只识别出几个字」根因与修复（第五十一批）

## 根因

不是模型质量，是**等待策略与 medium 在 CPU 被抢时的延迟抖动**叠加：

| 实测 | 数据 |
|---|---|
| 纯音频 medium | 43s 语音 → 176~180 字，5 段覆盖 0–43s（质量好） |
| 纯音频 small | 同文件 176 字（beam 5），与 medium 基本一致 |
| **16s mp4 → medium** | **耗时 62s**（CPU 被抢时） |
| 7s wav | small 7.5s / medium 7.7s，均 31 字 |
| 线上日志 | `23:06:23 等待抽帧/转写 5284ms → 完成`（这次恰好 5.3s） |

旧实现：**单一 20s 上限**（`processPromptQueue` 里 `raceWithTimeout(pending, 20000)`）。
转写若需 60s，20s 一到就带着「无转写」继续组装 prompt → 模型只看到画面帧 → 回「只听到几个字」。

## 修复

1. **视频转写默认模型 `small`**：`socialV2.stt.videoModel`（默认 `small`）；`stt.model` 保留给高精度场景。
2. **两段式等待**：
   - 抽帧 ≤ **8s**（`raceWithTimeout(stages.frames, 8000)`）；
   - 转写 ≤ **`socialV2.stt.waitMs`（默认 90000）**；
   - 超时降级时，给模型的内容仍带「抽帧/语音转写还没完成，不要臆测声音内容」。
3. **迟到闭环**：转写超时后给该任务挂 `onLate`；转写真正完成时补发一条
   `刚才那条视频的语音转写出来了：…`（`LongText(text, 300)` 截断），并写回 `msg.text` 供下一轮使用。
4. **量化日志**（本次排查最缺的）：
   ```
   [video] <key> 时长=16s 音频=511290B 抽帧=812ms stt=处模型=small stt耗时=62048ms 字数=67 截断视频=否
   ```
5. **字数上限可配**：`socialV2.stt.maxChars`（默认 **600**），截断时日志标注「（已截断）」。

## 需要改的线上 config.json 键（我不改）

```json
"socialV2": { "stt": { "model": "medium", "videoModel": "small", "waitMs": 90000, "maxChars": 600, "lang": "zh" } }
```
不配也会走代码默认值（small / 90000 / 600）。

## 离线验证

```bash
node scripts/probe-video-audio.mjs "<本机路径>\qq-bridge-src\state\speech-video.mp4"
```
实测（16s 中文语音）：
```
stt: {"ok":true,"lang":"zh","text":"大家好,这是一段比较长的测试语音,用来检查视频里的声音能不能被完整识别出来。
     第一句,我们今天要测试的是语音转文字功能。第二句,如果…", "segments":[…4 段…]} (6002ms)
VERDICT: 有声音且有转写
```

## 后续（已在施工 D 完成）

常驻 STT 服务（一次加载模型 + 本地 HTTP）+ 迟到转写**主动补发**已落地，
详见 [handoff-stt-service.md](handoff-stt-service.md)：

- `tools/stt_server.py`（`127.0.0.1:8791`，空闲 30 分钟卸载模型）；
- 本轮 prompt 只等 `socialV2.stt.inlineWaitMs`（默认 6s），赶不上就写「转写中」，
  转写完成后主动补发一条 QQ 消息（每视频只发一次、重启不重发）；
- 实测 16s 视频端到端：冷 ~5.0s / 热 ~1.8s（旧 CLI 每次 ~4.8s）。

注意：`socialV2.stt.waitMs`（本文第 2 条的 90s 等待）已被 `inlineWaitMs` 取代，不再是本轮等待上限。
