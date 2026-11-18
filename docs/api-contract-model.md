# 契约：模型切换（/api/model、/api/models）与模型路由（/api/model-routing）

状态：以当前 `main` 的实现为准（A 的 msg-a56 + routing）。代码：`src/model-scope.js`、`src/model-routing.js`、
`src/bridge.js`；测试：`scripts/test-model-scope.mjs`、`scripts/test-model-routing.mjs`、
`scripts/test-model-api-contract.mjs`（契约层）。

## 1. 六个 scope

| scope | 作用 | 写入的 config 路径 | 清空语义 |
|---|---|---|---|
| `main` | 所有会话默认模型 | `dsh.provider` + `dsh.model` | **不允许**（400） |
| `peak` | 高峰时段群聊 agent | `socialV2.peakPause.agent` | 删除该对象 |
| `media` | 带图/表情/视频回合 | `socialV2.modelForMedia` | 删除该对象 |
| `group` | 群聊回合 | `socialV2.modelByKind.group` | 删除该对象 |
| `private` | 私聊回合 | `socialV2.modelByKind.private` | 删除该对象 |
| `override` | **运行期覆盖**（不落盘） | 无（只在内存） | 清掉运行期覆盖 |

scope 顺序固定为 `main/peak/media/group/private/override`（`MODEL_SCOPES`）。
`scope` 省略时默认 **`override`**（旧前端兼容：它原本只期望“临时切一下”）。
`override` 只影响本进程后续回合，**永不写 config.json**（`persisted:false`）。

## 2. GET /api/models

```json
{
  "ok": true,
  "current": { "provider": "workbuddy2api", "model": "deepseek-v4.1-flash" },
  "scopes": {
    "main":    { "provider": "…", "model": "…" } | null,
    "peak":    { "provider": "…", "model": "…" } | null,
    "media":   null,
    "group":   { "provider": "…", "model": "…" } | null,
    "private": null,
    "override": null
  },
  "options": [ { "provider": "…", "model": "…", "label": "…" } ],
  "catalog": true,
  "byKind": { "group": {…}, "private": {…} },
  "note": "切换对下一轮生效，无需重启"
}
```

- `options`：DSH 动态可用清单优先；拿不到时回落到 `socialV2.modelOptions` 或内置静态清单。
- `catalog`：**布尔**，DSH 可用清单是否拿到（false 时 `options` 为静态清单，POST 仍允许写入）。
- `scopes` 的值是 `{provider, model}` 或 `null`（未配置）。

## 3. POST /api/model

请求：

```json
{ "scope": "group", "provider": "workbuddy2api", "model": "glm-5.3", "persist": true }
```

- `scope` 省略 → `override`；`persist` 省略 → `true`（仅对可落盘 scope 有效；`override` 永远不落盘）。
- 成功响应：`{ok:true, scope, applied:{provider,model}|null, persisted:boolean, restartRequired:false}`。
- 清空（`model:""`）：`applied` 为 `null`，非 `override` scope 会从 config 删除对应节点。
- **对下一轮生效、无需重启**：写内存 + `modelSelectionEpoch += 1`；落盘 scope 还会 `reloadConfigFromDisk`。

### 错误码

| HTTP | 触发条件 | 响应 |
|---|---|---|
| 400 | `scope` 不在六个之内 | `{ok:false,error:"scope 必须是 main/peak/media/group/private/override"}` |
| 400 | 设置模型但 `provider` 为空 | `{ok:false,error:"设置模型时 provider 不能为空"}` |
| 400 | `scope=main` 且 `model` 为空 | `{ok:false,error:"main 不允许清除（至少要给一个模型）"}` |
| 400 | 清单可用但 `provider/model` 不在清单内 | `{ok:false,error:"模型 x/y 不在可用清单里", models:[…]}` |
| 405 | `/api/model-routing` 以外的非法方法 | 见对应路由 |

