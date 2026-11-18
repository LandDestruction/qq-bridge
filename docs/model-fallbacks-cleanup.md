# 失效 `dsh.modelFallbacks` 条目清理方案

> 任务：T6（只出方案，**不改真实 `config.json`**；落盘与重启由主窗口执行）
> 结论：删掉 `config.json` 里 `dsh.modelFallbacks` 的第 4 项（`scnet/DeepSeek-V4.1-Flash-1017-Event`）即可，**不需要重启就能生效**；想看到启动告警消失再重启一次。
> 本文不含任何 key / token 明文。

## 1. 现状核对（实测，非推测）

| 项 | 实测值 |
|---|---|
| 主模型 `dsh.model` | `workbuddy2api/deepseek-v4.1-flash`（在可用清单里，校验通过） |
| 失效条目 | `dsh.modelFallbacks[3]` = `{ provider: "scnet", model: "DeepSeek-V4.1-Flash-1017-Event" }` |
| 实时模型目录 `GET /api/models` | `catalog: true`，共 **9** 个模型，**没有任何 scnet 条目**（`scnet` provider 整体已下线） |
| `config.json` 里 `scnet` 出现次数 | **1 次**（只在这条 fallbacks 里，没有别的字段引用它） |

实时可用清单（9 个）：

```
deepseek-official/deepseek-flash      deepseek-official/deepseek-v4-pro
deepseek-account/deepseek-flash       deepseek-account/deepseek-v4-pro
workbuddy2api/deepseek-v4.1-flash     workbuddy2api/deepseek-v4-pro
workbuddy2api/glm-5.3                 xiaomi-mimo/mimo-v2.6-pro
xiaomi-mimo/mimo-v2.6-flash
```

## 2. 告警来自哪段代码

- **文案产生**：`src/model-fallback.js:177`，在 `validateModelConfig()` 遍历 `fallbacks` 时，凡是不在可用清单里的条目就 push 一条 warning。
- **触发时机**：`src/bridge.js:3587` 的启动 IIFE（`void (async () => {...})()`）拿到一次 `session/modelCatalog`，在 `src/bridge.js:3591-3597` 调用它并打印：

  ```
  ⚠️ 模型配置校验：config.json 的 dsh.modelFallbacks 里有不可用的备用模型「scnet/DeepSeek-V4.1-Flash-1017-Event」（provider 或模型 id 已不存在）
  ```

- **线上日志印证**（`logs/bridge-stdout.log`，今天三次启动各一条）：

  ```
  20:15:45 ⚠️ 模型配置校验：config.json 的 dsh.modelFallbacks 里有不可用的备用模型「scnet/…-1017-Event」（provider 或模型 id 已不存在）
  20:15:45 模型配置校验通过：workbuddy2api/deepseek-v4.1-flash 在可用清单里（共 7 个模型）
  20:45:24 …（同上）      21:21:03 …（同上）
  ```

- **重要边界**：这条 warning **不置 `ok=false`**（见 `src/model-fallback.js:172-180`，只有主模型不可用才会 `ok=false` 并触发运行期回退）。所以它是「噪音 + 一次白付的降级跳」，不是当前故障原因 —— 主模型是好的。

## 3. 影响面：谁在消费这个数组

| 位置 | 作用 | 删掉这条后 |
|---|---|---|
| `src/bridge.js:3594` | 启动校验，只出告警 | 告警消失 |
| `src/bridge.js:7080` | `GET /api/model` 回显 `fallbacks`（控制台只读区「降级链」） | 控制台里少一行 |
| `src/bridge.js:11496` | `planFallback()` → `recordModelFailure()`，**容量类错误真降级** | 真降级时少跳一次死模型 |
| `src/bridge.js:11721` | 含图回合用 `orderFallbacksByProvider()` 挑能看图的模型 | 视觉链少一个永远命不中的候选 |
| `src/bridge.js:16628` | 状态里统计 `modelFallbacks.length`（5 → 4） | 只影响展示计数 |
| `src/local-fallback.js:112` | 注释：先让 fallbacks 顶上，全用尽才轮到本地 8B | 不变 |

