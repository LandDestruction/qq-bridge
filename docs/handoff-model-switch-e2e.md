# 交接｜模型切换六 scope 真机验收（A 的新接口）

分支 `feat/audio`（已 `git merge main` 到 `7e33fc6`；线上 `main` 已含 A 的 `src/model-scope.js` + `/api/models`/`POST/DELETE /api/model`，最新 `e17ab6d`）。
验收时间：2026-10-26 16:19–17:18。线上未改无关字段；测试后已把 scope 恢复成用户目标配置。

## 一、验收结论

| # | scope | 结果 | 证据 / 说明 |
|---|---|---|---|
| 1 | main | ⚠️ 行为通过，**持久化有 P0** | `POST` 200 `persisted:true`；下一轮私聊账本 `deepseek-account/deepseek-flash`；但写盘时把整个 `dsh` 对象替换成 `{provider,model}`，丢 `baseUrl/authToken/authHeader/authPrefix/modelFallbacks/visionModels` |
| 2 | peak | ❌ **P0：写 scope 把 `agent.enabled` 丢了** | `POST` 200、`scopes.peak` 与 `/api/status.peakLocal.model` 都是 `mimo-v2.6-flash`；但 `config.socialV2.peakPause.agent` 变成 `{provider,model}`，`enabled` 消失，`peakLocal.mode` 从 `agent` 变成 `local`，无法验证回合 |
| 3 | media | ✅ | 设成非视觉 `workbuddy2api/deepseek-v4.1-flash` 后发图：`[模型] 选择 source=media …` + `[视觉] … 已切到 deepseek-account/deepseek-flash`；账本 `group:100000001 deepseek-account/deepseek-flash` |
| 4 | group / private | ✅ | group=`workbuddy2api/deepseek-v4.1-flash` → 账本 `group:100000002` 同模型；private=`workbuddy2api/glm-5.3` → 账本 `private:100000006` 同模型；`DELETE` 两 scope 均 `persisted:true` |
| 5 | override | ✅ | `POST override` → `persisted:false`、`scopes.override` 有值；群/私聊回合账本都是 override 模型；重启后 `scopes.override=null` |
| 6 | 持久化/免重启 | ⚠️ 部分失败 | media/group/private 写盘正常、PID 不变；**main/peak 写盘丢字段**。所有成功响应都带 `restartRequired:false`；`persisted:true` 对 media/group/private 成立 |

> 总结：**切换本身（下一轮生效、按 scope 选模型）基本可用；main/peak 的落盘实现有 P0，必须先修，否则一次切模型会把 DSH 连接/降级链/视觉清单写没。**

## 二、真机证据

### 2.1 main：能切，但落盘丢字段

请求：

```http
POST /api/model
{"scope":"main","provider":"deepseek-account","model":"deepseek-flash","persist":true}

200 {"ok":true,"scope":"main","applied":{"provider":"deepseek-account","model":"deepseek-flash"},
     "persisted":true,"restartRequired":false}
```

账本（下一轮私聊）：

```
16:21:36 private:100000012 deepseek-account/deepseek-flash turn undefined step undefined
16:21:38 private:100000012 deepseek-account/deepseek-flash turn 1 step 1
```

落盘后 `config.json` 的 `dsh`（**异常**）：

```json
{ "provider": "deepseek-account", "model": "deepseek-flash",
  "reasoningEffort": "max", "allowRemote": false, "authTokenExplicit": false }
```

丢失：`baseUrl`、`authToken`、`authHeader`、`authPrefix`、`modelFallbacks`、`visionModels`。
热加载日志随后连续告警：

```
[配置] 需要重启才生效，已保持旧值：dsh.baseUrl = undefined（磁盘为 "http://127.0.0.1:11046"）
[配置] 需要重启才生效，已保持旧值：dsh.authHeader = undefined（磁盘为 "authorization"）
...
```

**判断**：接口实现 bug（`node[leaf] = {provider, model}` 直接替换了 `dsh` 对象），不是权限/模型问题。
已用完整备份还原并重启；当前 `dsh.baseUrl`/`modelFallbacks`/`visionModels` 都在。

### 2.2 peak：值写对了，但 `agent.enabled` 被覆盖掉