**清单缺失（catalog missing）**：不返回错误。POST 只写日志「拿不到 DSH 清单，无法校验，按请求写入」，
仍返回 200 且 `persisted:true`；GET 的 `catalog:false` 是唯一信号。这是故意的：DSH 挂掉时运维仍要能改模型。

## 4. DELETE /api/model?scope=

- 等价 `POST` + `model:""`；`scope` 省略默认 `override`。
- `override`：清运行期覆盖，返回 `{ok:true,scope:"override",cleared:true,persisted:false}`。
- 其它 scope：从 config 删除节点并落盘，返回 `{ok:true,scope,cleared:true,persisted:true,restartRequired:false}`。
- `DELETE ?scope=main` → 400（main 不可清）；未知 scope → 400。

## 5. GET /api/model-routing

```json
{
  "ok": true,
  "peakPause": { "enabled": true, "schedule": true, "windows": [ … ], "inWindow": false, "active": false },
  "routing": {
    "idle": { "provider": "…", "model": "…" },
    "peak": { "provider": "…", "model": "…" },
    "fallback": [ { "provider": "…", "model": "…" } ],
    "disabled": [ { "provider": "…", "model": "…" } ]
  },
  "effective": { "provider": "…", "model": "…", "source": "media|peak|idle|fallback|main" },
  "options": [ { "provider": "…", "model": "…", "label": "…" } ],
  "catalog": true,
  "note": "保存后下一轮生效，无需重启"
}
```

字段语义：

| 字段 | 说明 |
|---|---|
| `peakPauseEnabled` | 面板用的开关值；GET 里由 `peakPause.enabled` 体现，POST 用 `peakPauseEnabled` 写入 |
| `routing.idle` | 空闲期首选模型；`null` 表示不配置、回落主模型 |
| `routing.peak` | 高峰期首选模型；`null` 表示高峰直接走 idle/主模型 |
| `routing.fallback` | 降级候选（最多 5 个，自动去重） |
| `routing.disabled` | 禁用模型（最多 5 个；选择时永远跳过） |
| `effective` | 按当前时刻算出的生效模型；`source` 表示命中哪一层 |
| `catalog` | 布尔；false 时 `effective` 仍按配置计算（不做清单过滤） |

选择优先级（`resolveModelChoice`）：**media > peak（仅高峰）> idle > fallback 顺序 > null（调用方回落主模型）**；
全程跳过 `disabled` 与运行期已知坏模型；`catalog` 非空时只认清单内模型；`catalog` 为空（缺失）时不过滤。

## 6. POST /api/model-routing

请求（字段都可选，只更新给出的）：

```json
{
  "idle":     { "provider": "deepseek-account", "model": "deepseek-flash" },
  "peak":     { "provider": "xiaomi-mimo", "model": "mimo-v2.6-pro" },
  "fallback": [ { "provider": "workbuddy2api", "model": "glm-5.3" } ],
  "disabled": [ { "provider": "workbuddy2api", "model": "deepseek-v4-pro" } ],
  "peakPauseEnabled": true
}
```

**两种候选写法都收**（`src/model-routing.js` 的 `normalizeModelRef`）：
对象 `{"provider":"p","model":"m"}`，或字符串 `"p/m"`（运维面板 `/ops` 的下拉值就是这个形态）。
两者的语义完全等价，`fallback`/`disabled` 里可以混用。

- 成功：`{ok:true, routing:{idle,peak,fallback,disabled}, persisted:true, restartRequired:false}`。
- 校验：只校验「本次设置了的」候选；清单可用且不在清单 → **400**；清单不可用 → 只告警仍写入。
- **解析守卫（400）**：请求里给了候选但解析不出 provider/model（如 `"noprovider"`）→
  `{ok:false,error:'无法解析的模型（要 "provider/model" 或 {provider,model}）：…'}`，不静默丢成 null。