### 留着它的实际代价

真降级时（`planFallback` 不查目录，只按 provider 交错挑下一个不同的模型），链会走到 `scnet/…`，此时 `selectModel` 必然失败，再靠 `src/bridge.js:11768` 的 `isModelUnavailableError` 自愈分支（`probeAvailableModels({force:true})` + `pickUsableModel` + 重试一次），并把它登记进 `knownUnavailableModels`（`src/bridge.js:11785`）以后才不再试。
**代价 = 一次白付的 RPC（可能再叠 1s `sleep`）+ 一段日志噪音**，换来的是一次注定失败的尝试。

### 删掉后降级链变成什么（用模块自身 `orderFallbacksByProvider()` + 真实配置值实算）

`orderFallbacksByProvider` 的规则：**配置最后一项是「最后兜底」钉死在链尾**，其余按 provider 交错，当前 provider 的桶排最后。当前末项是 `deepseek-account/deepseek-v4-pro`，删的是第 4 项，所以**末位兜底不变**，其余各项相对顺序也不变，只是少一跳。

当前 provider = `workbuddy2api`（就是现在的运行态）：

```
删前：1. deepseek-account/deepseek-flash
      2. scnet/DeepSeek-V4.1-Flash-1017-Event        ← 死条目
      3. workbuddy2api/deepseek-v4-pro
      4. workbuddy2api/glm-5.3
      5. deepseek-account/deepseek-v4-pro             ← 钉死的末位兜底

删后：1. deepseek-account/deepseek-flash
      2. workbuddy2api/deepseek-v4-pro
      3. workbuddy2api/glm-5.3
      4. deepseek-account/deepseek-v4-pro             ← 末位兜底不变
```

另两种运行态同样只是少一跳（实算结果）：

```
当前 provider = deepseek-account
  删前 1.workbuddy2api/deepseek-v4-pro 2.scnet/… 3.deepseek-account/deepseek-flash 4.workbuddy2api/glm-5.3 5.deepseek-account/deepseek-v4-pro
  删后 1.workbuddy2api/deepseek-v4-pro 2.deepseek-account/deepseek-flash 3.workbuddy2api/glm-5.3 4.deepseek-account/deepseek-v4-pro

当前 provider = scnet（理论态，已不可达）
  删前 1.workbuddy2api/deepseek-v4-pro 2.deepseek-account/deepseek-flash 3.scnet/… 4.workbuddy2api/glm-5.3 5.deepseek-account/deepseek-v4-pro
  删后 1.workbuddy2api/deepseek-v4-pro 2.deepseek-account/deepseek-flash 3.workbuddy2api/glm-5.3 4.deepseek-account/deepseek-v4-pro
```

### 不受影响、不要顺手改的字段

- `dsh.model` = `workbuddy2api/deepseek-v4.1-flash`（主模型，好的）
- `dsh.visionModels` = `["deepseek-flash"]`（看图文案用的短名，与 scnet 无关）
- `socialV2.modelForMedia` = `deepseek-account/deepseek-flash`
- `socialV2.modelByKind` = `{}`（空）
- **别删最后一项** `deepseek-account/deepseek-v4-pro`：它是钉死的末位兜底，`scripts/test-model-fallback.mjs` 有一条专门测「官方 DeepSeek 是链尾兜底」。
- **别把数组删空**：空数组时 `planFallback` 返回 `none`，日志变成「模型不可用，但没有可用的 dsh.modelFallbacks，无法自动降级」，就只剩本地 8B 兜底了。

## 4. 精确改法（diff 级）

目标文件：`<本机路径>\qq-bridge-src\config.json`（**主仓库的真实配置，由主窗口执行**）

### 改前（第 11–32 行，`dsh.modelFallbacks` 整段）

```json
    "modelFallbacks": [
      {
        "provider": "workbuddy2api",
        "model": "deepseek-v4-pro"
      },
      {
        "provider": "workbuddy2api",
        "model": "glm-5.3"
      },
      {
        "provider": "deepseek-account",
        "model": "deepseek-flash"
      },
      {
        "provider": "scnet",
        "model": "DeepSeek-V4.1-Flash-1017-Event"
      },
      {
        "provider": "deepseek-account",
        "model": "deepseek-v4-pro"
      }
    ]
```

