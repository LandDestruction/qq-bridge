// DSH transport：把现有 `dsh-client*.js` 的用法**原样包一层**（P0 零行为变化）。
//
// 只做转发与方法名映射，不改任何逻辑：
//   mux 以前直接 `deps.api.events.mux({})` / `deps.api.respond()` / `deps.createTurnCollector()`…
//   现在改成先问 `deps.agentTransport`，没有就退回旧路径（见 mux-runtime 的 agentTransportOf）。
// 所有 deps 都在**调用时**读取，不在构造期抓快照：bridge.js 里的 api 是 getter，
// 构造期读会拿到 undefined（而且 manifest 的工厂用例要求构造期不碰 deps）。
//
// 本文件零 import：既能被 bridge.js 直接 import，也能在沙箱里整份注入。

import { describeAgentTransport } from './contract.js';

/**
 * @param {object} deps 至少要有 api / createTurnCollector / discoverDshBaseUrl / log
 */
export function createDshTransport(deps) {
  const need = (name) => {
    const value = deps?.[name];
    if (!value) throw new Error(`dsh transport 缺少依赖：${name}`);
    return value;
  };
  const api = () => need('api');
  return {
    type: 'dsh',
    name: 'dsh',
    capabilities: describeAgentTransport('dsh'),
    /** 兼容老代码的直通口（P0 只为减少改动面，P2 后应逐步去掉）。 */
    get api() {
      return api();
    },
    get baseUrl() {
      return api().baseUrl;
    },
    set baseUrl(value) {
      api().baseUrl = value;
    },
    events() {
      // 与 dsh client 的 events.mux({}) 同一个异步可迭代对象，调用方直接 for await。
      return api().events.mux({});
    },
    respond(message) {
      return api().respond(message);
    },
    stopSessionWork(sessionId, options) {
      return api().stopSessionWork(sessionId, options);
    },
    createCollector() {
      return need('createTurnCollector')();
    },
    invalidateAuth() {
      return api().invalidateAuth();
    },
    discoverBaseUrl({ current, log } = {}) {
      return need('discoverDshBaseUrl')({ current: current ?? api().baseUrl, log: log ?? deps?.log });
    }
  };
}
