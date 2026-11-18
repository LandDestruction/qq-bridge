# 交接｜施工 D：视频语音「太慢 + 要再问一次」→ 常驻转写服务 + 迟到主动补发

```
分支: feat/audio（基于 main 4502fc9）
改动文件:
  tools/stt_server.py（新增，常驻 faster-whisper HTTP 服务）
  src/stt-service.js（新增，懒启动 / 健康检查 / CLI 回退 / 状态快照）
  src/video-followup.js（新增，转写中话术 + 迟到补发协调器 + 去重）
  src/bridge.js（接线：视频转写走服务、本轮只等 6s、主动补发、诚实 prompt、/api/status）
  config.example.json（新增 socialV2.stt 配置块）
  .gitignore（忽略 Python __pycache__）
  scripts/test-stt-service.mjs（新增）
  scripts/test-video-followup.mjs（新增）
  scripts/test-stt-wiring.mjs（新增）
  scripts/test-video-stt-flow.mjs（新增，走真实桥接代码的 VM harness）
  scripts/probe-stt-service.mjs（新增，实测冷/热耗时）
  scripts/regression-all.mjs（把 4 个新套件加入默认回归）
  scripts/audit-bridge-harness.mjs（注入 async-wait / video-analyze / STT 桩，让新接线可在 VM 里跑）
  scripts/test-tts-ext.mjs（旧断言从 stt.waitMs 改为 inlineWaitMs + videoMediaFactText）
```

## 为什么（用户原话）

> 「是能识别到视频里的声音了，但是**速度太慢**，而且**要我再问一次**才会把终于转写好的信息告诉我。」

两个独立问题：

1. **慢**：`stt_cli.py` 每次调用都 `WhisperModel()` 冷加载模型。16s 中文视频实测
   CLI 全程 ~4.8s，其中一大半是加载；而转写本身只要 ~1.5s。
2. **要再问一次**：旧代码的「迟到补发」只在转写等待超时后注册 `onLate`，而回调里调用了一个
   **不存在的 `LongText()`** —— 真触发时在 `void sendToQQ(...)` 的参数求值阶段就
   `ReferenceError`，消息永远发不出去（只在 unhandledRejection 留痕）。于是用户先看到
   「没完成/听不到」，再问一次才从上下文里看到转写。

## 现在怎么做

### 1) 常驻转写服务（摊掉冷启动）

- `tools/stt_server.py`：启动即监听 `127.0.0.1:8791`，后台线程预热 `WhisperModel`
  （`device=cpu, compute_type=int8`，默认 `small`）。
  - `GET /health` → `{ok, model, loaded, loading, loadedAtMs, lastMs, pid, uptimeMs, idleUnloadMs}`
  - `POST /transcribe {"path": "...", "lang": "zh"}` → `{ok,text,segments,lang,ms,model}`
  - 转写串行（模型非线程安全 + CPU 被抢时并发只会更慢）；`/health` 在转写期间仍秒回。
  - 空闲 `idleUnloadMs`（默认 30 分钟）自动卸载模型（`gc.collect()`），下次请求再加载。
  - `--allow-dir` 白名单：只允许解码桥接临时目录 / 系统临时目录里的音频，拒绝任意路径读取。
- 桥接侧 `src/stt-service.js`：
  - 首次需要转写时才 `spawn python tools/stt_server.py`，`PYTHONIOENCODING=utf-8`，日志写
    `state/stt-service.log`；
  - 有服务就优先走服务；**服务没起来 / 500 / 超时 / 端口被占 → 自动回退现有
    `transcribeWav` CLI 路径**，功能绝不因此丢失；
  - 启动失败后退避 60s，避免每条视频都白 spawn 一次 python；
  - 桥接退出时 `stop()` 子进程。

### 2) 迟到转写「主动补发」

- 视频到达即建 job（`src/video-followup.js`），转写完成调用 `transcriptReady()`。
- **本轮 prompt 最多等 6s**（`socialV2.stt.inlineWaitMs`）；赶上了就 `claim()`，不再补发。
- 没赶上 → prompt 如实写「转写中，稍后补给你」，转写完成后延迟 `settleMs`（默认 1.2s，
  给 prompt 组装留窗口）主动发：

  > 刚才那条视频的语音我听出来了：<转写摘要>

