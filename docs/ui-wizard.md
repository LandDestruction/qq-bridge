# 首启向导（First-run Wizard）设计

> 任务：T18 / owner w5（gen3）｜基线：`c496376`（= main）｜配套：`docs/ui-ia.md`
> 读者：w4（T16 外壳）、w2（T17 安装包）。**只定流程与校验口径，不写代码。**

## 0. 结论

向导是 **4 步 + 1 个导入分支**，每步都能「测试连接」、都能跳过，但跳过必须能解释后果。
判断「配好了没」不用新端点：`dshReady` + `allow.groups` + `ownerQQ` + 模型 catalog 四项齐了就相当于「已首启」，
第二次启动直接进仪表盘（降级方案见 `docs/ui-ia.md` §3-1）。

**关键约束**：向导要改的 6 个键**必须重启桥接**才生效（`src/config-reload.js:5-16` 的 `RESTART_REQUIRED_PATHS`），
所以向导最后一步固定是「保存 → 提示重启 → 重启后复查」。不要向用户承诺「保存即生效」。

## 1. 流程总览

```
[启动] ──已配置?──是──> [仪表盘]（不再弹向导）
   │否
   ▼
① QQ 通道 ──跳过/失败──┐
② DSH 连接 ──跳过/失败──┤
③ 模型与密钥 ─跳过/失败──┤──> [保存] ──> POST /api/config/reload ──skipped 非空──> [提示重启]
④ 人设与白名单 ─跳过/失败┘                                                    └─空─> [进仪表盘]
   │
   └─ 顶部常驻「从旧配置导入」入口（§7）
```

- 进度可中断：每步保存即落盘，退出向导不丢已填内容。
- 每一步的「测试连接」是**只读探测**，不写 `config.json`；只有「下一步/完成」才写。
- 全程不碰 `state/`、`logs/`、`audio/`；写入目标只有 `config.json`（写前备份 `config.json.bak-<时间戳>`）。

## 2. 步骤 ①②：通道与 DSH

| 项 | 步骤 ① QQ 通道（SnowLuma） | 步骤 ② DSH 连接 |
|---|---|---|
| **填什么** | `snowluma.httpUrl`（默认 `http://127.0.0.1:3000`）<br>`snowluma.wsUrl`（默认 `ws://127.0.0.1:3001`）<br>`snowluma.accessToken`（与 SnowLuma 面板里的一致）<br>`snowluma.followDiscoveredEndpoint`（默认 `true`） | `dsh.baseUrl`（默认 `http://127.0.0.1:13707`）<br>`dsh.authToken`（**可空**，见下）<br>高级：`dsh.authHeader` / `dsh.authPrefix` |
| **校验怎么算过** | `POST /api/self-check` → `report.groups` 里 `id === 'snowluma'` 那组的 `status === 'ok'`，且 `summary` 显示「QQ 在线 / WS 已连接」<br>（**不要**用 `GET /api/status.snowluma` 当唯一判据：它是**快照**，进程刚起时可能是陈旧值） | `GET /api/status` → `dshReady === true`<br>**且** `GET /api/dsh/models` → `source !== 'error'` 且 `total > 0`<br>两条都过才算过（只看 `dshReady` 会漏「连上了但模型目录空」） |
| **Cookie 怎么来** | 不涉及 | 默认自动：`discoverDshLaunchToken` 读本机启动令牌 → `discoverDshSessionCookie` 换会话 Cookie；本地回环（`isLoopbackBase`）才允许这条路径。mint 出的 Cookie 有效期 **1 小时**、提前 **5 分钟**刷新，不用用户管 |
| **失败文案** | `[QQ 通道] 连不上 ws://…：网关没启动或端口不对`<br>`[QQ 通道] 令牌被拒（401）：accessToken 与 SnowLuma 面板不一致`<br>`[QQ 通道] 已连接但账号未登录：请在 SnowLuma 里完成扫码` | `[DSH] 连不上 http://…：DSH 没启动（ECONNREFUSED）`<br>`[DSH] 认证失败（401）：本机令牌失效，请确认 DSH 是否以同一用户运行`<br>`[DSH] 已连接但模型目录为空：密钥或 provider 未配置` |
| **能否跳过** | 可以（明确写「稍后在设置里配」） | 可以 |
| **跳过后果** | QQ 收发**全停**：仪表盘通道灯红，会话/表情/日志页只读可见但无新数据 | `dshReady` 恒为 `false`：机器人收到消息只回 ack（`ackMessage`），**不产生回复**；不崩、不丢队列 |

## 3. 步骤 ③：模型与密钥

