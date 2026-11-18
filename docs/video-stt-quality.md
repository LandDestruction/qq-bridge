# 视频/语音识别质量（D53）：转写参数、低置信、抽帧

> 代码：`tools/stt_server.py`、`tools/stt_cli.py`、`src/stt-service.js`、`src/stt-quality.js`、`src/video-analyze.js`、`src/bridge.js`
> 测试：`scripts/test-stt-quality.mjs`（22/22，已进 CORE）。改的是 src/tools，**重启后生效**。

## 1. 真机现象（2026-10-27 15:08）

16 秒视频，转写只有 24 字且语义不通（`...一颗花地我这边打了插件`），耗时 9.2 秒；模型答「声音糊得很」。
画面链路基本可用，问题集中在声音。

## 2. 根因（代码位置）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `tools/stt_server.py` 原 116 行 | `model.transcribe(path, language=lang, vad_filter=True, beam_size=1)`：`lang` 来自请求且桥接传的是 `zh`，但服务端没有默认语言锁定；**`beam_size=1`** 解码质量差；**没有 `initial_prompt`**；**没有 `condition_on_previous_text=False`**（长音频容易复读） |
| 2 | 服务端 `_ensure_model_locked` 原 99 行 | 固定 `device="cpu", compute_type="int8"`、固定 `small`，没有 CUDA 与降级链 |
| 3 | `src/stt-service.js` 原 242 行 | 请求体只有 `{path, lang}`，不传 initial_prompt/beam/vad；不解析置信度 |
| 4 | `src/video-analyze.js` 原 96 行 | 固定 `dur/(count+1)` 均匀 9 帧（16s → 每 1.8s 一帧），快动作会漏 |
| 5 | `src/video-analyze.js` 原 121 行 | 只做 `-ac 1 -ar 16k`，没有去静音与响度归一化 |
| 6 | `src/bridge.js` 原 2109 行 | 画面与声音拼在同一句；转写无论多烂都当内容传下去 |

## 3. 改法

- **语言/参数**：服务端默认 `--language zh`、`--beam-size 5`、`--initial-prompt "以下是中文群聊语音，可能夹杂网络用语、游戏名和英文缩写。"`、`condition_on_previous_text=False`；请求体由 `buildSttRequest()` 统一构造。
- **模型与设备**：`--device auto` 先试 CUDA（`int8_float16`），失败按 `--fallback-model` 链降级；CPU 只跑链尾最小模型（避免 CPU medium 45s）。默认仍 `small`（见下方对比），要上 medium/large-v3 由 `socialV2.stt.model` 配。
- **低置信**：`assessTranscript()` 判定 `empty / too_short / high_no_speech / repetition / low_logprob`；命中时**不把文本交给模型**，会话语录只写「声音：听不清」（没有音轨写「声音：无」），给模型的「不要臆测声音内容」约束由 `videoMediaFactText()` 在 prompt 里补，**不写进消息正文**。
- **音频前处理**：`extractAudioWav` 加 `highpass=80 + silenceremove + loudnorm=I=-16`，滤镜失败自动退回裸抽（fail-open）。
- **抽帧**：`planFramePlan()` 改为「最长约 1 秒一帧、上限 12 帧」，16s → 12 帧 4×3；4s → 4 帧 2×2。
- **分开展示**：`[视频 N 秒｜画面：已抽 X 帧拼成 C×R]` 与 `声音：“转写”/声音：无` 分成两行，避免模型只答画面；会话语录只留事实，判断与指令只进日志与 prompt。

## 4. 同一段音频的前后对比（40 秒中文，CPU int8，beam=5 + zh + initial_prompt）

| 模型 | 耗时 | 字数 | 可读性 | avg_logprob |
|---|---|---|---|---|
| small | **5.3s** | 103 | 通顺，覆盖到 16s（源音频只说了 ~16s） | -0.154 |
| medium | 46.6s | 154 | 前段通顺，**尾部同一句复读 4 次**（幻觉） | -0.361 |

结论：**CPU 上 medium 不值得**（9 倍耗时 + 复读）。默认保持 `small`；有 GPU 余量时再配 `medium`/`large-v3`（int8 显存约：small <1GB、medium 2~3GB、large-v3 3~4GB）。
复读已由 `repetition` 判据拦下——即使以后切到 medium，也不会把复读当内容。

## 5. 抽帧对比（16 秒样本，按公式）

| | 帧数 | 间隔 | 覆盖 |
|---|---|---|---|
| 旧 | 9 | ~1.8s | 每 1.8 秒一次 |
| 新 | 12 | ~1.33s | 覆盖更密；4×3 网格，token 仍是一张图 |

## 6. 没做的 / 限制

- 15:08 那段视频**不在 state 媒体缓存里**（只有 10-25 的两段旧视频），对比用的是 `state/speech-video.mp4`；用户要复验需重发一段。
- 长视频（>60s）已有 `planVideoSegments()` 与测试，但 bridge 目前仍只转写前 `stt.maxSeconds`（默认 120s）一段，**分段接线未做**。
- QQ 官方语音转写回退：未调研（不留假承诺）。
- 所有异常 fail-open：转写失败/低置信只是「听不清」，不会让正常回复消失。
