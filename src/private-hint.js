// 私聊「加我好友」提示的纯规则。
//
// 为什么要有这一条：私聊里 QQ 只能收文字，表情/图片都得先加好友。用户连着聊十几句后
// 才最需要这句提醒——太早像推销，太晚人家已经觉得「这机器人怎么发不了图」。
// 所以阈值（afterMessages）与冷却（cooldownMs）都走配置，默认 15 句 / 24 小时；
// 计数与 lastHintAt 由调用方持久化，这里只做纯判定，方便单测。

export const PRIVATE_HINT_DEFAULT = Object.freeze({
  afterMessages: 15,
  cooldownMs: 24 * 3600 * 1000,
  enabled: true
});

const HINT_TEXT = '（对了，加我好友之后我就能给你发表情和图片了，现在私聊只能打字）';

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 配置既可能直接给 { afterMessages, cooldownMs, enabled }，也可能挂在 privateHint 下。
// 坏值一律回落默认值，不让一条写错的配置把提示永久关掉或永久打开。
export function normalizePrivateHintConfig(cfg) {
  const src = cfg && typeof cfg === 'object' && cfg.privateHint && typeof cfg.privateHint === 'object'
    ? cfg.privateHint
    : (cfg && typeof cfg === 'object' ? cfg : {});
  return {
    afterMessages: Math.max(1, Math.round(positiveNumber(src.afterMessages, PRIVATE_HINT_DEFAULT.afterMessages))),
    cooldownMs: positiveNumber(src.cooldownMs, PRIVATE_HINT_DEFAULT.cooldownMs),
    enabled: src.enabled !== false
  };
}

export function privateHintText() {
  return HINT_TEXT;
}

export function shouldAddFriendHint({ sentCount, lastHintAt, now, cfg } = {}) {
  const conf = normalizePrivateHintConfig(cfg);
  if (!conf.enabled) return { hint: false, text: '' };
  const count = Number.isFinite(Number(sentCount)) ? Math.max(0, Math.floor(Number(sentCount))) : 0;
  if (count < conf.afterMessages) return { hint: false, text: '' };
  const at = Number(now);
  const last = Number(lastHintAt);
  const hasLast = Number.isFinite(last) && last > 0;
  // 冷却从上次提示的时间算：提示过就不在一天内重复，避免变成刷屏。
  if (hasLast && Number.isFinite(at) && at - last < conf.cooldownMs) return { hint: false, text: '' };
  return { hint: true, text: privateHintText() };
}

// 提示发出后：记下时间并从 0 重新计数（下一次要再攒够 afterMessages 句）；
// 没提示就原样返回（不改入参，调用方拿返回值落盘）。
export function nextHintState({ sentCount, lastHintAt } = {}, now, hinted) {
  const count = Number.isFinite(Number(sentCount)) ? Math.max(0, Math.floor(Number(sentCount))) : 0;
  const last = Number.isFinite(Number(lastHintAt)) && Number(lastHintAt) > 0 ? Number(lastHintAt) : 0;
  if (!hinted) return { sentCount: count, lastHintAt: last };
  const at = Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
  return { sentCount: 0, lastHintAt: at };
}