| 项 | 内容 |
|---|---|
| **填什么** | `dsh.provider` + `dsh.model`（从 `GET /api/dsh/models` 的 `models[]` 里选，不要手打）<br>`dsh.reasoningEffort`（`GET /api/dsh/models` 同源的强度选项）<br>`dsh.visionModels`（能看图的模型 id 列表，来自 `models[].seesImages === true`）<br>`dsh.modelFallbacks`（可空，按顺序兜底） |
| **密钥填哪** | DSH 侧管理；本客户端**不保存** provider 密钥。`config.template.json` 里 `dsh.authToken` 只用于本机 DSH 的访问令牌，不是模型密钥 |
| **校验怎么算过** | 1) `GET /api/dsh/models` 的 `current` 等于你选的 `provider/model`；2) `degraded === false`（true 说明已经在走兜底，选中的模型没真正生效）；3) 选定后 `POST /api/dsh/model` 返回 `ok: true` |
| **失败文案** | `[模型] 该模型不在可用清单里（400）：请从下拉里选，别手写`<br>`[模型] 已降级到 <provider>/<model>：首选模型不可用（degraded=true）`<br>`[模型] 看图能力未开启：当前模型 seesImages=false，发图会回「看不了图」` |
| **能否跳过** | 可以 |
| **跳过后果** | 沿用默认 `provider/model`；若默认模型不在 catalog 里，会**持续走 fallback**（日志里每轮一行降级），延迟与花费都不是你以为的那档 |

## 4. 步骤 ④：人设与群白名单

| 项 | 内容 |
|---|---|
| **填什么** | `ownerQQ`（管理员 QQ，纯数字）<br>`allow.groups`（允许的群号，纯数字）<br>`allow.private`（允许私聊的 QQ）<br>`allowAllWhenEmpty` **必须保持 `false`**<br>`agentPreset`（默认 `qq-chat-v2`）、`workspaceTitle`、`role.maxInjectChars` |
| **校验怎么算过** | `POST /api/whitelist` 返回 `ok:true`，然后 `GET /api/whitelist` 回读，把数字规范化后与输入**逐字段相等**（这个接口会去重、按 `Number()` 归一） |
| **失败文案** | `[白名单] ownerQQ 无效（400）：只填纯数字 QQ 号`<br>`[白名单] 保存失败（500）：config.json 解析异常，已拒绝写入（不会写坏原文件）`<br>`[白名单] 群号为空，机器人不会回应任何群（fail-closed）` |
| **能否跳过** | 界面上可以，但**必须拦一次**：文案「不填群号就等于谁都不理」，要求二次确认 |
| **跳过后果** | `allow.groups` 空 → 谁的群都不理（`allowAllWhenEmpty=false` 是硬语义）；`ownerQQ` 空 → 私聊 `/aiban` 管理员命令全部静默，只能从网页改 AI 黑名单 |

## 5. 扫码登录状态机（QQ 账号侧）

向导第①步与「设置→QQ 通道」共用这套状态。**这是我们要比参考实现强的地方**（`docs/ui-ia.md` §6「不借鉴 5」）。

| 状态 | 触发 | 用户看到什么 | 出口 |
|---|---|---|---|
| `idle` | 进入页面 | 「点击获取二维码」+ 说明「用手机 QQ 扫码」 | 获取二维码 |
| `waiting` | 二维码已展示 | 二维码 + 剩余有效期倒计时（建议 120s）+ 「刷新二维码」 | 扫码 / 刷新 / 取消 |
| `scanned` | 已扫未确认 | 「已扫码，请在手机上点确认」+ 二维码置灰防二次扫 | 等待 / 取消 |
| `success` | 账号登录成功 | 一次 toast + 自动前进到下一步 | 继续向导 |
| `expired` | 倒计时归零 | 「二维码已过期」+ **明显的**刷新按钮，且**停止**轮询 | 刷新（新二维码） |
| `failed` | 轮询接口报错 / 网关 401 | 「获取二维码失败：<原因>」+ 重试 + 「改用手动填令牌」 | 重试 / 退回手动配置 |

实现口径：参考实现是**固定 3s** 轮询；我们 3s 起步、连续失败退避到 5s，且**必须**在 `expired`/`failed` 停止轮询；
不做「无限重试直到成功」——那会让用户对着一个死页面等。

## 6. 保存与生效（别承诺「保存即生效」）

写盘后固定调一次 `POST /api/config/reload`，按返回决定提示：

| 返回字段 | 含义 | 向导怎么写 |
|---|---|---|
| `ok: true` + `changed: []` | 文件没变 | 「没有改动」 |
| `ok: true` + `skipped: []` | 全部热加载生效 | 「已生效」 |
| `ok: true` + `skipped: [...]` 非空 | **这些键必须重启** | 「已保存；`<键>` 需重启桥接后生效」+ 重启按钮（二次确认） |
| `ok: false` + `error` | 文件读不了/解析失败 | 「保存失败：`<error>`」，**保留用户输入**，不要清空表单 |

**必须重启的键**（源码 `src/config-reload.js:5-16`，向导里对这 10 个键加标记）：

