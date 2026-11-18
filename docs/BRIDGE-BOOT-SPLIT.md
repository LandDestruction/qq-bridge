# D62：main() 装配根拆分（src/bridge/boot/）

2026-10-27。`src/bridge.js` 的 `main()` 原来是一个 **3333 行**的装配根（D55 模块化之后剩下的部分）。
本轮把它按启动阶段拆到 `src/bridge/boot/`，入口只保留**装配顺序**、共享状态表（`runtimeBindings`）、
QQ 客户端/事件接线和进程退出处理。

## 结果

| 项 | 拆分前 | 拆分后 |
|---|---|---|
| `src/bridge.js` | 4185 行 | **2225 行** |
| `main()` | 3333 行 | **1363 行** |
| `src/bridge/boot/` | 不存在 | 6 个文件 / 10 个阶段函数 |

各阶段函数都 ≤300 行、文件 ≤800 行（`node scripts/test-code-size.mjs` 5/5）。

## 映射：main() 里哪段 → 哪个文件

| 原 main() 行段（拆分前） | 目标文件 | 阶段函数 | 内容 |
|---|---|---|---|
| 1673–1773 | `boot/config-state.js`（135 行） | `bootConfigState` | 配置装载、`state/` 目录与 ACL、单实例锁、会话状态、黑话库/表情库内存态、归档/消息库句柄 |
| 1774–2032 | `boot/media-voice.js`（275 行） | `bootMediaVoice`（async） | 归档读接口的 HTTP 兜底、语音发送、QQ AI 语音（TTS）与本地 TTS 状态、DSH baseUrl 探测（此处有唯一一个顶层 `await`） |
| 2033–2272 | `boot/runtime-state.js`（292 行） | `bootRuntimeState` | 启动时模型配置校验、常驻 STT 服务与视频补发、视觉清单、好感度 IO、视频帧清理、媒体并发闸门、回合/等待记账 Map |
| 2273–2488 | `boot/usage-health.js` | `bootUsageLedger` | 令牌账本、DSH 就绪标志、模式/预设、prompt 队列（`flushQueue` 等） |
| 2489–2620 | `boot/usage-health.js`（合计 388 行，2 个函数） | `bootUpstreamHealth` | `checkDsh`、SnowLuma 上游健康视图 |
| 2621–2868 | `boot/console-send.js` | `bootConsoleAndSend` | 控制台服务入口、发送链/分条发送、媒体上限与归一化、本地兜底通道 |
| 2869–3072 | `boot/console-send.js`（合计 511 行，2 个函数） | `bootModelSession` | 模型选择/回退、会话 workspace 守卫、仿真社交引擎、二代（reserved2）唤醒状态、会话初始提示词 |
| 3073–3310 | `boot/wake-social.js` | `bootSocialWake` | prompt 投递/社交调度、角色提示词、跨群认人（人物档案）、唤醒调度与拍一拍 |
| 3311–3466 | `boot/wake-social.js` | `bootTimeSense` | 时间观念（沉睡后醒来）、prompt 分段快照 |
| 3467–3676 | `boot/wake-social.js`（合计 686 行，3 个函数） | `bootPeakArchive` | 高峰期暂停/本地接管、群管理指令、文件转存、配置热加载、BOOTH、观察学习 |

**仍留在 `src/bridge.js` 的部分**（有意为之）：

- `runtimeBindings`（约 828 行）：各业务模块与装配阶段之间的**实时共享状态表**（getter/setter）。
  把它留在入口，是因为它是「谁拥有哪份状态」的唯一权威，搬走会让 600 多个绑定名失去解析点。
- 69 个 `const { … } = createX(runtimeBindings)` 工厂接线。
- QQ 客户端创建 + 全部事件接线（`onPrivateMessage` / `onGroupMessage` / `onNotice` / `onRequest` /
  `open`/`close`/`error` / `connect`）与启动收尾（boot-log、watchers、console、归档清理、`pumpMux`）。
