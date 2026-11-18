// 唤醒判定的纯逻辑：self_id 缺失时的兜底。
// 事故：SnowLuma 部分事件不带 self_id → `at` 段与 '' 比较永不相等 → @ 机器人不唤醒，
// 消息进了库但没有任何「计划唤醒」日志。这里把所有「谁是机器人」的判定集中到一处。
export function resolveSelfIds({ eventSelfId = '', cachedId = '', fallbackId = '' } = {}) {
  const ids = [eventSelfId, cachedId, fallbackId]
    .map((v) => String(v ?? '').replace(/\D/g, ''))
    .filter(Boolean);
  return { ids: [...new Set(ids)], primary: ids[0] || '' };
}

/** @ 段是否指自己：任一候选 id 命中即可。 */
export function matchAtMention(message, { eventSelfId = '', cachedId = '', fallbackId = '' } = {}) {
  const { ids } = resolveSelfIds({ eventSelfId, cachedId, fallbackId });
  if (!ids.length || !Array.isArray(message)) return false;
  const set = new Set(ids);
  return message.some((seg) => seg?.type === 'at' && set.has(String(seg?.data?.qq ?? '').replace(/\D/g, '')));
}

/** 名字是否命自己：昵称多候选（配置名 / 网关昵称），大小写不敏感。 */
export function matchNameMention(text, names = []) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower) return false;
  return (Array.isArray(names) ? names : []).map((n) => String(n ?? '').trim().toLowerCase()).filter(Boolean)
    .some((n) => lower.includes(n));
}
