# 机器人自检（九组）

> 目的：**手动**把 AI 的全部子系统跑一遍，一眼看出「哪一环断了、断在哪、下一步做什么」。
> 每条结论都必须带实据数字（端口真连了没、db 的 `integrity_check` 回了什么、pid 活没活）——
> 只写「正常」的自检，等于给系统加第二个假绿来源。

## 三种入口

```powershell
# 1) 命令行：人话表格（要看细节就用它）
node scripts/self-check.mjs

# 2) 机器可读（看板 / CI / 贴给别人）
node scripts/self-check.mjs --json

# 3) 只做安全修复：拉起 Ollama、清掉指向死进程的 lock；其余只报告
node scripts/self-check.mjs --fix

# 对另一份安装体检（工作树没有 config.json/state 时用这个）
node scripts/self-check.mjs --root <安装目录>
```

控制台：打开 `http://127.0.0.1:3100/ops`，点**「运行自检」**。
接口：`POST /api/self-check`（跑一次并落 `state/self-check-last.json`）、`GET /api/self-check/last`（取最近一次）。
两个接口都走控制台令牌；带 `x-agent-*` 的会话级请求一律 **403**（结果里有群号与路径，不给模型看）。

退出码：**0 = 没有 fail（可有 warn）**；**1 = 有 fail**；2 = 用法/环境错误。

## 九组查什么

| 组 | 查什么 | fail 意味着 |
|---|---|---|
| `ports` | 3000 / 3001 / 3100 / 8765 / 8791 / 11434 / DSH 端口 TCP 直连（**不用 Get-NetTCPConnection**，本机漏报过） | 必需端口（3001/3100/DSH）不通 |
| `snowluma` | `get_login_info` 是否在线 + 桥接侧 WS `connected` | 网关掉线 / token 不一致 |
| `dsh` | 桥接视角的 `dshReady` + `/api/models` 里是否真有 `config.dsh.model` 与每个 `modelFallbacks` | DSH 没就绪，或配置引用了不存在的模型（scnet 那次） |
| `bridge` | `/api/status` 200、预算计数（`checks/sweeps/errors`）、白名单群 → DSH 会话映射覆盖 | 桥接没在跑 |
| `storage` | `messages.db` 的 `PRAGMA integrity_check`、`stickers.json`/`social-v2.json` 可解析、归档目录可写 | 数据损坏 / 目录不可写 |
| `config` | 兜底模型是否存在、`stt.model` 是否合理、`contextBudget.enabled`、`memory.people.enabled` | 有失效兜底模型 |
| `tasks` | `QQBridge-Bridge` / `QQBridge-SnowLuma` / `LocalTTS` / `Ollama` 的计划任务 State（可选服务再交叉验端口） | 核心任务没在跑 |
| `disk_logs` | 磁盘剩余 + **近 10 分钟**日志里 error/warn 计数（按本地时间算，跨零点也算） | 磁盘 < 2 GB 或错误扎堆 |
| `version` | `state/boot-log.jsonl` 最后 `start` 的 pid 是否还活着 + boot 时间 vs `git HEAD` 提交时间 | 进程已退出，或**在跑旧代码**（改完 src 没重启） |

## 设计约束

- **只读**：全部探测都是读；`--fix` 只允许两件事——`schtasks /run /tn \Ollama`、删掉 pid 已不存在的 `state/bridge.lock`。
- **不重启线上服务、不改 `config.json`**。
- 探测函数全部可注入：`scripts/test-self-check.mjs` 注入假依赖跑五类场景（全绿 / 端口断 / db 坏 / 模型缺失 / 任务停），
  不真连网络、不真读 `state`。
- 报告落盘 `state/self-check-last.json`（控制台刷新页面能直接看到上次结果）。

## 看结果怎么用

1. 先看 `fail` 组，按每条的 `→` 一句话建议处置；
2. `warn` 组通常「按需」——例如 Ollama 没起只影响本地兜底；
3. 同一轮里 `version` 报「在跑旧代码」时，先重启桥接再复跑一次，否则你在看的是旧行为。

相关：出包前的冷启动自检用 `node scripts/boot-smoke.mjs`（沙箱起一遍装配，不连 QQ）；
运行中的人体工效面板是 `http://127.0.0.1:3100/ops`。
