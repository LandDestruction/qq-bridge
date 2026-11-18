# config.json 字段说明（必填 / 选填 / 留空默认）

> 模板：`config.template.json`（占位符，复制成 `config.json` 后逐项替换）。
> **`socialV2` 是浅合并**：写一个子项会替换整段默认；不需要改就别写，要改就从 `config.example.json` 整段复制。
> 改完：端口/token/会话目录类字段必须重启；其余热加载（约 1 秒）。

## 1. 必填（不填跑不起来）

| 字段 | 类型 | 说明 | 占位符 |
|---|---|---|---|
| `ownerQQ` | 数字 | 管理员 QQ（可私聊下管理指令） | 模板 `<QQ号>` 换成你的数字号 |
| `allow.private` / `allow.groups` | 数字数组 | 白名单；至少一项非空（否则谁都不理） | `<QQ号>` / `<群号>` 换成真实数字 |
| `snowluma.accessToken` | 字符串 | 与 SnowLuma 里 OneBot 的 access token 完全一致 | `<SNOWLUMA_ONEBOT_ACCESS_TOKEN>` |
| `dsh.baseUrl` | 字符串 | DSH 本地端点；不确定就留空/留模板值，桥接会自动发现 | `http://127.0.0.1:13707` |

## 2. 建议填（影响体验）

| 字段 | 默认 | 说明 |
|---|---|---|
| `dsh.provider` / `dsh.model` | `deepseek-official` / `deepseek-flash` | 必须是 DSH 里**真实存在**的模型；写错会走降级链 |
| `dsh.reasoningEffort` | `max`（模板 `high`） | 思考强度：越高越慢越贵；上游默认 max |
| `dsh.visionModels` | `["deepseek-flash"]` | 能看图的模型清单；留空/写错会导致图片轮选到不支持视觉的模型 |
| `agentPreset` | `qq-chat`（模板 `qq-chat-v2`） | 用哪条 preset；二代仿真必须 `qq-chat-v2` |
| `workspaceTitle` | `QQ 聊天` | DSH 里工作区/会话分组名 |

## 3. 选填（有默认，通常不用动）

| 字段 | 默认 | 说明 |
|---|---|---|
| `consolePort` | 3100 | 控制台端口 |
| `consoleToken` | 空 | 留空 → 自动生成到 `state/console-token`；MCP server 也从这里读 |
| `dsh.authToken` | 空 | 留空 → 自动从 DSH 本机 guard 日志发现 launch token |
| `dsh.authHeader` / `dsh.authPrefix` | `authorization` / `Bearer` | 鉴权头格式，一般不改 |
| `dsh.allowRemote` | `false` | 是否允许把 launch token 发往非回环地址（安全开关，别开） |
| `dsh.modelFallbacks` | 空数组 | 降级链；`config.example.json` 里有一条已失效的 `scnet`，别照抄 |
| `sessionCwd` | 空 | 空=每个会话在 `state/agents/<key>` 下建独立工作目录 |
| `role.maxInjectChars` | 6000 | 角色卡注入上限（字符） |
| `sendDelayMs` | 300 | 发送间隔 |
| `socialV2.pacing` | 见下 | **全局发送节奏**（防 QQ 风控 + 更像人）：任何一条发到 QQ 的消息（文字 / 语音 / 图片 / 表情）都先排队，两条之间至少 `minGapMs`，并随上一条字数增加 `perCharMs × 字数`，封顶 `maxGapMs`；表情走短档 `stickerGapMs`、语音前后至少 `voiceGapMs`、图片至少 `imageGapMs`；`jitterMs` 是每条的随机抖动（0~jitter）。`enabled:false` 可整体关掉 |
| `questionTimeoutMs` | 300000 | 提问等待超时 |
| `ackMessage` | `🤔 收到，正在思考…` | 收到消息时的自动回执（可空） |
| `allowAllWhenEmpty` | false | 白名单全空时是否放行所有人（安全开关，别开） |
| `deny` | 空 | 黑名单，优先级高于白名单 |
| `pricing` | 内置价目表 | 只影响统计，不影响功能 |
| `social` / `socialV2` | 内置默认 | 社交 V2 的唤醒/工具/记忆/语音等；**改了就要整段写**（浅合并） |

### 发送节奏 `socialV2.pacing` 的默认值

```jsonc
"pacing": {
  "enabled": true,
  "minGapMs": 1400,     // 两条消息之间的最小间隔
  "perCharMs": 90,      // 上一条每多一个字的额外间隔
  "maxGapMs": 12000,    // 上限（长文不让下一条等太久）
  "voiceGapMs": 4000,   // 语音前后至少这么久
  "stickerGapMs": 500,  // 表情：斗图要跟得上手
  "imageGapMs": 1500,   // 图片
  "jitterMs": 300       // 0..jitter 的随机抖动
}
```

为什么是这样：QQ 对短时间内连续发消息最敏感（同一个号连发几条一样的间隔，看着就像机器人）；
两三条短消息连发是最典型的触发场景。间隔随字数增长是因为「刚打完一大段」之后真人也会慢下来。
表情不按字数算——斗图是一来一回的，卡太久反而假。等待是**全局串行**的（不是每个会话各一条队列），
因为风控认的是账号，不是会话。

## 4. 改完要不要重启

**必须重启桥接**（`src/config-reload.js:5`）：`sessionCwd`、`agentPreset`、`snowluma.wsUrl`、`snowluma.httpUrl`、`snowluma.accessToken`、`dsh.baseUrl`、`dsh.authToken`、`dsh.authHeader`、`dsh.authPrefix`。

**热加载**（约 1 秒）：模型/降级链、白名单、社交参数、工具开关、角色注入上限……

**必须重启 DSH**：`cordis.patch.yml` 的 MCP/preset 变更（MCP 只在启动时加载）。
