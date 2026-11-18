// AI 黑名单（D70）：把要限制的 AI QQ 登记进来，降低与其它 AI 的接话频次，避免「聊天永动机」。
//
// 设计口径（与 config.json 的 socialV2.aiBlacklist 一致）：
//   { enabled, qq:[{id, addedAt, note}], mode:'reduce'|'silent', minIntervalMs, perHourMax, atMeReply }
//
//   - reduce（默认）：消息照常进上下文，但非 @ 类的唤醒触发源（关键词/概率/拍一拍/主动检查）一律不触发；
//     @ 仍按 atMeReply 决定（true=回，false=连 @ 也不回）。
//   - silent：连 @ 都不回。
//   - 冷却/频次：同一 QQ 在 minIntervalMs 内已回过 → 跳过（why=cooldown）；
//     每自然小时最多 perHourMax 次 → 跳过（why=hourly-cap）。
//
// 这是一个纯逻辑模块：配置、时钟、日志都注入，便于单测；控制台的读写在 createAiBlacklistAdmin。

export const AI_BLACKLIST_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'reduce',
  minIntervalMs: 10 * 60 * 1000,
  perHourMax: 3,
  atMeReply: true
});

// D73 的私聊命令口径是「5~13 位数字」；QQ 现实最多 11 位，这里统一放宽到 13，
// 免得控制台能加、私聊不能加（两边校验不一致最难排查）。
const QQ_RE = /^\d{5,13}$/;

