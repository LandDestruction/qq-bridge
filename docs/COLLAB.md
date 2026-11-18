# 多窗口协作约定（COLLAB）

> 目标是 2 个施工窗口 + 1 个审阅窗口同时推进，且不互相覆盖、不让线上实例处于两套状态。
> 每次协作方式变更请改本文件并提交，别靠口头约定。

## 0. 当前布局

| 位置 | 分支 | 用途 |
|---|---|---|
| `<本机路径>\Documents\deepseek-harness\qq-bridge-src` | `main` | **线上实例唯一运行目录**，也是审阅窗口的工作区 |
| `...\deepseek-harness\wt-backend` | `feat/backend` | 施工 A |
| `...\deepseek-harness\wt-frontend` | `feat/frontend` | 施工 B |

- 工作树的 `node_modules` 是指向主目录的目录联结（junction），不需要各自 `npm install`
- 工作树里**没有** `state/`（被 gitignore），只有一份 `config.json` 快照副本（改了不生效）
- 基线提交：`2f73264`；`.gitattributes` 设了 `* -text` + `core.autocrlf=false`，**不要改回去**（本项目 `start.bat` 是 LF 行尾）

## 1. 角色与文件归属

划分原则：**同一个文件在一个时间点只能有一个窗口改**。`src/bridge.js` 是 14000+ 行单体，冲突代价最高，必须独占。

| 角色 | 独占范围 | 可以碰 |
|---|---|---|
| 施工 A（后端） | `src/**`（尤其 `src/bridge.js`、`src/slang-learner.js`） | 只读其它目录 |
| 施工 B（前端/脚本/文档） | `public/**`、`scripts/**`、`docs/**` | 只读 `src/` |
| 审阅（发布） | 主目录、`config.json`、`state/`、重启 | 全部（只读+发布） |

跨范围改动（比如一个功能同时要改 `bridge.js` 和 `public/client.html` / `public/client.js`）：
**拆成两个提交、两人分别做**，接口先约定好字段名，不要抢同一份文件。

## 2. 分支与合并

- 施工只在自己的分支提交，**绝不直接 commit 到 `main`**
- 合并由审阅执行：`git merge --no-ff feat/backend`，冲突也由审阅解
- 施工不要 rebase 别人的分支，也不要 `git push --force` 任何东西（没有远端，但同样适用）
- 提交信息格式：`<模块>: <做了什么>（验证：<怎么验的>）`
  例：`slang: 写回时按 slangContentKey 匹配（验证：node --check + 2 条真实研究）`

## 3. 运行期状态铁律（这条是血泪）

`config.json` 和 `state/*.json` 被桥接**常驻在内存**里，直接改文件会被下一次保存覆盖回去。只允许两种改法：

1. 走控制台 API（`POST /api/slang/config` 这类），或
2. 改完**立刻**重启桥接，让新进程从磁盘重载

工作树里的 `config.json` 只是快照，改了既不影响线上也不影响主目录，别在那里试验配置。

## 4. 验证分级

| 级别 | 内容 | 谁做 |
|---|---|---|
| L1 | `node --check <改动的 js>`；改 `.bat` 就用假文件实测 | 施工（必做） |
| L2 | `node scripts/test-<相关模块>.mjs` | 施工（必做） |
| L3 | `node src/self-test.js http://127.0.0.1:12175` | 仅审阅（会真建会话、花一次模型钱） |
| L4 | 重启后看 `state/bridge.log`；控制台手点一遍 | 仅审阅 |

**注意**：`npm run self-test` 用内置默认 `http://127.0.0.1:3080`，那个端口没人监听，永远 `fetch failed`。
真实用法是把 DSH 端点当第一个参数传进去：`node src/self-test.js http://127.0.0.1:12175`。

## 5. 重启权

- **只有审阅窗口**能重启：`restart.bat` 或 `POST /api/restart`
- 施工窗口不许调 `/api/restart`——会让审阅正在做的验证失效
- 重启前后记录：`state/bridge.lock` 的 PID + `state/bridge.log` 末尾 5 行
- 桥接只能有一份：第二份会抢 3001/3100 端口、`state/bridge.lock`，并**导致群消息重复回复**

## 6. 交接格式

每次交付贴这一段，缺字段视为未完成：

```
分支: feat/xxx
改动文件: （逐个列）
为什么: （一句话说清要解决的现象）
怎么验的: L1/L2 的具体命令与结果
需要审阅注意: （风险点、影响面、要不要重启才生效）
已知风险 / 回滚方式:
```

## 7. 已知坑

- `start.bat` 是 LF 行尾，`.gitattributes` 已锁死不做 CRLF 转换
- 守护窗口跑在另一个会话里，沙箱内既看不到也杀不掉；重启只能靠 `restart.bat` 或 `/api/restart`
- `~/.dsh/profiles/desktop/cordis.patch.yml` 是**所有 DSH 窗口共享**的，改它要写进交接，否则别的窗口会「不认识」某个 provider
- 手工 `.bak` 备份可以退休了，用 `git stash` / 分支代替；但**被 gitignore 的 `config.json`/`state/` 仍需手工备份**
- 工作树里没有 `state/`，所以施工做不了 L3/L4，这是设计如此，不要试图在施工树里起一个桥接
- **换模型池要同步三处**，少一处就会出现「配置看着对、机器人就是不说话」：
  1. DSH provider 注册表：`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `llm-pi-ai` 段（**所有窗口共享**）
  2. `config.json` 的 `dsh.model` 与 `dsh.modelFallbacks`
  3. `src/model-prices.js` 的价格表（模型 id 必须能查到价，否则用量账本只能按兜底价估算）

  **事故记录（2026-10-25）**：provider 注册表把 `cn:deepseek-v4.1-flash` 改成 `deepseek-v4.1-flash` 后，
  `selectModel` 每次失败只记两行日志就放弃，机器人对群里完全哑掉——配置里写的还是带 `cn:` 前缀的旧 id。
  代码侧已根治（`src/model-fallback.js`：`ensureChatModel` 识别 model-unavailable / no configured model
  类错误后探测一次 `session.modelCatalog` 挑可用模型重试，成功即写 `activeModelOverride`；启动时拿模型目录
  校验 `dsh.model` / `modelFallbacks`，对不上就醒目告警并**只在内存里**回退到可用项，不动 `config.json`；
  `ratesAt` 查表前归一化 `cn:/global:/intl:/us:/sg:/jp:/hk:` 前缀）。
  但**换池子的流程仍然要三处同步**——回退是兜底，不是正确配置的替代品。

## 8. 角色登记（2026-10-25 起）

| 角色 | 承担者 | 工作目录 / 分支 |
|---|---|---|
| 审阅 / 发布 | 主窗口（本会话） | `qq-bridge-src` / `main` |
| 施工 A | 承担「修复 DSH 端点测试用例」的窗口 | `wt-backend` / `feat/backend` |
| 施工 B | 子代理（由审阅窗口创建并跟踪） | `wt-frontend` / `feat/frontend` |

**例外条款（仅施工 A）**：A 的任务本体就是 `src/self-test.js`，所以允许它自己对
`node src/self-test.js http://127.0.0.1:12175` 做 L3 验证。除此之外 A 仍然：
不得调 `/api/restart`、不得改 `config.json` / `state/**`、不得合并进 `main`。

**例外撤销条件**：A 的任务合并进 `main` 后，此条款立即失效。
