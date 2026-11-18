// 纯净模式（极致省 token）的纯规则。
//
// 为什么要有：长会话里最贵的是「记忆/黑话/表情库/交接摘要/长历史引用」这些附加段，
// 一轮能吃掉上千 token，而闲聊根本用不上。纯净模式把它们从提示词装配里摘掉，
// 只留人设、必要规则、宿主工具、绘图与发送节奏——省 token 但不改变「像个人」。

export const PURE_MODE_DROPS = Object.freeze([
  'memory',
  'slang',
  'sticker',
  'stickerStrategy',
  'handoff',
  'initialPrompt',
  'visionHint',
  'historyQuotes'
]);

export const PURE_MODE_KEEP = Object.freeze([
  'persona',
  'token',
  'hostTool',
  'draw',
  'sendRhythm'
]);

export const PURE_MODE_TURN_MAX_STEPS = 6;

const PURE_MODE_NOTE = '省掉记忆/黑话/表情/交接与长历史，只留人设+必要规则';

export function pureModePlan(cfg) {
  const enabled = cfg?.socialV2?.pureMode?.enabled === true;
  return {
    enabled,
    drop: [...PURE_MODE_DROPS],
    keep: [...PURE_MODE_KEEP],
    turnMaxSteps: PURE_MODE_TURN_MAX_STEPS,
    note: PURE_MODE_NOTE
  };
}

// 给提示词装配用：parts 形如 [{ name, chars }]，按 name 命中 drop 列表就摘掉。
// 返回新数组（每个元素也是新对象），savedChars 是摘掉部分原本的字数合计——
// 调用方拿它打日志证明「这轮真省了多少」，不必自己再算一遍。
export function applyPureMode(cfg, parts) {
  const plan = pureModePlan(cfg);
  const list = Array.isArray(parts) ? parts : [];
  if (!plan.enabled) {
    return {
      enabled: false,
      parts: list.map((part) => ({ ...part })),
      dropped: [],
      savedChars: 0,
      turnMaxSteps: plan.turnMaxSteps,
      note: plan.note
    };
  }
  const dropSet = new Set(plan.drop);
  const kept = [];
  const dropped = [];
  let savedChars = 0;
  for (const part of list) {
    const name = String(part?.name ?? '');
    if (dropSet.has(name)) {
      dropped.push(name);
      const chars = Number(part?.chars);
      if (Number.isFinite(chars) && chars > 0) savedChars += chars;
      continue;
    }
    // 不认识的 part 一律保留：宁可多花点 token，也不要因为名字没登记就把人设/规则丢了。
    kept.push({ ...part });
  }
  return {
    enabled: true,
    parts: kept,
    dropped,
    savedChars,
    turnMaxSteps: plan.turnMaxSteps,
    note: plan.note
  };
}