### 改后（删掉**第 24–27 行**那 4 行，其余原样；数组从 5 项变 4 项）

```json
    "modelFallbacks": [
      {
        "provider": "workbuddy2api",
        "model": "deepseek-v4-pro"
      },
      {
        "provider": "workbuddy2api",
        "model": "glm-5.3"
      },
      {
        "provider": "deepseek-account",
        "model": "deepseek-flash"
      },
      {
        "provider": "deepseek-account",
        "model": "deepseek-v4-pro"
      }
    ]
```

也就是只删这 4 行（含对象后的逗号）：

```diff
       {
         "provider": "deepseek-account",
         "model": "deepseek-flash"
-      },
-      {
-        "provider": "scnet",
-        "model": "DeepSeek-V4.1-Flash-1017-Event"
       },
       {
         "provider": "deepseek-account",
         "model": "deepseek-v4-pro"
       }
```

> 行号以当前磁盘内容为准；改动前先确认第 24–27 行确实是 scnet 那段（`config.json` 会被人手改，行号可能漂）。删完保持 2 空格缩进与逗号位置不变，JSON 不能留尾逗号。

## 5. 改完是否必须重启：**不需要**

三条都核对过：

1. **白名单会搬运该字段**：`loadConfig()` 的 `dsh` 段是整体展开 `...(file.dsh ?? {})`（`src/bridge.js:854`），不是逐字段白名单，`modelFallbacks` 会原样带进来。
2. **不在「必须重启」清单里**：`src/config-reload.js:5-16` 的 `RESTART_REQUIRED_PATHS` 只含 `consolePort / sessionCwd / agentPreset / snowluma.{wsUrl,httpUrl,accessToken} / dsh.{baseUrl,authToken,authHeader,authPrefix}`，**没有 `dsh.modelFallbacks`**。
3. **热加载确实会替换 cfg**：`src/bridge.js:16836-16860` 的 `reloadConfigFromDisk()` → `pinRestartOnlyFields()` 只把必须重启的字段钉回旧值，其余 `delete cfg[key]` + `Object.assign(cfg, next)` 原地替换。

而且当前**自动监听是开着的**（`GET /api/config/reload` 实测 `enabled: true, watching: true`，`src/bridge.js:16895` 的 `fs.watch` + 800ms 防抖），所以保存文件后约 1 秒就生效，连手动触发都可以省。

**唯一必须重启才能看到的变化**：第 2 节那条启动告警**只在进程启动时打一次**（`src/bridge.js:3587` 的 IIFE 不参与热加载）。所以「热加载后告警消失」这件事本身看不到 —— 热加载生效的判据是下面 6.3/6.4，告警消失要等下次重启（或主窗口主动重启那次）。

## 6. 验证命令（全部只读）

### 6.1 语法先过一遍（改完立刻跑）

```powershell
cd <本机路径>\qq-bridge-src
node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('JSON OK')"
```

### 6.2 确认条目真没了、别的没动

```powershell
cd <本机路径>\qq-bridge-src
node -e "const c=require('./config.json');console.log('fallbacks='+c.dsh.modelFallbacks.length);c.dsh.modelFallbacks.forEach((f,i)=>console.log(' ['+i+'] '+f.provider+'/'+f.model));console.log('model='+c.dsh.model);console.log('visionModels='+JSON.stringify(c.dsh.visionModels));"
```

预期：`fallbacks=4`，四项依次为 `workbuddy2api/deepseek-v4-pro`、`workbuddy2api/glm-5.3`、`deepseek-account/deepseek-flash`、`deepseek-account/deepseek-v4-pro`，`model` 与 `visionModels` 不变。

### 6.3 热加载状态（不需要令牌也能看的部分）

```powershell
cd <本机路径>\qq-bridge-src
Get-Content logs\bridge-stdout.log -Tail 40 | Select-String -Pattern '\[配置\] 热加载'
```

保存后约 1 秒应出现新的一行（`count` 会递增）：

