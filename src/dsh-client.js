// Node 环境的 DSH Web API 客户端。
// 兼容 DSH 0.1.2-alpha.1 引入、并在 0.1.5-rc.1 上复核通过的协议：
// 1. RPC 方法从点号改为斜杠（host.describe -> host/describe 等）；
// 2. payload 包装为 { args: { <参数名>: 原payload } }（session/list 用 _request，其余多为 request）；
// 3. 新增浏览器会话鉴权：先用 dsh.authToken（进程启动 token）换取 Cookie，再带 Cookie 访问 API/WS；
// 4. 事件流不再是 events.mux 下行，而是 /api/remote.mux 上按 session/follow 打开的流，
//    Remote Event（提问/审批）走同一条 mux 上的 $events 逻辑流 + $events/result 回执。
// 复核记录（DSH 0.1.5-rc.1，逐项实测）：session/{list,create,prompt,selectModel,rename},
// workspace/{create,rename,archiveSession}, settings/describe, agentPresets/list 的参数形状与
// 返回结构均与本文件一致；session/prompt 在新版强制要求 requestId（wrapArgs 已自动补）。
//
// D58 起这个文件只是**桶**：实现按职责拆到 4 个模块，导出面与行为跟拆分前完全一致。
// 这里用显式再导出而不是 `export *`，就是为了让公开面一个不多、一个不少
// （transport 里的 endpointOf/wrapArgs/waitWithSignal 是模块间内部依赖，不进公开面）。
//   · dsh-client-discovery.js  发现层：DSH home / 启动 token / 浏览器 Cookie 铸造
//   · dsh-client-transport.js  传输层：RPC 方法名与参数形状适配（点号→斜杠、{args}、可取消等待）
//   · dsh-client-session.js    会话层：NodeApiClient（HTTP RPC + remote.mux 流）与收件箱投影
//   · dsh-client-turn.js       回合收集：unwrap / createTurnCollector / blocksToText

export {
  resolveDshHome,
  discoverDshLaunchToken,
  MINTED_COOKIE_LIFETIME_MS,
  readBrowserSessionSecret,
  mintBrowserSessionCookie,
  discoverDshSessionCookie,
  isLoopbackBase
} from './dsh-client-discovery.js';

export {
  FOLLOW_SNAPSHOT_MESSAGES,
  inboxItemsOfProjections,
  inboxItemIds,
  controlBaselineInboxItems,
  NodeApiClient
} from './dsh-client-session.js';

export { unwrap, createTurnCollector, blocksToText } from './dsh-client-turn.js';
