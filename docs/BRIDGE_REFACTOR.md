# bridge.js 模块化交付说明

基于 `qq-bot-system-20261027-1359.zip`，2026-10-27。目标是拆分职责、保留既有行为。本轮没有接入真实 QQ／DSH，没有读取原包 state 中的聊天、令牌和运行状态，也没有将朋友项目安装到 NAS。

## 使用方法

1. 停止朋友机器人的现有桥接进程，备份原项目源码。
2. 将 `qq-bridge-modular-refactor-20261027.zip` 解压到原项目根目录，覆盖包内同名源码、测试及说明文件。解压后的入口应当是原来的 `src/bridge.js`，不要多套一层目录。覆盖包不含实际 `config.json`、state、node_modules、聊天或凭据。
3. 保留原项目的配置、数据和依赖；本次没有新增运行依赖。按原方式启动，入口仍为 `node src/bridge.js`／`npm start`。
4. 本地运行 `npm run test:refactor` 检查新模块边界；原审计命令仍为 `npm run test:audit`。审计存在下述原有失败，不能把本次结果表述为全套审计通过。

单独复制新版 bridge.js 不够：它需要同时交付的整个 `src/bridge/` 目录。

## 文件职责

原入口 18,909 行，现为 4,185 行（含空行），入口减少约77.9%。提取426个原有函数，并拆出21个控制台处理函数，共分为77个模块；拆出的最大模块约640行。完整函数／依赖映射见 `src/bridge/manifest.json`。

| 文件或目录 | 职责 |
|---|---|
| `src/bridge.js` | 共享状态装配、模块接线、启动流程、事件注册和进程退出 |
| `src/bridge/config-*.js`、`state-files.js`、`process-lock.js` | 配置读写、热更新、状态保存和单实例锁 |
| `src/bridge/console-server.js` | HTTP基础处理、鉴权、管理端／智能体边界与接口分发 |
| `src/bridge/console/` | 运维、角色、预设、会话、文件库、模型、发送、图片／语音、等待、记忆等接口 |
| `outbound-text.js`、`outbound-policy.js`、`media-send.js` | 文字／媒体发送、共享队列、发送前权限复查和审计 |
| `voice.js`、`tts.js`、`stickers.js` | 语音、合成、表情库 |
| `media-input.js`、`media-resolution.js`、`incoming-media.js` | 入站媒体、图片字节、媒体选型和视频补充 |
| `session-policy.js`、`session-runtime.js`、`model-selection.js` | 会话权限、会话生命周期、模型选择与回退 |
| `wake-*.js`、`prompt-delivery.js`、`prompt-queues.js` | 唤醒、等待、提示词和投递队列 |
| `people-runtime.js`、`memory-prompt.js`、`affinity-runtime.js` | 人物、记忆提示和好感度 |
| `incoming-runtime.js`、`pending-interactions.js`、`mux-runtime.js` | QQ来信、待回答／审批和DSH事件流 |
| `file-archive-runtime.js`、`observe-runtime.js`、`session-recycle.js` | 文件转存、观察学习和上下文回收 |

表中未写目录前缀的文件均位于 `src/bridge/`。原来已存在的 `src/model-routing.js`、`src/memory-layers.js` 等模块继续保留，不在本轮重写。

## 重要边界

- 模块通过具名工厂函数接收 `deps`，没有运行期 eval、with 或全局代理。创建模块时不读取尚未初始化的绑定，也不启动服务。
- 共享状态仍由主程序拥有。`cfg`、发送队列、计数器等通过明确的 getter／setter 保持实时引用，避免拆分时把热更新后的配置或新队列变成旧快照。后续若要把状态完全迁入服务，应作为独立的设计改动验证。
- 模块之间通过主程序接线，避免业务模块互相循环 import。模块头记录其所需绑定，manifest记录职责对应的函数及依赖。
- 控制台集中鉴权仍在接口处理前执行，接口顺序保持原样；未命中的接口分组同步跳过，避免逐组 await 造成新的请求交错窗口。接口的请求级令牌保持实时读写。
- 移动后的动态 import 已按新目录修正。原存储路径仍由原 ROOT／STATE_DIR 提供，文件格式、配置键、QQ命令及DSH协议保持原样。
- 原有缺陷没有夹带修复，包括宽泛唤醒、按名字共享印象和发送失败后继续批次等；这些应另立行为变更并测试。

## 验证与限制

- 对426个原有函数和21个控制台处理函数做语法树级核对：统一依赖访问、对象简写和动态导入路径的表示后，与移动前一致；控制台接口展开后的顺序、鉴权及处理体也核对通过。
- `npm run test:refactor` 的5项测试通过：全部77个模块的实际ESM导入与延迟依赖读取、配置整体替换后可见性、两个发送模块共用同一有序队列、静态守卫跨模块查看当前实现、接口修改令牌后中央鉴权即时生效与未知路径404。
- 原离线审计35组、补充回归30组均与隔离原版对照。原先通过的组未出现新增失败。详细结果见同包 `REFACTOR-VALIDATION.json`；这些是脚本组数，不是测试用例总数。
- 原有失败涉及：敏感信息检测断言、启动脚本／示例角色或文档缺失与编码、预设预算断言不一致、预设CRLF保持、DSH安装目录依赖、SDK在Node24下的模块解析、上游健康视图断言、上下文提示措辞、缺少真实配置的转发测试、缺失STT工具等。此次不修改这些业务逻辑，也不伪造生产配置来让它们变绿。
- 未做真实QQ发送、真实账号登录、活DSH协议验收或模型调用。朋友的既有SDK补丁和运行环境仍需保留。

原测试中有一部分直接读取 bridge.js 的函数文本；这类测试改为通过 `scripts/bridge-source.mjs` 展开当前模块查看，不读取保存的旧版代码。行为测试的 harness 执行当前主文件接线和当前模块工厂，并继续使用隔离的假QQ／DSH、临时文件及定时器。普通生产入口不依赖这些测试辅助文件。

## 回退

停止桥接后，恢复备份的原 `src/bridge.js` 和本次覆盖的源码／测试即可。配置和业务数据不需要回滚。仅留存未被原入口引用的新模块不会改变原版运行行为。
