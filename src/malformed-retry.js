// malformed tool-call JSON 的重试决策（纯逻辑，可离线断言）。
//
// 背景：DSH 侧对「模型返回的 tool-call arguments 不是合法 JSON」直接判 malformed，
// 整轮失败。线上 22:22 连续两次出现（deepseek-flash, high），用户看到一句通用的
// 「我这轮出了点问题，稍后再试」——这句对用户没有任何帮助。
//
// 策略（每次失败只做一件便宜的事，最多两次重试）：
//   第 1 次失败 → 同 prompt 重投一次（多数是模型瞬时输出损坏）；
//   第 2 次失败 → 换一个可用模型重投（说明该模型对复杂 tool-call 不稳定）；
//   第 3 次失败 → 放弃，发中性提示。
export const MALFORMED_PATTERNS = [
  /tool input is invalid json/i,
  /malformed/i,
  /invalid tool call/i
];

export function isMalformedToolJson(message) {
  const m = String(message ?? '');
  if (!m) return false;
  return MALFORMED_PATTERNS.some((re) => re.test(m));
}

/**
 * @param {{ attempts: number }} p attempts = 已经因 malformed 重试过的次数
 * @returns {'retry-same'|'retry-fallback'|'give-up'}
 */
export function decideMalformedAction({ attempts = 0 } = {}) {
  const n = Math.max(0, Number(attempts) || 0);
  if (n <= 0) return 'retry-same';
  if (n === 1) return 'retry-fallback';
  return 'give-up';
}

/** 给用户的中性提示（重试全部失败后才发）。 */
export const MALFORMED_GIVEUP_TEXT = '刚才那条我处理岔了，已经重试过；你再发一次我就接着聊。';