```
POST /api/model {"scope":"peak","provider":"xiaomi-mimo","model":"mimo-v2.6-flash","persist":true}
200 {"ok":true,"scope":"peak","applied":{...},"persisted":true,"restartRequired":false}

/api/status.peakLocal.model = mimo-v2.6-flash   ✅
config.socialV2.peakPause.agent = { "provider":"xiaomi-mimo","model":"mimo-v2.6-flash" }  ❌ 缺 enabled
/api/status.peakLocal.mode = "local"            ❌ 原本是 "agent"
```

**判断**：同样是「替换整个对象」的 API 实现 bug；`peakPause.agent.enabled` 被抹掉后
`peakAgentCfg().enabled === false`，高峰 agent 不再接管，无法做「切 peak 后账本变 flash」的回合验证。
已在最终配置里恢复 `agent.enabled:true`。

### 2.3 media：改非视觉模型 → 触发视觉兜底（PASS）

先把 media 设成非视觉的 `workbuddy2api/deepseek-v4.1-flash`，再由管理员发图 + @：

```
17:17:36 [模型] 选择 source=media workbuddy2api/deepseek-v4.1-flash（带图强制）
17:17:36 [视觉] 本轮含图，当前模型 workbuddy2api/deepseek-v4.1-flash 不支持图片，已切到 deepseek-account/deepseek-flash
17:17:36 已设置会话模型 session-76ea0641… (group:100000001) -> deepseek-account/deepseek-flash (high)
17:17:56 [reserved2] 工具统一发送 group:100000001: 成功 3/3 条
```

账本：

```
17:17:38 group:100000001 deepseek-account/deepseek-flash
17:17:48 group:100000001 deepseek-account/deepseek-flash
17:17:58 group:100000001 deepseek-account/deepseek-flash
18:00    group:100000001 deepseek-account/deepseek-flash
```

**判断**：media scope 生效；`modelForMedia` 不是视觉模型时会按 `dsh.visionModels` 自动兜底到
`deepseek-account/deepseek-flash`，日志/账本一致。

### 2.4 group / private：按类型生效（PASS）

```http
POST /api/model {"scope":"group","provider":"workbuddy2api","model":"deepseek-v4.1-flash","persist":true}
POST /api/model {"scope":"private","provider":"workbuddy2api","model":"glm-5.3","persist":true}
```

账本：

```
16:22:21 private:100000006 workbuddy2api/glm-5.3
16:22:40 group:100000002   workbuddy2api/deepseek-v4.1-flash
```

`GET /api/models.scopes` 同时显示：

```json
"group":{"provider":"workbuddy2api","model":"deepseek-v4.1-flash"},
"private":{"provider":"workbuddy2api","model":"glm-5.3"}
```

**判断**：按类型区分生效；`DELETE` 两个 scope 都返回 `persisted:true, cleared:true`。

### 2.5 override：只影响运行期，重启清空（PASS）

```http
POST /api/model {"scope":"override","provider":"deepseek-account","model":"deepseek-flash","persist":false}
200 {"ok":true,"scope":"override","applied":{...},"persisted":false,"restartRequired":false}
```

`GET /api/models.scopes.override` 立即有值；账本：

```
16:24:37 group:100000002    deepseek-account/deepseek-flash
16:24:48 group:100000004    deepseek-account/deepseek-flash
16:24:51 private:100000012 deepseek-account/deepseek-flash
```

重启（PID 87404 → 89892）后：

```json
"override": null
```

**判断**：override 是纯运行期覆盖，重启丢弃；符合预期。

## 三、PID / 无重启

| 阶段 | PID | 说明 |
|---|---|---|
| 验收开始（旧代码） | 83792 | 无 scopes |
| 部署 A 的接口后 | 80480 | 为加载新代码重启一次 |
| 测试中恢复配置/清 override | 87404 → 89892 | 两次主动重启（验证 override 清空） |
| 17:05 外部重启（用户/另一窗口，含最新 `e17ab6d`） | 76280 | media 图片测试及最终恢复都在此进程 |
| 最终 scope 写入（media/group/private） | 76280 | **PID 未变**，`restartRequired:false` |

除部署和两次「验证 override 重启」外，**每个 scope 切换都没有重启**；切换在下一轮生效。

## 四、最终配置（用户目标）

