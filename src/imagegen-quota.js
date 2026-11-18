// 付费出图（Z-Image-Turbo）的每日配额：纯逻辑 + 可注入落盘。
//
// 必须**持久化**：配额若只在内存，重启一次就复活 —— 用户以为「每天 30 次」，
// 实际重启几次就能白刷。所以状态落 state/imagegen-quota.json，按自然日重置。
//
// 并发安全：先占后调、失败回滚（与 send-burst 同一套写法）。两个群同时要高质量图
// 不能超发：占用必须在「调用前」完成，调用失败再还回去。

/** 北京时间的自然日（不依赖运行机器时区）。 */
export function quotaDay(atMs = Date.now()) {
  const d = new Date(Number(atMs) + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** 规范化状态：日期不是今天就把 used 归零（重启不复活靠的就是这一步）。 */
export function normalizeQuota(raw, atMs = Date.now()) {
  const today = quotaDay(atMs);
  const state = raw && typeof raw === 'object' ? raw : {};
  const used = Number(state.used);
  if (state.date !== today) return { date: today, used: 0 };
  return { date: today, used: Number.isFinite(used) && used > 0 ? Math.floor(used) : 0 };
}

/**
 * 占用一次配额。返回 { ok, state, reason }。
 * ok=false 表示今天用完了 —— 调用方应回落到免费通道，而不是直接失败。
 */
export function takeQuota(raw, { dailyLimit = 30, atMs = Date.now() } = {}) {
  const state = normalizeQuota(raw, atMs);
  const limit = Math.max(1, Number(dailyLimit) || 30);
  if (state.used >= limit) return { ok: false, state, limit, reason: `今天的付费出图次数用完了（${state.used}/${limit}）` };
  return { ok: true, state: { date: state.date, used: state.used + 1 }, limit, reason: '' };
}

/** 回滚一次占用（调用失败时用）。只会减到 0，不会变负。 */
export function refundQuota(raw, atMs = Date.now()) {
  const state = normalizeQuota(raw, atMs);
  return { date: state.date, used: Math.max(0, state.used - 1) };
}

/** 读取/写回状态文件（注入 fs 便于测试）。失败一律当作「今天已用 0」，不让配额把生图打死。 */
export function readQuota(file, fsImpl, atMs = Date.now()) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    return normalizeQuota(raw, atMs);
  } catch {
    return normalizeQuota(null, atMs);
  }
}

export function writeQuota(file, state, fsImpl) {
  try { fsImpl.writeFileSync(file, `${JSON.stringify(state)}\n`, 'utf8'); return true; } catch { return false; }
}