- **清空守卫（400）**：磁盘上本来有路由，而这次请求会把 `idle`/`peak`/`fallback` **一起清空** →
  拒绝写入，除非显式带 `"allowEmpty": true`。理由见下方事故说明。
- 落盘：`socialV2.modelRouting`（及可选 `socialV2.peakPause.enabled`），写后 `reloadConfigFromDisk` 并递增 epoch。
- 非法方法 → **405** `{ok:false,error:"只支持 GET/POST"}`。

> ⚠️ 事故（2026-10-26 21:1x，已修）：面板发字符串、后端 `normalizeRouting` 只认对象，
> 于是「在 /ops 点一次保存」会把 `socialV2.modelRouting` 写成
> `{idle:null,peak:null,fallback:[],disabled:[]}`，下一轮就退回 `dsh` 默认模型
> （群里表现成「换的模型没生效 / 高峰没切」）。现在字符串归一 + 上面两道 400 守卫都在，
> 并有真机回归 `scripts/probe-model-routing-live.mjs`（GET → POST 字符串 → GET → 核对 config.json 没被写坏）。

## 7. curl 示例

```bash
TOKEN=...   # 控制台 token

# 1) 读六个 scope + 清单可用性
curl -s http://127.0.0.1:3080/api/models -H "x-console-token: $TOKEN"

# 2) 临时覆盖（运行期，不落盘）
curl -s -X POST http://127.0.0.1:3080/api/model -H "x-console-token: $TOKEN" \
  -H 'content-type: application/json' -d '{"scope":"override","provider":"deepseek-account","model":"deepseek-flash"}'

# 3) 主模型（落盘）
curl -s -X POST http://127.0.0.1:3080/api/model -H "x-console-token: $TOKEN" \
  -H 'content-type: application/json' -d '{"scope":"main","provider":"deepseek-account","model":"deepseek-flash"}'

# 4) 群聊模型
curl -s -X POST http://127.0.0.1:3080/api/model -H "x-console-token: $TOKEN" \
  -H 'content-type: application/json' -d '{"scope":"group","provider":"workbuddy2api","model":"glm-5.3"}'

# 5) 清空看图模型（回落主模型）
curl -s -X DELETE "http://127.0.0.1:3080/api/model?scope=media" -H "x-console-token: $TOKEN"

# 6) 读模型路由（空闲/高峰/降级/禁用 + 生效模型）
curl -s http://127.0.0.1:3080/api/model-routing -H "x-console-token: $TOKEN"

# 7) 保存路由
curl -s -X POST http://127.0.0.1:3080/api/model-routing -H "x-console-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"idle":{"provider":"deepseek-account","model":"deepseek-flash"},"peakPauseEnabled":true}'

# 8) 只禁用某个模型
curl -s -X POST http://127.0.0.1:3080/api/model-routing -H "x-console-token: $TOKEN" \
  -H 'content-type: application/json' -d '{"disabled":[{"provider":"workbuddy2api","model":"deepseek-v4-pro"}]}'
```

## 8. 与 B 的前端字段对应

| 面板控件 | 请求 | 响应读取 |
|---|---|---|
| 模型 scope 下拉 | `POST /api/model {scope,...}` | `applied`、`persisted`（override 时提示“仅本次运行”） |
| 清空按钮 | `DELETE /api/model?scope=` | `cleared:true` |
| 路由：空闲/高峰 | `POST /api/model-routing {idle,peak}` | `routing.idle/peak` |
| 路由：降级候选 | `{fallback:[…]}` | `routing.fallback` |
| 路由：禁用列表 | `{disabled:[…]}` | `routing.disabled` |
| 高峰开关 | `{peakPauseEnabled:true|false}` | `peakPause.enabled` |
| 当前生效模型 | 只读 GET | `effective`（`source` 显示命中层） |
| 清单可用性 | 只读 GET | `catalog:false` 时不要标“已校验” |
