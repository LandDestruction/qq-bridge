// 绑定表：把「一件素材（contentKey）」钉到「一个 BOOTH 商品号」。
//
// 为什么要有它：自动认号（文件名/说明里的链接/包内 readme）总有认不出的，
// 而 `contentKey`（首个压缩包名小写 + 大小）在文件不改的情况下是稳定的；
// 用它当键存一份人工确认过的映射，下次扫描直接覆盖自动识别的结果。
//
// 存 `state/booth-binds.json`。纯函数放这里，桥接那边只做读写盘与路由。

export const BIND_RULES_VERSION = 1;

/** 合法 BOOTH 号：5~9 位纯数字（与 booth-meta 的 parseBoothName 一节一致）。 */
export function isBoothId(value) {
  return /^\d{5,9}$/.test(String(value ?? '').trim());
}

/** 规范化整张表：坏值丢、版本号补齐、键与号都转字符串。 */
export function normalizeBindTable(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const entries = {};
  const from = src.entries && typeof src.entries === 'object' && !Array.isArray(src.entries) ? src.entries : {};
  for (const [key, value] of Object.entries(from)) {
    const contentKey = String(key ?? '').trim();
    if (!contentKey) continue;
    const boothId = String(value?.boothId ?? '').trim();
    if (!isBoothId(boothId)) continue;
    entries[contentKey] = {
      boothId,
      title: String(value?.title ?? '').slice(0, 200),
      source: String(value?.source ?? 'manual').slice(0, 40) || 'manual',
      at: Number.isFinite(Number(value?.at)) ? Number(value.at) : 0
    };
  }
  return { version: BIND_RULES_VERSION, entries };
}

export function bindOf(table, contentKey) {
  const entries = table && table.entries && typeof table.entries === 'object' ? table.entries : {};
  return entries[String(contentKey ?? '')] || null;
}

/** 写一条绑定（同一 contentKey 覆盖旧值）。返回新表，不改入参。 */
export function setBind(table, contentKey, boothId, { title = '', source = 'manual', now = Date.now() } = {}) {
  const base = normalizeBindTable(table);
  const key = String(contentKey ?? '').trim();
  if (!key) throw new Error('contentKey 不能为空');
  if (!isBoothId(boothId)) throw new Error('BOOTH 号必须是 5~9 位数字');
  base.entries[key] = { boothId: String(boothId).trim(), title: String(title ?? '').slice(0, 200), source: String(source || 'manual').slice(0, 40), at: Number(now) || Date.now() };
  return base;
}

export function removeBind(table, contentKey) {
  const base = normalizeBindTable(table);
  delete base.entries[String(contentKey ?? '').trim()];
  return base;
}

export function bindCount(table) {
  return Object.keys(normalizeBindTable(table).entries).length;
}

/**
 * 把绑定表覆盖到素材卡上。
 * - 有绑定：boothId 用绑定的，`boothSource` 记成 'bind'（前端可以据此显示「手动绑定」）。
 * - 没绑定：原样返回（自动识别结果不动）。
 * 返回新数组，不改入参。
 */
export function applyBinds(cards, table) {
  const list = Array.isArray(cards) ? cards : [];
  const t = normalizeBindTable(table);
  return list.map((card) => {
    const bind = t.entries[String(card?.key ?? '')];
    if (!bind) return card;
    return {
      ...card,
      boothId: bind.boothId,
      boothSource: 'bind',
      boundTitle: bind.title || '',
      boundAt: bind.at || 0,
      // 原来自动识别出来的号留一份，绑错/解绑时能回去
      autoBoothId: card.boothId || ''
    };
  });
}

/** 给前端看的摘要（详情弹层里显示「绑了 N 件」）。 */
export function bindTableSummary(table) {
  const t = normalizeBindTable(table);
  const ids = Object.values(t.entries).map((e) => e.boothId);
  const unique = new Set(ids);
  return { version: t.version, count: ids.length, uniqueIds: unique.size, manualAt: Object.values(t.entries).reduce((max, e) => Math.max(max, e.at || 0), 0) };
}
