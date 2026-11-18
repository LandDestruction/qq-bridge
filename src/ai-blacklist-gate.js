// AI 黑名单「发送前硬闸」：把「不跟名单里的机器人尬聊」从唤醒/上下文层落到发送这一层。
//
// 为什么需要它：`src/ai-blacklist.js` 的 runtime 只在**唤醒**和**上下文**两处生效
// （silent 不回、reduce 降频），但模型一旦已经被唤醒、在回合里决定去引用或 @ 某条消息，
// 现有的发送路由（/api/socialV2/send-message、/send-burst）照样会把消息发出去 ——
// 用户多次抱怨的正是「主动 @ 名单里的 AI 还被接住了」。
// 这个模块是纯判定：给定「配置 + 这条消息要回给谁 / @ 谁 / 写了什么」，返回
// { allow, reason, text }。它不发送、不写盘、不抛错，发送路由拿到 allow:false 后
// 直接拒绝发送，并把一句人话返回给模型（模型要能读懂为什么被拦，而不是看到 500）。
//
// 规则（与 Lead 的口径逐条对应）：
//   1. reply-to-blacklisted：引用的那条消息 senderId 在名单里 → 拦。
//   2. at-blacklisted：atUserId 参数（或文本里的 [CQ:at,qq=]/<at qq=>）命中名单 → 拦。
//   3. text-at-blacklisted：纯文字里出现「@昵称」且昵称只命中名单里的**一个人** → 拦。
//      为什么要求「只命中一个人」：两个名单成员同名/昵称互为前缀时，按文字拦截会误伤；
//      宁可放过一条，也不要拦错人（误拦会变成"模型莫名其妙不能说话"）。
//   4. enabled=false（默认值）→ 全放行；mode==='silent' 时只拦 reply/at 两类
//      （与 runtime 的 silent 语义一致：静默模式下文字 @ 本来也不会得到回应的机会，
//      但"回给名单 AI"和"直接 @ 名单 AI"这种明确的指向仍要拦）。
//
// 约定：reason 是稳定的机器码（发送路由拿它写工具日志 blocked/reason），
// text 是给模型看的中文句子（不含 [object Object] 这类序列化垃圾）。
export const AI_BLACKLIST_GATE_VERSION = 1;

// 机器码 → 给模型看的一句话。集中在一处，测试和日志都引用同一份文案。
export const AI_BLACKLIST_GATE_REASON_TEXT = Object.freeze({
  'reply-to-blacklisted': '这条是回名单里那个 AI 的，不接（AI 黑名单）',
  'at-blacklisted': '这条 @ 了名单里的 AI，不接（AI 黑名单）',
  'text-at-blacklisted': '这条提到了名单里的 AI（@昵称），不接（AI 黑名单）'
});

const AI_GATE_ID_RE = /^\d{5,13}$/;

// 昵称归一化：去掉所有空白/零宽字符、统一小写。
// 为什么这么狠：QQ 昵称里常见全角空格、"·"、emoji，模型转述成文字时也可能漏空格；
// 去空白后的「包含」判定既能接住「@小明」也能接住「@ 小明 」，同时不会把
// 「@小明同学」误当成「@小明」以外的东西（仍会命中，符合"出现即算"的口径）。
export function normalizeGateName(text) {
  return String(text ?? '')
    .replace(/[\s\u200b-\u200f\u2028\u2029\uFEFF]+/gu, '')
    .toLowerCase();
}

function gateIdOf(value) {
  const id = String(value ?? '').trim();
  return AI_GATE_ID_RE.test(id) ? id : '';
}

// 配置归一化：坏数据当「关闭」，避免一个坏字段让闸门整体失效（fail-open）或误拦（fail-closed）。
// 与 ai-blacklist.js 的 normalizeAiBlacklist 保持同一份字段语义，但不改那个模块。
export function normalizeGateConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const entries = [];
  const seen = new Set();
  const qq = Array.isArray(src.qq) ? src.qq : [];
  for (const item of qq) {
    const id = gateIdOf(typeof item === 'string' ? item : item?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const note = typeof item === 'object' && item ? String(item.note ?? '').trim().slice(0, 40) : '';
    entries.push({ id, note, noteKey: normalizeGateName(note) });
  }
  return {
    enabled: src.enabled === true,
    mode: src.mode === 'silent' ? 'silent' : 'reduce',
    entries
  };
}