```
[配置] 热加载（watch）：生效 1 项（dsh）
```

> 若显示「磁盘内容无变化」，说明没存上或存到了别处；若出现「需要重启才生效，已保持旧值：dsh.xxx」，说明改到了重启类字段（本方案不会）。

带令牌的手动触发（令牌**现取现用、不落纸**，配置里没配则读 `state/console-token`）：

```powershell
cd <本机路径>\qq-bridge-src
node -e "const fs=require('fs');let t=String(JSON.parse(fs.readFileSync('config.json','utf8')).consoleToken||'').trim();if(!t){try{t=fs.readFileSync('state/console-token','utf8').trim()}catch(e){}};fetch('http://127.0.0.1:3100/api/config/reload',{method:'POST',headers:{'x-console-token':t}}).then(r=>r.json()).then(j=>console.log('ok='+j.ok,'changed='+JSON.stringify(j.changed),'skipped='+JSON.stringify(j.skipped)))"
```

预期：`ok=true changed=["dsh"] skipped=[]`。

### 6.4 生效后链路核对（只读接口）

```powershell
cd <本机路径>\qq-bridge-src
node -e "const fs=require('fs');let t=String(JSON.parse(fs.readFileSync('config.json','utf8')).consoleToken||'').trim();if(!t){try{t=fs.readFileSync('state/console-token','utf8').trim()}catch(e){}};fetch('http://127.0.0.1:3100/api/model',{headers:{'x-console-token':t}}).then(r=>r.json()).then(j=>{console.log('provider='+j.provider,'model='+j.model,'degraded='+j.degraded);j.fallbacks.forEach((f,i)=>console.log(' '+(i+1)+'. '+f.provider+'/'+f.model))})"
```

预期：`fallbacks` 只剩 4 条、无 scnet，且主模型仍是 `workbuddy2api/deepseek-v4.1-flash`。

### 6.5 仓库单套回归（本方案未改代码，跑一遍确认基线没漂）

```powershell
cd <本机路径>\w6
node scripts/test-model-fallback.mjs
```

预期：`✅ 59/59 通过`。

### 6.6 （可选，下次重启后）确认告警消失

重启后看启动日志：

```powershell
Get-Content <本机路径>\qq-bridge-src\logs\bridge-stdout.log -Tail 80 |
  Select-String -Pattern '不可用的备用模型|模型配置校验'
```

预期：**只有** `模型配置校验通过：workbuddy2api/deepseek-v4.1-flash 在可用清单里（共 9 个模型）`，那条 `不可用的备用模型「scnet/…」` 不再出现。

## 7. 回滚

### 7.1 改前先备份（推荐，一行）

```powershell
cd <本机路径>\qq-bridge-src
Copy-Item config.json "config.json.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

> 备份文件别提交、别放进 `state/`；用完删掉。

### 7.2 手工回滚（把 4 行加回原位）

插在 `deepseek-account/deepseek-flash` 那个对象**之后**、最后的 `deepseek-account/deepseek-v4-pro` 之前，注意补逗号：

```diff
       {
         "provider": "deepseek-account",
         "model": "deepseek-flash"
+      },
+      {
+        "provider": "scnet",
+        "model": "DeepSeek-V4.1-Flash-1017-Event"
       },
       {
         "provider": "deepseek-account",
         "model": "deepseek-v4-pro"
       }
```

### 7.3 整文件回滚

```powershell
cd <本机路径>\qq-bridge-src
Copy-Item "config.json.bak-<时间戳>" config.json -Force
```

回滚后同样靠 `fs.watch` 自动热加载（约 1 秒），不需要重启；启动告警会在下次重启后重新出现 —— 这正是「条目回来了」的判据。

## 8. 一行结论

删 `config.json` 里 `dsh.modelFallbacks` 的第 4 项（4 行），数组 5 → 4、末位兜底与其余顺序不变，热加载约 1 秒生效、无需重启；只读验证看 §6.3 的 `[配置] 热加载（watch）：生效 1 项（dsh）` 与 §6.4 的 `/api/model`，回滚按 §7 加回 4 行或还原备份。
