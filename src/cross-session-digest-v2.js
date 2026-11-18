// D36 之后：摘要生成已经并回 `src/cross-session-memory.js` 的 `buildDigest()`（单一真源，
// 不再有「模块都对但线上跑的是另一份」的隐患）。本文件只保留两个**只属于接线层**的纯函数：
//   · `shouldRefreshDigest()`：条数 或 年龄（默认 2h）任一满足就重建——治线上「8.6 小时没刷」；
//   · `freshnessLabel()`：注入时给每条摘要标「N 小时前」。
// 另外把 `buildDigestV2 / isPlaceholderOnly / shapeBody` 作为**兼容别名**再导出一份，
// 让既有单测和外部调用不用改；实现仍然只有一份（在 cross-session-memory.js）。
export {
  buildDigest as buildDigestV2,
  isPlaceholderOnly,
  shapeBody,
  DISCLOSURE_HEADERS
} from './cross-session-memory.js';

export const DIGEST_V2_DEFAULTS = Object.freeze({
  maxChars: 200,        // 单条摘要上限（与旧版一致，存储不涨）
  maxOthers: 6,         // 最多装多少条「别人」的话
  maxSelf: 2,           // 最多补几条「我：」
  selfOnlyWhenOthersBelow: 3,
  maxBody: 40,          // 单条正文视觉上限（超过就按句子截）
  maxTopics: 6
});

/** 渲染时给每条摘要带上新鲜度标签（B 档用，纯函数）。 */
export function freshnessLabel(at, now = Date.now()) {
  const hours = (Number(now) - Number(at || 0)) / 3600000;
  if (!Number.isFinite(hours) || hours < 0) return '';
  if (hours < 1) return '刚刚';
  if (hours < 24) return `${Math.floor(hours)} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * B 档：判断「该不该刷新摘要」。
 *
 * 为什么不能只靠条数：线上实测 `group:100000003` 的摘要在 34 条新消息之后仍是 8.6 小时前的，
 * 而配置是每 20 条——说明计数器只挂在真走 `appendSocialV2Message` 的入站路径上，
 * 历史回填/旁路进来的消息不计。**条数会漏，时间是硬的**，所以两条任一满足就刷新：
 *   ① 条数到了 everyMessages；② 摘要年龄超过 maxAgeMs（默认 2 小时）。
 * 这样即使计数器被漏计，摘要也不会旧到「隔夜」。
 */
export function shouldRefreshDigest({ count = 0, lastAt = 0, now = Date.now(), everyMessages = 20, maxAgeMs = 2 * 3600 * 1000 } = {}) {
  const every = Math.max(1, Number(everyMessages) || 20);
  const n = Number(count) || 0;
  if (n > 0 && n % every === 0) return { refresh: true, why: 'count' };
  const age = Number(now) - Number(lastAt || 0);
  if (!Number(lastAt)) return { refresh: false, why: 'no-digest-yet-but-count-not-reached' };
  if (age >= Number(maxAgeMs)) return { refresh: true, why: 'age' };
  return { refresh: false, why: 'fresh' };
}