// 从文本里抽 at 的 QQ 号：发送层正常只走 atUserId 参数（text 段会被 escapeCqText 转义），
// 但模型偶尔会自己写 [CQ:at,qq=123] 或 <at qq="123">（有些客户端会渲染），
// 这是防绕过用的兜底解析；解析不出来就返回空数组，不抛错。
export function atIdsFromText(text) {
  const src = String(text ?? '');
  if (!src) return [];
  const ids = [];
  const push = (value) => {
    const id = gateIdOf(value);
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const match of src.matchAll(/\[CQ:at,qq=(\d{5,13})[^\]]*\]/g)) push(match[1]);
  for (const match of src.matchAll(/<at\b[^>]*?(?:qq|user_id|userId)\s*=\s*["']?(\d{5,13})/gi)) push(match[1]);
  return ids;
}

function gateAllow() {
  return { allow: true, reason: null, text: '', matchedId: '', matchedNote: '' };
}

function gateBlock(reason, matched) {
  return {
    allow: false,
    reason,
    text: AI_BLACKLIST_GATE_REASON_TEXT[reason] || '这条消息指向名单里的 AI，不接（AI 黑名单）',
    matchedId: matched?.id ? String(matched.id) : '',
    matchedNote: matched?.note ? String(matched.note) : ''
  };
}

/**
 * 发送前判定。
 *
 * @param {object} input
 * @param {object} input.cfg       socialV2.aiBlacklist 原始配置（enabled/mode/qq[]）
 * @param {'group'|'private'} [input.kind] 会话类型（at 规则只对群生效）
 * @param {string|number} [input.replyToUserId] 被引用消息的 senderId（resolveReplyTargetV2 解析出来的 userId）
 * @param {string} [input.replyToSender] 被引用消息的发送者显示名（只用于日志/调试，不参与判定）
 * @param {string[]} [input.atUserIds] atUserId 参数（群聊）
 * @param {string[]} [input.texts]  这次要发的所有气泡文本
 * @returns {{allow:boolean, reason:(string|null), text:string, matchedId:string, matchedNote:string}}
 */
export function gateAiBlacklistSend(input) {
  const args = input && typeof input === 'object' ? input : {};
  const cfg = normalizeGateConfig(args.cfg);
  if (!cfg.enabled) return gateAllow();
  const kind = args.kind === 'private' ? 'private' : 'group';
  const texts = Array.isArray(args.texts)
    ? args.texts.map((t) => String(t ?? ''))
    : (typeof args.texts === 'string' ? [args.texts] : (typeof args.text === 'string' ? [args.text] : []));
  const byId = new Map(cfg.entries.map((entry) => [entry.id, entry]));

  // 1) 引用的那条消息是谁发的
  const replyId = gateIdOf(args.replyToUserId);
  if (replyId && byId.has(replyId)) return gateBlock('reply-to-blacklisted', byId.get(replyId));

  // 2) 这次消息 at 了谁（参数 + 文本里的 at 段兜底）
  const atCandidates = new Set();
  const rawAt = Array.isArray(args.atUserIds)
    ? args.atUserIds
    : (args.atUserId !== undefined && args.atUserId !== null ? [args.atUserId] : []);
  for (const value of rawAt) {
    const id = gateIdOf(value);
    if (id) atCandidates.add(id);
  }
  for (const text of texts) {
    for (const id of atIdsFromText(text)) atCandidates.add(id);
  }
  if (kind === 'group') {
    for (const id of atCandidates) {
      if (byId.has(id)) return gateBlock('at-blacklisted', byId.get(id));
    }
  }

  // 3) 纯文字里的「@昵称」：只在非 silent 时拦，且只命中唯一一个名单成员才拦。
  if (cfg.mode !== 'silent') {
    const matched = cfg.entries.filter((entry) => {
      if (!entry.noteKey) return false;
      const needle = '@' + entry.noteKey;
      return texts.some((text) => normalizeGateName(text).includes(needle));
    });
    if (matched.length === 1) return gateBlock('text-at-blacklisted', matched[0]);
  }

  return gateAllow();
}
