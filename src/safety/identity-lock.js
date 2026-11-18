// 身份锁：把「桥接允许用哪个 QQ 号说话」钉死在配置里。
//
// 为什么需要：SnowLuma 登录的是哪个 QQ 号，桥接就用哪个号发言。一旦 SnowLuma 里
// 换成了别的主号（手滑扫码 / 快速登录 / 缓存了旧的登录态），机器人就会顶着那个号
// 在群里说话——用户看到的是「我自己的 QQ 在群聊里发消息」，而且穿帮、封号风险都算
// 在号主头上。这个模块提供一个可测的判定：实际登录号不在白名单里 → 整个桥接进入
// 「锁定」状态，一条消息都不许发出去（宁可哑掉，也不要用错号说话）。
//
// 纯函数、零 import，便于审计沙箱直接执行与单测。

export const IDENTITY_CONFIG_DEFAULT = Object.freeze({
  expectedSelfIds: [],
  onMismatch: 'lock',
});

/** "100000006" / 100000006 / " 100000006 " → "100000006"；非纯数字回 ""。 */
export function normalizeSelfId(value) {
  const s = String(value ?? '').trim();
  return /^\d{5,12}$/.test(s) ? s : '';
}

/** 配置归一：白名单去重去空、onMismatch 只认 lock|warn；缺省（空名单）= 不启用。 */
export function normalizeIdentityConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(src.expectedSelfIds) ? src.expectedSelfIds : [];
  const seen = new Set();
  const expectedSelfIds = [];
  for (const item of list) {
    const id = normalizeSelfId(item);
    if (id && !seen.has(id)) {
      seen.add(id);
      expectedSelfIds.push(id);
    }
  }
  const onMismatch = String(src.onMismatch ?? '').trim().toLowerCase() === 'warn' ? 'warn' : 'lock';
  return Object.freeze({ expectedSelfIds: Object.freeze(expectedSelfIds), onMismatch });
}

/**
 * 判定当前登录号是否允许。
 * - 名单为空：不启用（enabled:false，ok:true，便于旧配置平滑上线）。
 * - selfId 缺失（还没连上/取不到）：不锁定，但 ready:false，避免启动瞬间误锁。
 * - 不在名单：onMismatch==='warn' 只告警；否则 lock。
 */
export function checkIdentity({ selfId, expectedSelfIds, onMismatch } = {}) {
  const id = normalizeSelfId(selfId);
  const list = (Array.isArray(expectedSelfIds) ? expectedSelfIds : []).map(normalizeSelfId).filter(Boolean);
  const mode = String(onMismatch ?? '').trim().toLowerCase() === 'warn' ? 'warn' : 'lock';
  if (list.length === 0) {
    return { enabled: false, ready: false, ok: true, lock: false, mode, selfId: id, expected: [] };
  }
  if (!id) {
    return { enabled: true, ready: false, ok: true, lock: false, mode, selfId: '', expected: list };
  }
  const allowed = list.includes(id);
  return {
    enabled: true,
    ready: true,
    ok: allowed,
    lock: !allowed && mode === 'lock',
    mode,
    selfId: id,
    expected: list,
    text: allowed
      ? ''
      : `QQ 登录号 ${id} 不在允许名单（${list.join(' / ')}）里${mode === 'lock' ? '，已锁定发送' : '，仅告警'}`,
  };
}

/** 给 /api/status 与日志用的短描述。 */
export const REQUIRED_BOT_SELF_ID = '100000007';

export function identitySendDenialReason(state) {
  const s = state && typeof state === 'object' ? state : {};
  const expected = (Array.isArray(s.expected) ? s.expected : []).map(normalizeSelfId).filter(Boolean);
  const selfId = normalizeSelfId(s.selfId);
  // 该实例专属于固定 bot UIN；不能因配置误改或 warn 模式而允许个人号出站。
  if (!s.enabled || expected.length === 0 || !expected.includes(REQUIRED_BOT_SELF_ID)) {
    return `发送已取消：身份允许名单必须包含机器人 QQ ${REQUIRED_BOT_SELF_ID}`;
  }
  if (s.ready !== true || !selfId) return '发送已取消：SnowLuma 登录身份尚未验证';
  if (selfId !== REQUIRED_BOT_SELF_ID || s.lock === true || s.ok !== true || !expected.includes(selfId)) {
    return `发送已取消：当前 QQ ${selfId || '未知'} 不是机器人 QQ ${REQUIRED_BOT_SELF_ID}`;
  }
  return '';
}

export function assertIdentitySendAllowed(state) {
  const reason = identitySendDenialReason(state);
  if (reason) throw new Error(reason);
  return true;
}

export function describeIdentityLock(state) {
  const s = state && typeof state === 'object' ? state : {};
  if (!s.enabled) return '身份锁未启用（identity.expectedSelfIds 为空）';
  if (!s.checkedAt) return '身份锁：尚未检查登录号';
  if (s.ok) return `身份锁：正常（QQ ${s.selfId}）`;
  if (s.lock) return `身份锁：已锁定——QQ ${s.selfId} 不在名单 ${(s.expected || []).join(' / ')}`;
  return `身份锁：告警——QQ ${s.selfId} 不在名单 ${(s.expected || []).join(' / ')}`;
}
