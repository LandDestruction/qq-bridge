# 交接：config.json 的写入者清单与写保护（2026-10-26 17:51 事故）

## 结论（先看这里）

- **17:51 的真凶是桥接自己的 `POST /api/model-routing`**，不是脚本/测试：
  `logs/bridge-stdout.log` 在 17:51:09 有
  `[配置] 热加载（model-routing）：磁盘内容无变化` +
  `[模型] 路由已更新：idle=- peak=- fallback=0 disabled=0`，
  同时 `config.json` mtime 正是 17:51:09。这是**唯一**会打印「路由已更新」的代码路径。
- 触发形态：运维面板 `public/ops.html` 的「保存」是**整份快照**提交
  `{idle, peak, fallback[], disabled[], peakPauseEnabled}`。页面在 17:35/17:37 路由被清空时加载（或加载后
  17:40 又用 curl 写入了值），17:51 在**旧页面**点保存 → 把内存里的空 draft 整份写回，路由被清空。
  17:05 与 17:37 也有同样的空写记录（见日志同一条目）。
- 次生风险：旧的 `/api/model`、`/api/model-routing` 落盘用的是**启动时的整份 cfg 快照**
  （`atomicWriteJson(config.json, cfg)`），任何并发写入（比如同时改 allow）都会被这次保存覆盖。
- 脚本/测试**没有**写真实 config：所有测试都用临时目录；`probe-vision.mjs`/迁移脚本只读；
  `bootstrap.ps1` 只在 config 不存在时从 example 复制。仓库内唯一写真实 config 的是桥接 API。

## 一、写入者清单

### 桥接进程内（`src/bridge.js`）

| 位置 | 写什么 | 方式 |
|---|---|---|
| `POST /api/model-routing` | `socialV2.modelRouting`、`peakPause.enabled` | **已改为 `updateConfigFile`（读盘再合并）** |
| `POST /api/model`（persist） | `dsh` / `socialV2.modelByKind.*` / `modelForMedia` / `peakPause.agent` | **已改为 `updateConfigFile`** |
| `DELETE /api/model` | 删除对应 scope 节点 | **已改为 `updateConfigFile`** |
| `POST /api/peak/toggle` | `socialV2.peakPause.enabled` | **已改为 `updateConfigFile`（原子写）** |
| 控制台配置保存类接口（`/api/settings`、`/api/config`、`/api/socialV2/*` 等） | 各自片段 | 原本就 `readConfigObject(configFile)` 后 `atomicWriteJson`（读的是磁盘最新，不是内存快照） |
| 设置页轮询补写（`maybePersistOwnerQQ` 等） | 单字段 | 同上（读盘后写） |

> 桥接里仍有大量 `atomicWriteJson(path.join(ROOT, 'config.json'), cfg)` 之外的写法是**读盘再写**的，
> 本次只修了 4 个使用内存整份快照的站点；`git grep "atomicWriteJson(path.join(ROOT, 'config.json'), cfg)"` 现在应为 0。

### 脚本（`scripts/*.mjs`）

| 脚本 | 行为 |
|---|---|
| `audit-bridge-harness.mjs`、所有 `test-*.mjs` | 只写 `os.tmpdir()` 下的临时 config（本次复核无例外） |
| `probe-vision.mjs` | **只读**真实 config，结果打印/另存，不写 config |
| `migrate-*.mjs`、`setup-doctor.mjs` | 只读 |
| `bootstrap.ps1` | 仅当 `config.json` 不存在时从 `config.example.json` 复制 |

本次新增 `scripts/config-write-guard.mjs`：以后脚本要写真实 config，必须先调用
`assertSafeConfigWrite(path)`；没有 `QQ_BRIDGE_ALLOW_CONFIG_WRITE=1` 会直接抛错。

### 外部

- DSH 控制台/设置页通过桥接 API 写；任何直接编辑 config.json 的人为操作不在代码控制范围。

## 二、保护机制

1. **读盘再合并**（`src/config-write.js` 的 `updateConfigFile`）：
   ```js
   updateConfigFile(configFile, (disk) => { disk.socialV2.modelRouting = next; }, { atomicWrite: atomicWriteJson });
   ```
   每次写之前重新读磁盘最新内容，只改本次涉及的字段，再原子写（tmp + rename）。
   并发写入者 A（routing）与 B（allow）交替执行，两份修改都会保留（有回归测试）。
2. **脚本写保护**：`assertScriptConfigWriteAllowed()`（`src/config-write.js`）+
   `scripts/config-write-guard.mjs` 包装；真实 `config.json` 默认拒绝，临时路径不受限。
3. **前端配套建议（给 B）**：面板保存不要整份提交；至少做到「只提交用户改过的字段」，
   或保存前重新 `GET /api/model-routing` 合并。当前服务端语义里显式 `null/[]` 是合法的「清空」，
   所以**旧页面 + 整份空 draft** 仍可能主动清空路由——服务端无法区分「用户想清空」与「页面过期」。
   彻底方案（可选，下一批）：给 GET 增加 `routingUpdatedAt`/hash，POST 带 `ifUnmodifiedSince`，不匹配返回 409。

## 三、怎么避免再犯

- 任何写 config 的代码：**禁止**把启动时读到的整份 `cfg` 直接写盘；统一走 `updateConfigFile`。
- 新增脚本要写 config：先 `assertSafeConfigWrite()`；测试只准写 tmp。
- 排查写入者：`git grep -n "atomicWriteJson(path.join(ROOT, 'config.json')" src`（应为 0）+
  看 `logs/bridge-stdout.log` 的 `[模型] 路由已更新` / `[峰值]` / `控制台：` 日志。
- 面板类保存：优先「只发变更字段」；如果要做整份保存，先 GET 最新再合并。

## 四、验证

- `scripts/test-config-write-guard.mjs`：
  - A 写 routing、B 写 allow 交替 → 两份都在；反面用旧「整份快照」写法证明会丢更新；
  - 脚本无环境变量时拒绝真实 `config.json`，`QQ_BRIDGE_ALLOW_CONFIG_WRITE=1` 才放行；
  - 静态断言桥接不再用 `cfg` 整份覆盖、4 处写操作都走 `updateConfigFile`。
- 事故日志证据：`<本机路径>\qq-bridge-src\logs\bridge-stdout.log` 第 25258–25259 行（17:51:09）。