/** 规范化配置：坏值不炸、qq 支持字符串/数字/对象混写，按 id 去重并保留最近添加顺序。 */
export function normalizeAiBlacklist(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const seen = new Set();
  const qq = [];
  for (const entry of (Array.isArray(r.qq) ? r.qq : [])) {
    const obj = entry && typeof entry === 'object' ? entry : { id: entry };
    const id = String(obj.id ?? obj.qq ?? '').trim();
    if (!QQ_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    qq.push({
      id,
      addedAt: Number.isFinite(Number(obj.addedAt)) && Number(obj.addedAt) > 0 ? Number(obj.addedAt) : 0,
      note: String(obj.note ?? '').slice(0, 40)
    });
  }
  const minIntervalMs = Number(r.minIntervalMs);
  const perHourMax = Number(r.perHourMax);
  return {
    ...AI_BLACKLIST_DEFAULTS,
    enabled: r.enabled === true,
    mode: r.mode === 'silent' ? 'silent' : 'reduce',
    minIntervalMs: Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? Math.round(minIntervalMs) : AI_BLACKLIST_DEFAULTS.minIntervalMs,
    perHourMax: Number.isFinite(perHourMax) && perHourMax >= 0 ? Math.round(perHourMax) : AI_BLACKLIST_DEFAULTS.perHourMax,
    atMeReply: r.atMeReply !== false,
    qq
  };
}

/** 触发源 → 黑名单门类。返回 null 表示这类唤醒不归黑名单管（bootstrap/timeout/debug）。 */
export function aiTriggerClass(trigger) {
  const t = String(trigger ?? '').trim();
  if (!t) return null;
  if (/^keyword:/i.test(t)) return 'keyword';
  if (/^proactive/i.test(t)) return 'proactive';
  // replyCheck（自己发完言后按 autoReplyCheckMs 回看一眼的唤醒）以前不归黑名单管，
  // 结果就是：机器人 A 回完话 → 回看 → 看到对方 AI 又接了一句 → 再回 → 再回看……
  // 黑名单形同虚设。它本质是「非点名、自己凑上去」的打扰源，按 proactive 同类处理：
  // 只要会话里最近说话的是黑名单里的 AI，这一眼就别看。
  if (/^replycheck$/i.test(t)) return 'proactive';
  // 拍一拍/任意消息/概率都属于「非点名」的打扰源：reduce 下一律拦掉。
  if (/^(probability|anymessage|poke|random)/i.test(t)) return 'probability';
  if (/^(atmention|namemention|question|speaker|private)/i.test(t)) return 'at';
  return null;
}

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hourKey = (t) => {
  const d = new Date(t);
  return `${dayKey(t)}-${String(d.getHours()).padStart(2, '0')}`;
};

/**
 * 运行期判定器。
 * @param {{ getConfig: () => any, now?: () => number, log?: Function }} deps
 */
export function createAiBlacklistRuntime({ getConfig, now = () => Date.now(), log = () => {} }) {
  const replies = new Map(); // id -> [{ at, hour }]
  // 今日拦截统计：按原因分组 + 最近几条（控制台「黑名单拦了什么」用）。
  // 只存内存、跨重启清零——统计的是「这个进程今天拦下的」，别把它当成历史账本。
  const skipped = { day: '', count: 0, byWhy: {}, recent: [] };
  const SKIP_LABELS = { keyword: '关键词', probability: '概率/拍一拍', proactive: '主动/回看', at: '@ 或引用', cooldown: '冷却中', 'hourly-cap': '小时上限' };

  const resetIfNewDay = (t) => {
    const d = dayKey(t);
    if (skipped.day !== d) { skipped.day = d; skipped.count = 0; skipped.byWhy = {}; skipped.recent = []; }
  };
  const bumpSkip = (why, qq, trigger) => {
    const t = now();
    resetIfNewDay(t);
    skipped.count += 1;
    skipped.byWhy[why] = (skipped.byWhy[why] || 0) + 1;
    skipped.recent.push({ at: t, qq: String(qq ?? ''), why, trigger: String(trigger ?? '') });
    if (skipped.recent.length > 8) skipped.recent.splice(0, skipped.recent.length - 8);
  };

  const conf = () => normalizeAiBlacklist(getConfig());
  const record = (id, t) => {
    const list = (replies.get(id) || []).filter((x) => t - x.at <= 60 * 60 * 1000);
    list.push({ at: t, hour: hourKey(t) });
    replies.set(id, list);
  };

  return {
    config: conf,
    /** 只判「是否在黑名单里」（用于 prompt 注入，不消耗冷却/计数）。 */
    isAiBlacklisted(key, userId) {
      if (userId === undefined || userId === null || userId === '') return false;
      const c = conf();
      if (!c.enabled) return false;
      return c.qq.some((e) => e.id === String(userId));
    },
    /**
     * 三处唤醒闸统一入口。
     * @returns {{ skip: boolean, why: null|'at'|'keyword'|'probability'|'proactive'|'cooldown'|'hourly-cap' }}
     */
    verdict(key, userId, trigger) {
      const c = conf();
      if (!c.enabled || userId === undefined || userId === null || userId === '') return { skip: false, why: null };
      const id = String(userId);
      if (!c.qq.some((e) => e.id === id)) return { skip: false, why: null };
      const cls = aiTriggerClass(trigger);
      if (!cls) return { skip: false, why: null };
      // silent：连 @ 都不回。
      if (c.mode === 'silent') { bumpSkip(cls, id, trigger); return { skip: true, why: cls }; }
      // atMeReply=false 的优先级高于 reduce：即使是 @ 也不回。
      if (cls === 'at' && c.atMeReply === false) { bumpSkip('at', id, trigger); return { skip: true, why: 'at' }; }
      // reduce：非点名触发源一律不唤醒（@ 由 atMeReply 决定，走到这里说明允许）。
      if (cls !== 'at') { bumpSkip(cls, id, trigger); return { skip: true, why: cls }; }
      const t = now();
      const list = replies.get(id) || [];
      const last = list.length ? list[list.length - 1].at : 0;
      if (last && t - last < c.minIntervalMs) { bumpSkip('cooldown', id, trigger); return { skip: true, why: 'cooldown' }; }
      const hour = hourKey(t);
      const inHour = list.filter((x) => x.hour === hour).length;
      if (c.perHourMax > 0 && inHour >= c.perHourMax) { bumpSkip('hourly-cap', id, trigger); return { skip: true, why: 'hourly-cap' }; }
      // 放行：记一次「回过这个 AI」，供冷却与小时上限用。
      record(id, t);
      if (log) log(`[AI黑名单] 放行 qq=${id}（${hour} 第 ${inHour + 1}/${c.perHourMax} 次）`);
      return { skip: false, why: null };
    },
    /** 记一次「被黑名单拦下」，控制台今日跳过次数用。 */
    noteSkip() {
      bumpSkip('note', '', '');
    },
    stats() {
      const d = dayKey(now());
      if (skipped.day !== d) return { skippedToday: 0, day: d, byWhy: {}, recent: [], labels: SKIP_LABELS };
      const byWhy = Object.entries(skipped.byWhy)
        .map(([why, count]) => ({ why, count, label: SKIP_LABELS[why] || why }))
        .sort((a, b) => b.count - a.count);
      return { skippedToday: skipped.count, day: d, byWhy, recent: skipped.recent.slice(-5).reverse(), labels: SKIP_LABELS };
    }
  };
}

/** 控制台写配置用：读盘→备份→在磁盘最新内容上改 aiBlacklist→原子写回。 */
export function createAiBlacklistAdmin({ configFile, getConfig, writeConfig, readConfig, fs, path, now = () => Date.now(), log = () => {} }) {
  const backup = () => {
    try {
      if (!fs.existsSync(configFile)) return '';
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const file = `${configFile}.bak-${stamp}`;
      fs.copyFileSync(configFile, file);
      try {
        const dir = path.dirname(configFile);
        const base = path.basename(configFile) + '.bak-';
        const olds = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort();
        for (const n of olds.slice(0, Math.max(0, olds.length - 5))) fs.rmSync(path.join(dir, n), { force: true });
      } catch {}
      return file;
    } catch (error) {
      log(`[AI黑名单] 备份 config.json 失败（继续写）：${error?.message ?? error}`);
      return '';
    }
  };
  const apply = (mutate) => {
    backup();
    let next = null;
    writeConfig((disk) => {
      disk.socialV2 = disk.socialV2 && typeof disk.socialV2 === 'object' && !Array.isArray(disk.socialV2) ? disk.socialV2 : {};
      const cur = normalizeAiBlacklist(disk.socialV2.aiBlacklist);
      next = mutate(cur);
      disk.socialV2.aiBlacklist = next;
    });
    return next ?? normalizeAiBlacklist(getConfig());
  };
  return {
    get() { return normalizeAiBlacklist(getConfig()); },
    add(rawQq, note = '') {
      const id = String(rawQq ?? '').trim();
      if (!QQ_RE.test(id)) throw new Error('QQ 号必须是 5~13 位数字');
      return apply((cur) => {
        if (cur.qq.some((e) => e.id === id)) return cur;
        return { ...cur, qq: [...cur.qq, { id, addedAt: now(), note: String(note ?? '').slice(0, 40) }] };
      });
    },
    remove(rawQq) {
      const id = String(rawQq ?? '').trim();
      return apply((cur) => ({ ...cur, qq: cur.qq.filter((e) => e.id !== id) }));
    },
    toggle(enabled) {
      return apply((cur) => ({ ...cur, enabled: enabled === true }));
    },
    /** D73：私聊命令切模式（reduce|silent）。非法值抛错，由命令层回一行提示。 */
    mode(m) {
      const next = String(m ?? '').trim().toLowerCase();
      if (next !== 'reduce' && next !== 'silent') throw new Error('mode 只能是 reduce 或 silent');
      return apply((cur) => ({ ...cur, mode: next }));
    }
  };
}