- 去重：每个 `${key}:${media.file||media.url}` 只补发一次；集合持久化在
  `state/social-v2.json` 的 `videoFollowUps.sent`（最多 500 条），**重启后从状态文件恢复**，
  不会重启一次重发一遍。
- 同会话连续补发至少间隔 `minGapMs`（默认 3000ms）；两条视频同时转完会错开发送，内容不串。
- 发送走现有 `auditAndSend` → `sendToQQ`（与其它桥接主动消息同一发送链/审计/白名单）。

### 3) 本轮话术诚实

| 情况 | 模型看到的事实 |
|---|---|
| 转写已完成 | `[视频：<摘要，含“声音里说了：…”>]` |
| 转写还在跑 | `[视频：语音转写中，还没转写完，稍后会把转写补给你。不要说你听不到/没有声音，也不要编造声音内容；可以先按画面回应]` |
| 没有音轨 | `[视频：这条视频没有可用的人声（音频提取失败或视频没有音轨）。不要臆测声音内容]` |
| 转写失败 | `[视频：语音转写失败（<原因>）。不要臆测声音内容]` |

引用里的视频：转写没在 25s 内完成时，prompt 写「正在抽帧/转写，转写完成后会主动补给你」，
转写完成后同样补发（这条路径不参与本轮 6s 等待，避免引用视频把回复拖住）。

### 4) 可观测

每条视频按顺序打这几行（实测样例）：

```
[video] group:456 收到视频「v.mp4」（group:456:https://...）
[video] group:456 抽帧完成 耗时=202ms 帧=9张 3×3
[video] group:456 转写(服务) 耗时=1553ms 字数=65
[video] group:456 补发=否 原因=本轮 prompt 已带上        ← 赶上了
# 迟到时：
[video] group:456 等待转写 6001ms 未完成（本轮上限 6000ms）：prompt 写「转写中」，完成后主动补发
[video] group:456 补发=是 原因=已发送 字数=19
```

`GET /api/status`（管理端完整对象）新增：

```json
"sttService": {
  "enabled": true, "running": true, "model": "small",
  "loadedAt": 1792943605344, "lastMs": 1553, "loaded": true,
  "port": 8791, "source": "service", "lastError": null,
  "lastCheckedAt": 1792943607112
}
```

智能体（带 `x-agent-token`/`x-agent-call`）仍然只看得到原来的最小状态对象，不含该字段。

## 实测（本机，`node scripts/probe-stt-service.mjs`）

素材：`state/speech-video.mp4`，16s 中文语音。

| 项目 | 耗时 |
|---|---|
| 抽帧（ffprobe + 9 帧 3×3） | 202ms |
| 抽音轨（16k mono wav，499KB） | 78ms |
| **端到端冷**（spawn + 加载模型 + 抽帧 + 抽音轨 + 转写） | **4984ms** |
| **端到端热**（同一服务进程，第二段视频） | **1833ms** |
| 服务冷启动（spawn + 加载 + 转写） | 4704ms |
| 服务热转写 | 1553ms |
| 旧 CLI（每次重新加载模型） | 4840ms |
| 转写字数 | 65 字 |

结论：**第二段视频起端到端从 ~4.8s 降到 ~1.8s**（转写部分快约 3 倍）；
第一段仍要付一次模型加载，慢机器上可能超过本轮 6s → 由主动补发兜底。

### 补发文案样例（真实测试输出）

```
刚才那条视频的语音我听出来了：这是一段真实转写
刚才那条视频的语音我听出来了：大家好,这是一段比较长的测试语音,用来检查视频里的声音能不能被完整识别出来。第一句,我们今天要测试的是语音转文字功能。…
```

文案规则：`maxChars`（默认 200）按字符截断并补 `…`；**只使用真实转写**，
空转写/无音轨/失败一律不发。

## 配置键（写进线上 `config.json`，不配也会走代码默认值）

