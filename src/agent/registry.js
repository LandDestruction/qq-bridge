// Agent transport 注册表（P0）：只存「type → 工厂」，不实现任何具体 transport。
//
// 为什么单独一个文件：桥接装配处（bridge.js）只该知道「按 cfg.agent.type 找工厂」，
// 不该 switch 到具体模块；P1 接 openai/http 时只在这里 register，不用改 mux。
// 零 import，registry 本身不依赖 contract（工厂自己去声明能力）。

const AGENT_FACTORIES = new Map();

/**
 * 注册一个 transport 工厂。
 * @param {string} type
 * @param {(deps:object)=>object} factory 返回形状与 contract 一致的对象
 */
export function registerAgentTransport(type, factory) {
  const name = String(type ?? '').trim().toLowerCase();
  if (!name) throw new Error('registerAgentTransport：type 不能为空');
  if (typeof factory !== 'function') throw new Error(`registerAgentTransport(${name})：factory 必须是函数`);
  AGENT_FACTORIES.set(name, factory);
  return factory;
}

/** 按类型取工厂；未注册返回 null（调用方决定回退策略）。 */
export function getAgentTransportFactory(type) {
  const name = String(type ?? 'dsh').trim().toLowerCase();
  return AGENT_FACTORIES.get(name) ?? null;
}

/** 已注册的类型清单（排好序，便于日志/测试断言）。 */
export function listAgentTransportTypes() {
  return [...AGENT_FACTORIES.keys()].sort();
}

/** 仅测试/热重载用：清空注册表。 */
export function resetAgentTransports() {
  AGENT_FACTORIES.clear();
}