```json
{
  "dsh": { "provider": "workbuddy2api", "model": "deepseek-v4.1-flash" },
  "socialV2": {
    "peakPause": {
      "enabled": true,
      "agent": { "enabled": true, "provider": "xiaomi-mimo", "model": "mimo-v2.6-flash" }
    },
    "modelForMedia": { "provider": "deepseek-account", "model": "deepseek-flash" },
    "modelByKind": {}
  }
}
```

`GET /api/models.scopes`：

```json
{"main":{"provider":"workbuddy2api","model":"deepseek-v4.1-flash"},
 "peak":{"provider":"xiaomi-mimo","model":"mimo-v2.6-flash"},
 "media":{"provider":"deepseek-account","model":"deepseek-flash"},
 "group":null,"private":null,"override":null}
```

`dsh.baseUrl`/`modelFallbacks`/`visionModels` 等字段完整；PID `76280`。

## 五、复现命令

```powershell
$token = (Get-Content state\console-token -Raw).Trim()
$h = @{ 'x-console-token' = $token; 'content-type' = 'application/json' }

# 1 main
Invoke-RestMethod http://127.0.0.1:3100/api/model -Method Post -Headers $h -Body (@{
  scope='main'; provider='deepseek-account'; model='deepseek-flash'; persist=$true } | ConvertTo-Json)

# 2 peak（注意：当前会丢 agent.enabled，别在线上直接跑）
Invoke-RestMethod http://127.0.0.1:3100/api/model -Method Post -Headers $h -Body (@{
  scope='peak'; provider='xiaomi-mimo'; model='mimo-v2.6-flash'; persist=$true } | ConvertTo-Json)

# 3 media
Invoke-RestMethod http://127.0.0.1:3100/api/model -Method Post -Headers $h -Body (@{
  scope='media'; provider='deepseek-account'; model='deepseek-flash'; persist=$true } | ConvertTo-Json)

# 4 group / private
Invoke-RestMethod http://127.0.0.1:3100/api/model -Method Post -Headers $h -Body (@{
  scope='group'; provider='workbuddy2api'; model='deepseek-v4.1-flash'; persist=$true } | ConvertTo-Json)
Invoke-RestMethod http://127.0.0.1:3100/api/model -Method Post -Headers $h -Body (@{
  scope='private'; provider='workbuddy2api'; model='glm-5.3'; persist=$true } | ConvertTo-Json)

# 5 override（运行期）
Invoke-RestMethod http://127.0.0.1:3100/api/model -Method Post -Headers $h -Body (@{
  scope='override'; provider='deepseek-account'; model='deepseek-flash'; persist=$false } | ConvertTo-Json)

# 6 读取 + 清除
Invoke-RestMethod http://127.0.0.1:3100/api/models -Headers $h | ConvertTo-Json -Depth 6
Invoke-RestMethod 'http://127.0.0.1:3100/api/model?scope=group' -Method Delete -Headers $h
Get-Content state\bridge.lock
Get-Content state\token-usage.jsonl -Tail 10
```

## 六、必须修 / 已知限制

1. **P0（main/peak 落盘）**：`src/model-scope.js` 的路径对 `main` 是 `['dsh']`、对 `peak` 是
   `['socialV2','peakPause','agent']`，而路由里 `node[leaf] = { provider, model }` 直接替换整个对象。
   修复应改成 **merge**：只写 `node[leaf].provider/model`（`main` 写 `dsh.provider/model`），保留
   `dsh` 的连接/降级/视觉字段与 `peakPause.agent.enabled`。修完重跑 main/peak 两项。
2. **peak 回合验证**：因上面的 bug，本次只能验证 `scopes.peak` 与 `/api/status.peakLocal.model`，
   没拿到 peak 回合账本；修复后应能复现「group 回合账本 = xiaomi-mimo/mimo-v2.6-flash」。
3. media scope 需要**新图片**触发；本次用 17:17 管理员发的图，日志/账本完整。
4. `POST main/peak` 的**热加载告警**会提示 `dsh.baseUrl/auth*` 被保持旧值；这是落盘丢字段的下游表现，
   不是热加载坏了。
5. 本次把 A 的 `feat/backend` 合并到了 `main` 以做真机验收（fast-forward）；B 的 `feat/frontend`
   面板尚未合并，但接口契约已按 B 的 `ops.html` 对齐。