```json
"socialV2": {
  "stt": {
    "videoModel": "small",
    "lang": "zh",
    "maxChars": 600,
    "inlineWaitMs": 6000,
    "python": "python",
    "service": {
      "enabled": true,
      "port": 8791,
      "model": "small",
      "idleUnloadMs": 1800000
    },
    "followUp": {
      "enabled": true,
      "maxChars": 200,
      "minGapMs": 3000
    }
  }
}
```

- `service.enabled=false` → 完全回到旧 CLI 路径（每次加载模型）。
- `inlineWaitMs: 0` → 本轮完全不等转写，全部靠补发。
- `stt.waitMs`（上一批的 90s 等待）**已不再使用**；`stt.model` 只作为 `videoModel` 缺省时的回退。
- `stt.python` 用于同时指定服务与 CLI 的 python 可执行文件。

## 验证

```
node scripts/test-stt-service.mjs     # 服务优先 / 服务挂→CLI / enabled=false / 懒启动只 spawn 一次
node scripts/test-video-followup.mjs  # 慢转写补发一次、快转写不补发、重启去重、两条不串、minGap、maxChars
node scripts/test-stt-wiring.mjs      # 桥接接线静态断言 + JS/Python 语法
node scripts/test-video-stt-flow.mjs  # 真实桥接代码 + 假服务：慢/快/无音轨三种端到端
node scripts/regression-all.mjs       # 37/37 套件通过
node scripts/probe-stt-service.mjs    # 真模型实测（上方表格）
```

## 已知风险 / 回滚

**风险**

1. 冷启动仍要 ~5s；慢机器/CPU 被抢时超过 `inlineWaitMs`，第一条回复是「转写中」，随后补发。
   这是有意取舍（不让回复被 60s 转写拖死）。
2. 8791 端口被别的程序占用 → 服务起不来，自动回退 CLI（有 60s 退避），功能不受影响；
   要恢复加速就换 `service.port` 或清掉占用。
3. 桥接被 `taskkill /F` 强杀时子进程可能残留（空闲 30 分钟会卸载模型，进程本身很轻）。
   下次启动会复用健康服务；如果换了代码想强制用新版，见下面回滚命令。
4. 补发在 `auditAndSend` 返回后记为「已补发」；`sendToQQ` 本身会吞传输错误并记日志，
   因此**网络层失败不会自动重试**（避免重复刷群）。需要重发时清掉
   `state/social-v2.json` 的 `videoFollowUps.sent` 对应条目（先停桥接）。
5. `videoFollowUps.sent` 有 500 条上限，超出淘汰最旧；正常用量不会撞到。

**立即回滚（不改代码）**

改 `config.json`，然后重启桥接（`config.json` 常驻内存，必须重启才生效）：

```json
"socialV2": { "stt": { "service": { "enabled": false }, "followUp": { "enabled": false } } }
```

- 视频转写立刻回到旧 CLI 路径；不再补发。prompt 的诚实措辞仍保留（它不依赖新服务）。
- 若端口/模型配错导致异常，也可以只关 `service.enabled`，CLI 兜底仍在。

**代码回滚**

```bash
git checkout main -- tools/stt_server.py src/stt-service.js src/video-followup.js \
    src/bridge.js config.example.json scripts/regression-all.mjs scripts/audit-bridge-harness.mjs \
    scripts/test-tts-ext.mjs
git revert <本批 4 个提交>   # 或者直接切回 main 的部署目录
```

**清残留 python 服务**

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*stt_server.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

## 需要审阅做的动作

1. `git merge --no-ff feat/audio`（5 个提交：服务 / 补发模块 / 桥接接线 / 回归+文档 / 唤醒快照修正）。
2. 重启桥接（`restart.bat` 或控制台），让新代码与新状态键生效。
3. 建议在 `config.json` 显式写入上面的 `socialV2.stt` 块（不写也走默认值）；
   `service.port` 若与现有服务冲突请改。
4. 验证：发一条 16s 左右带人声的视频，`state/bridge.log` 里应看到
   `转写(服务)`；紧接着第二条视频应明显更快（热转写 ~1.5s）。
5. 若故意把 `inlineWaitMs` 调到 200ms 再发视频，应收到「语音转写中」的回复，
   并在转写完成后收到一条「刚才那条视频的语音我听出来了：…」，**不用再问一次**。
