# 配置热加载（不重启进程）

> 过去改 `config.json` 必须重启桥接，每次重启机器人会掉线十几秒。现在**大部分配置改完立即生效**。

## 怎么用

### 方式 A：自动（默认开启）
`config.json` 里：
```json
"socialV2": { "hotReload": { "enabled": true } }
```
保存文件后约 0.8 秒自动生效，日志会写：
```
[配置] 热加载（watch）：生效 2 项（allow, socialV2）
```
> 注意：用编辑器保存会触发；如果是脚本反复写文件，可能连续触发几次，属正常（会去抖 800ms）。

### 方式 B：手动
```powershell
curl -X POST http://127.0.0.1:3100/api/config/reload -H "x-console-token: <token>"
```
返回：
```json
{"ok":true,"changed":["allow"],"skipped":[],"unchanged":false,"count":3,"at":1792995761523}
```
查看状态：
```powershell
curl http://127.0.0.1:3100/api/config/reload -H "x-console-token: <token>"
→ {"ok":true,"enabled":true,"watching":true,"count":3,"lastAt":...,"lastSkipped":[]}
```

## 哪些能热更 / 哪些必须重启

| 能热更（立即生效） | 必须重启（会明确提示，并保持旧值） |
|---|---|
| `allow` / `deny`（群与私聊白名单） | `consolePort`（监听端口） |
| `ownerQQ` | `snowluma.wsUrl` / `httpUrl` / `accessToken`（连接） |
| `socialV2.*`（唤醒、发送、工具、媒体、峰值、STT、hotReload 开关…） | `dsh.baseUrl` / `authToken` / `authHeader` / `authPrefix` |
| `fileArchive.*`（白名单群、上限、simpleMode、目录） | `sessionCwd`（工作目录） |
| `observe.*` | `agentPreset`（进程级默认 preset） |
| `slang.*` / `pricing.*` / `webSearch.*` / `imagegen.*` / `security.*` | |
| `socialV2.peakPause.*`（含 MiMo key/model） | |

改了必须重启的字段时，返回里会有：
```json
"skipped":[{"path":"consolePort","from":3100,"to":9999}]
```
日志：
```
[配置] 需要重启才生效，已保持旧值：consolePort = 3100（磁盘为 9999）
```
**内存里保持旧值，不会出现"端口改成 9999 但进程还在 3100"的错乱。**

## 坏配置不会把服务搞挂
- 文件不是合法 JSON → 接口返回 **400**，日志 `[配置] 热加载失败（保持旧配置）`，进程继续用旧配置运行。
- 校验失败后你可以改回文件再 reload。

## 实测记录（2026-10-26）

| 测试 | 结果 |
|---|---|
| 白名单加一个群 → reload | `allowGroups` 立即多出该群，**PID 未变**（78872） |
| 再删掉 → reload | 立即恢复，**未重启** |
| 改 `consolePort: 9999` → reload | `skipped: consolePort`，3100 仍可访问，端口未被热改 |
| 把 config.json 写成坏 JSON → reload | HTTP 400，`/api/status` 仍正常（reserved2） |
| 单测 | `test-config-hot-reload` 5 项全过；`regression-all` 50/50 |

## 什么时候仍然需要重启

1. 改端口 / 换 SnowLuma 或 DSH 地址 / 换 token；
2. 更新代码（`src/*.js`）——Node 不支持热替换模块；
3. 装/卸载依赖。

除此之外，改配置都不用打断机器人了。