- 进程级退出处理（SIGINT/SIGTERM/uncaughtException/exit）。

## 机制：阶段之间怎么共享状态

```js
const boot = Object.create(runtimeBindings);          // 先继承实时绑定表
for (const [name, value] of Object.entries({ … }))    // 工厂/import 级符号直接挂值
  Object.defineProperty(boot, name, { value, writable: true, configurable: true, enumerable: true });
const attach = (stage) => Object.defineProperties(boot, Object.getOwnPropertyDescriptors(stage));

const stConfig = bootConfigState(boot);
attach(stConfig);
const stMediaVoice = await bootMediaVoice(boot);      // 阶段 2 有顶层 await，保持原来的 await 点
attach(stMediaVoice);
…
```

- 每个阶段函数开头用 `const { … } = deps;` 取它需要的绑定，返回对象里**全部是 getter/setter**
  （`let` 状态给 get+set，`const` 只给 get），所以阶段内部对自己的状态是普通变量（逐字搬运不改写），
  外部（业务模块 / 后续阶段）通过 `boot.X` 读写同一个值。
- `runtimeBindings` 里被移走的绑定名改指到对应阶段对象（如 `get cfg() { return stConfig.cfg; }`），
  所以 `deps.cfg` 等业务侧调用点**一行都不用改**，配置热更新（原地 `Object.assign`）依然实时可见。
- 少数名字是**跨阶段前向引用**（`socialV2` 在阶段 7 才创建，但阶段 2/5/6 的闭包里会用到），
  这类在模块里写成 `deps.socialV2`（访问时才解引用），不能放进开头的解构。
- `botSelfIdCache` / `botNicknameCache` 例外：`warmSelfIdentity()` 在阶段 1 就会读它们，
  所以留在入口模块的 `var`（原代码就是 `var`，靠提升避免 TDZ），没有下沉。

## 验证

| 检查 | 结果 |
|---|---|
| `node --check`（入口 + 6 个 boot 文件 + 改过的脚本） | 通过 |
| `npm run test:refactor` | 5/5 |
| `node scripts/regression-all.mjs` | **78/81**，失败的 3 套是已知的「工作树缺 config.json」假红（`test-simple-booth-dir` / `test-v2-wait` / `test-vision-media`），与拆分前基线一致 |
| `node scripts/test-code-size.mjs` | 5/5（文件 ≤800、函数 ≤300、无新增超标） |
| 逐行保留核对 | 每个原行段与目标模块逐行比对：除 `deps.socialV2` / `deps.modelSelectionEpoch` / `deps.lastSendFailed` 三个前向引用、`import('./tts.js')` → `import('../tts.js')`、以及两个留在入口的 `var` 外，**无其它差异**（含日志文案逐字一致） |

> 未完成真机验证：`src/` 改动需要重启桥接才生效。重启后按 `docs/restart-acceptance.md` §三-11 冒烟。

## 测试支撑改动

- `scripts/bridge-source.mjs`：新增 `bridgeBootFiles()` / `installBootModules(context)`；
  `readBridgeSource()` 现在把 boot 文件按同一套 `// @bridge-function` 标记展开后附在入口源码后面，
  所以静态守卫（46 个直接读源码的脚本）不需要逐个改。
- `scripts/audit-bridge-harness.mjs`：注入 boot 阶段函数（VM 会剥掉 import）；
  提前 return 的全局对象改为从 `boot` 取被搬走的状态；补了 `discoverDshBaseUrl` 桩
  （它原本只在 try/catch 里被调用；阶段 prologue 解构时才会暴露 VM 缺这个导入）。

## 回退

```powershell
git revert <本提交>      # 或 git checkout HEAD~1 -- src/bridge.js scripts/bridge-source.mjs scripts/audit-bridge-harness.mjs
```
回退后 `src/bridge/boot/` 变成未被引用的文件，不影响运行；需要重启一次桥接。