```
consolePort  sessionCwd  agentPreset
snowluma.wsUrl  snowluma.httpUrl  snowluma.accessToken
dsh.baseUrl  dsh.authToken  dsh.authHeader  dsh.authPrefix
```

> 也就是说：**第①②步改的东西基本都要重启**。向导应在用户点「完成」时一次性提示，而不是每步弹一次。

## 7. 导入旧配置（两条路径）

### 7.1 从已有 `config.json` 导入

桌面客户端有本地文件权限，**在客户端里读，不经过 bridge**（bridge 没有「脱敏整份配置」的端点，见 `docs/ui-ia.md` §3-3/#10）。

1. 选文件 → 本地 `JSON.parse`（失败就报「不是合法 JSON」并停，不做任何猜测性修复）。
2. 逐字段比对，输出三组：`same`（一致）/ `differs`（值不同，问「用旧值还是新值」）/ `only-theirs`（我们不认识的键，**原样保留**，不删）。
3. 写之前备份成 `config.json.bak-<时间戳>`，**只在用户确认后**覆盖。
4. `POST /api/config/reload`，按 §6 提示重启。

字段映射（只列会不一致的部分，其余同名直传）：

| 旧 `config.json` | 新客户端字段 | 生效方式 |
|---|---|---|
| `snowluma.httpUrl` / `wsUrl` / `accessToken` | 同名字段 | **重启** |
| `dsh.baseUrl` / `authToken` / `provider` / `model` / `reasoningEffort` / `visionModels` / `modelFallbacks` | 同名字段 | `baseUrl`/`authToken` 重启，其余热加载 |
| `allow.groups` / `allow.private` / `allowAllWhenEmpty` / `ownerQQ` / `deny.*` | 同名字段 | 热加载（也可走 `POST /api/whitelist`） |
| `consolePort` / `consoleToken` | 同名字段 | **重启**（`consoleToken` 改完需重新登录控制台） |
| `agentPreset` / `workspaceTitle` / `sessionCwd` | 同名字段 | **重启** |
| `role.maxInjectChars` / `ackMessage` / `sendDelayMs` / `questionTimeoutMs` | 同名字段 | 热加载 |

### 7.2 从 `setup-dsh` 产物导入

`node scripts/setup-dsh.mjs` 的产物**不是配置，是 DSH 侧接线**，向导只做**校验**、不重写：

- `cordis.patch.yml` 里三个 MCP 条目（`MANAGED_MCP_IDS`）是否齐全 → 缺了提示「重新跑一次 setup-dsh」，向导不代跑；
- `dsh/agent-presets/<preset>/agent.cordis.yml` 与仓库源是否一致 → 不一致时提示「旧目录副本不会再生效，需人工合并」（这是 setup-dsh 自己的告警口径，向导照抄这句话即可）;
- 产物齐全 → 第②步可以直接标绿，跳「重新配置 DSH」。

## 8. 失败文案词表（统一句式）

`[组件] 现象：可能原因 → 下一步`，一律给**动作**，不给「未知错误」：

| 组件 | 现象 | 可能原因 | 下一步 |
|---|---|---|---|
| QQ 通道 | 连不上 `ws://…` | 网关没启动 / 端口不对 | 启动 SnowLuma；核对端口 |
| QQ 通道 | 401 | accessToken 与面板不一致 | 复制面板里的令牌 |
| QQ 通道 | 已连接未登录 | 账号掉线 | 扫码登录（§5 状态机） |
| DSH | ECONNREFUSED | DSH 没起 / 端口不是 13707 | 确认 DSH 在跑、端口一致 |
| DSH | 401 | 本机启动令牌失效 | 确认 DSH 与桥接同一 Windows 用户 |
| DSH | 模型目录空 | provider/密钥未配 | 去 DSH 侧配密钥 |
| 模型 | 400 | 手打了不存在的模型 id | 从 `/api/dsh/models` 下拉选 |
| 白名单 | 400 | ownerQQ 非纯数字 | 只填数字 |
| 白名单 | 500 | `config.json` 解析失败（fail-fast，未写回） | 先修 JSON 再保存 |

## 9. 验收清单（给 T17 安装包用）

- [ ] 全新机器（无 `config.json`）走完 4 步后：`/api/status.dshReady=true`、`/api/whitelist.allow.groups` 非空、`/api/dsh/models.total>0`。
- [ ] 中途退出再进来：已填内容还在，未完成步骤有角标。
- [ ] 全部跳过：能进仪表盘，四盏灯全红且**每盏都能点进对应设置**，不是死页面。
- [ ] 导出一台已配好的机器再导入另一台：`same/differs/only-theirs` 三组判定正确，`only-theirs` 键一个不少。
- [ ] 改 `consolePort` 后向导提示重启；重启后旧端口关闭、新端口可访问。
