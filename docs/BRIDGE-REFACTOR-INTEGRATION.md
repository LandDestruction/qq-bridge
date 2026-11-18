# bridge.js 模块化拆分：本地合入记录（gen5，2026-10-27 16:20）

> 来源：朋友交付的 `qq-bridge-modular-refactor-20261027.zip`（sha256 `1F5CCCEB…E02B7D`），
> 基于 `qq-bot-system-20261027-1359.zip`（sha256 `39ba56f2…`）拆分。
> 合入提交：`7b59aa0`（分支 `refactor/modular`）+ `08ff036`（合入 main）。

## 一、结论

- 入口 `src/bridge.js` 从 **18,922 行 → 4,185 行**，新增 `src/bridge/` 下 **77 个模块**（另含 `manifest.json`），共 447 个函数（426 个原函数 + 21 个控制台处理函数）。
- 本机验证全绿：`node --check` 81 文件 0 失败、`test:refactor` 5/5、**全量回归 80/80**（工作树与 main 各跑一遍）、路由字面量 **152/152** 一致、声明函数名 **428/428** 一致。
- 已重启生效：pid **115036**（16:17:50 启动），SnowLuma/DSH 均连上，`/api/status` 正常，启动后无错误日志。

## 二、与交付包的两处差异（必须知道）

交付包基于 **13:59** 的快照，不含当天 15:24 合入的 **D53（视频/语音识别质量）**。直接覆盖会把 D53 退回，所以做了两处补齐：

1. **D53 的 bridge 侧改动移植到 `src/bridge/incoming-media.js`**
   - `lowConfidence/lowReason` + `stt.lowConfidence` 分支：低置信只写 `【视频声音】听不清（原因）`，不把乱码喂给模型；
   - 画面/声音分两行（`[视频 …｜画面：…]` 换行 `【视频声音】…`）；
   - 回填 `media.sttLowConfidence` / `media.sttText`。
   - 其余 D53 文件（`src/stt-quality.js`、`stt-service.js`、`video-analyze.js`、`tools/stt_*.py`）交付包未包含，保持原样。
2. **新增的 `test-stt-quality.mjs` 改为 `readBridgeSource()`**
   - 原测试直接读 `src/bridge.js` 找 `【视频声音】`，拆分后该函数在模块里；改用 `scripts/bridge-source.mjs` 的源码视图后 22/22 通过。
   - `test-media-queue.mjs`（`slice +20000`）与 `test-stt-wiring.mjs`（`【视频声音】` 断言）保留 D53 口径，已同步。

## 三、脚本/测试适配

- 新增 `scripts/bridge-source.mjs`（按 `src/bridge/manifest.json` 与 `// @bridge-function` 标记重建"整源视图"）+ `scripts/test-bridge-modules.mjs`（模块边界 5 项）。
- 交付包带了 **28 个改过的测试脚本**（把直接读 `src/bridge.js` 改成 `readBridgeSource()`）。这些脚本的内容与我们 main 一致，只有两处差别：读源方式、以及隐私闸留下的假群号（形如 `<群号>` 的占位数字）。合入时按交付包版本覆盖，再把 D53 的两处断言补回。
- `package.json` 只加了一行：`"test:refactor": "node --test scripts/test-bridge-modules.mjs"`。

## 四、验证证据

| 检查 | 结果 |
|---|---|
| `node --check` 全部 src | 81 文件 0 失败 |
| `npm run test:refactor` | 5/5（模块 ESM 导入/配置替换可见/发送队列共享/静态守卫/中央鉴权 404） |
| `regression-all.mjs`（worktree） | **80/80**（跳过 test-dsh-session-retire：需活 DSH socket） |
| `regression-all.mjs`（main 合并后） | **80/80**，同上跳过 |
| 路由字面量（旧 152 条） | 新代码 152/152 全在，无新增无丢失 |
| 顶层/声明函数名（旧 428 个） | 新代码 428/428 全在 |
| 重启冒烟 | pid 115036，`dshReady=true`、`snowluma=true`、`paused=false`；`/api/status /api/models /api/affinity /api/voice/list /api/stickers /api/config/reload` 全 200；启动后 40 行日志无错误；上线提醒成功发出（出站链路通） |

## 五、回退

```powershell
cd <本机路径>\deepseek-harness\qq-bridge-src
git reset --hard 167f1a6      # 模块化之前（含 D53）
# 然后重启桥接：POST /api/restart（带 x-console-token）
```

分支 `refactor/modular` 仍保留；工作树 `<本机路径>\w9-refactor` 可用来复跑。

## 六、已知未做 / 风险

- **真实机器长时间运行**只观察了启动与出站；入站→回复的完整回合需要群里来一条消息确认（重启后还没等到）。
- `test-dsh-session-retire.mjs` 仍被跳过（需活 DSH 控制 socket），与本次改动无关。
- 控制台页面手工点检未做（接口层已逐个 200）。
- 朋友交付包自述的"原有失败"（敏感信息断言、预设 CRLF、STT 工具缺失等）保持原样，本次不夹带修复。
- 交付包的脚本用假群号（隐私闸产物）；不影响断言，但做真机探针时不要拿这些脚本当数据源。
