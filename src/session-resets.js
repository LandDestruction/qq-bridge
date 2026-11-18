// 「距上次重建会话」记帐（socialV2.sessionResets）的存取。
//
// 为什么单独抽出来：这份记帐是 sessionRecycle（200 条 / 8h）与 D45 上下文预算的
// turns 兜底的共同依据 —— 「这个会话上次重建之后又进了多少条消息」。
// 但它**从来没被落盘**：saveSocialV2State 是白名单式序列化（只挑字段写），
// 漏了这个字段；loadSocialV2State 也不读。结果是每次 bridge 重启后所有会话的计数
// 归零，sessionRecycle 的阈值实际按「本次进程启动以来」算，而不是「上次重建以来」。
// 这和 D19 的 lastMediaAt、T12 的 digests 是同一类坑（默认对象 / load / save 三处要一起补），
// 所以这里把「读」和「写」以及脏数据清洗都收在一个纯函数模块里，bridge 两行接线，单测直接打纯函数。
//
// 线上文件里可能出现的形状（都是真实见过的）：
//   - 没有该字段（旧文件）        → {}
//   - 字段是 null / 数组 / 字符串 → {}
//   - 条目缺 at 或 at 不是数字     → 丢掉该条目（没有 at 就没法判断「多少条之后」，留着会误判）
//   - count 不是数字              → 归 0
//   - reason 不是字符串           → 'unknown'
//   - 条目过多（老会话早已退役）   → 只保留 at 最新的 MAX_ENTRIES 个

export const MAX_ENTRIES = 500;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 把任意输入清洗成 `{ [key]: { at, count, reason } }`。
 * 永远返回普通对象（不用 Object.create(null)：要能 JSON.stringify 直出）。
 */
export function normalizeSessionResets(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  const entries = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isObj(value)) continue;
    const at = Number(value.at);
    if (!Number.isFinite(at) || at <= 0) continue; // 没有 at 就没法算「之后」，留着只会误判
    const count = Number(value.count);
    entries.push([
      String(key),
      {
        at: Math.round(at),
        count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
        reason: typeof value.reason === 'string' && value.reason ? value.reason.slice(0, 24) : 'unknown'
      }
    ]);
  }
  entries.sort((a, b) => b[1].at - a[1].at); // at 最新的优先留下
  for (const [key, value] of entries.slice(0, MAX_ENTRIES)) out[key] = value;
  return out;
}

/** 落盘用：与 normalize 同形，但保证过期条目也被裁掉，不把内存里的临时形状带进文件。 */
export function packSessionResets(input) {
  return normalizeSessionResets(input);
}

/** 读盘用：旧文件没有该字段是正常的，返回空对象让调用方按「从没重建过」处理。 */
export function unpackSessionResets(raw) {
  return normalizeSessionResets(raw);
}
