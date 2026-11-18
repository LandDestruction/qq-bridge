// peak-runtime: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, appendSocialV2Message, botNicknameCache, botSelfIdCache, buildPeakMessages, buildPeakRequest, cfg, cleanLocalReply, consumePeakQuota, extractMediaFromSegments, fetch, getSocialV2State, isPeakToneRisky, log, memberRoleCache, oneBotAction, parsePeakReply, peakAgentBuckets, peakAgentLastAt, peakLocalBuckets, peakLocalCfg, peakLocalLastAt, peakLocalQuota, peakLocalRecentTexts, peakLocalStats, segmentsToText, sendToQQ, setTimeout, shouldPeakLocal
// @bridge-function peakCfg:start
function peakCfg(deps) {
    const c = deps.cfg.socialV2?.peakPause || {};
    return {
      enabled: c.enabled === true, // 立即暂停（手动开关，忽略时段）
      schedule: c.schedule === true, // 自动模式：只在高峰时段内暂停
      windows: Array.isArray(c.windows) && c.windows.length ? c.windows : [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
      days: Array.isArray(c.days) && c.days.length ? c.days.map(Number) : [1, 2, 3, 4, 5],
      holidays: Array.isArray(c.holidays) ? c.holidays.map(String) : [],
      makeupDays: Array.isArray(c.makeupDays) ? c.makeupDays.map(String) : []
    };
  }
// @bridge-function peakCfg:end

// @bridge-function minutesOf:start
function minutesOf(deps, hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  }
// @bridge-function minutesOf:end

// @bridge-function localDateStr:start
function localDateStr(deps, d = new Date()) {
    const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
// @bridge-function localDateStr:end

// @bridge-function inPeakWindow:start
function inPeakWindow(deps, now = new Date()) {
    const c = peakCfg(deps);
    const day = localDateStr(deps, now);
    const isHoliday = c.holidays.includes(day);
    const isMakeup = c.makeupDays.includes(day);
    const weekday = now.getDay(); // 0=周日
    const isWorkday = isMakeup || (!isHoliday && c.days.includes(weekday));
    if (!isWorkday) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    for (const w of peakCfg(deps).windows) {
      const a = minutesOf(deps, w.start), b = minutesOf(deps, w.end);
      if (a < 0 || b < 0) continue;
      if (a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b)) return true;
    }
    return false;
  }
// @bridge-function inPeakWindow:end

// @bridge-function peakPauseActive:start
function peakPauseActive(deps) {
    const c = peakCfg(deps);
    if (!c.enabled) return false;
    return c.schedule ? inPeakWindow(deps) : true;
  }
// @bridge-function peakPauseActive:end

// @bridge-function peakLocalBucket:start
function peakLocalBucket(deps, key) {
    const now = Date.now();
    let b = deps.peakLocalBuckets.get(key);
    if (!b || now - b.since > 10 * 60 * 1000) { b = { since: now, count: 0 }; deps.peakLocalBuckets.set(key, b); }
    return b;
  }
// @bridge-function peakLocalBucket:end

// @bridge-function peakAgentCfg:start
function peakAgentCfg(deps) {
    const a = deps.cfg.socialV2?.peakPause?.agent || {};
    const provider = String(a.provider || 'xiaomi-mimo').trim();
    const model = String(a.model || 'mimo-v2.6-pro').trim();
    return { enabled: a.enabled === true, provider, model };
  }
// @bridge-function peakAgentCfg:end

// @bridge-function peakAgentBucket:start
function peakAgentBucket(deps, key) {
    const now = Date.now();
    let b = deps.peakAgentBuckets.get(key);
    if (!b || now - b.since > 10 * 60 * 1000) { b = { since: now, count: 0 }; deps.peakAgentBuckets.set(key, b); }
    return b;
  }
// @bridge-function peakAgentBucket:end

// @bridge-function allowPeakAgent:start
async function allowPeakAgent(deps, key, event) {
    const plc = (0, deps.peakLocalCfg)(deps.cfg.socialV2?.peakPause?.localModel);
    let text = '';
    try { text = await (0, deps.segmentsToText)(event?.message ?? [], { includeReply: false }); } catch {}
    const mentioned = await isAddressedToBot(deps, event).catch(() => false);
    const groupAllow = (deps.cfg.allow?.groups ?? []).map(String);
    if (!groupAllow.includes(String(key).replace(/^group:/, ''))) return false;
    const isQuestion = /[?？]|吗|呢|怎么|为啥|为什么|如何/.test(String(text || ''));
    const prob = Number(plc.probability) > 0 ? Number(plc.probability) : 0.08;
    if (!mentioned && !isQuestion && !(Math.random() < prob)) return false;
    const gapMs = Number(plc.minGapMs) > 0 ? Number(plc.minGapMs) : 20000;
    if (Date.now() - (deps.peakAgentLastAt.get(key) || 0) < gapMs) return false;
    const bucket = peakAgentBucket(deps, key);
    if (bucket.count >= (Number(plc.maxRepliesPer10Min) > 0 ? Number(plc.maxRepliesPer10Min) : 5)) return false;
    return true;
  }
// @bridge-function allowPeakAgent:end

// @bridge-function notePeakAgentReply:start
function notePeakAgentReply(deps, key) {
    deps.peakAgentLastAt.set(key, Date.now());
    peakAgentBucket(deps, key).count += 1;
  }
// @bridge-function notePeakAgentReply:end

// @bridge-function peakStatusView:start
function peakStatusView(deps) {
    const plc = (0, deps.peakLocalCfg)(deps.cfg.socialV2?.peakPause?.localModel);
    const agent = peakAgentCfg(deps);
    const now = Date.now();
    const recent = deps.peakLocalStats.recent.filter((x) => now - x.at < 3600 * 1000);
    const avgMs = recent.length ? Math.round(recent.reduce((a, x) => a + x.ms, 0) / recent.length) : 0;
    return {
      enabled: agent.enabled || plc.enabled,
      active: peakPauseActive(deps),
      mode: agent.enabled ? 'agent' : 'local',
      provider: agent.enabled ? agent.provider : plc.provider,
      model: agent.enabled ? agent.model : plc.model,
      replyToAll: plc.replyToAll,
      windows: peakCfg(deps).windows,
      repliesLastHour: recent.length,
      avgMs,
      lastReplyAt: deps.peakLocalStats.lastAt || 0,
      lastReplyText: deps.peakLocalStats.lastText || ''
    };
  }
// @bridge-function peakStatusView:end

// @bridge-function groupMemberRole:start
async function groupMemberRole(deps, gid, uid) {
    const id = String(uid ?? '').replace(/\D/g, '');
    if (!id) return '';
    const cacheKey = `${gid}:${id}`;
    const hit = deps.memberRoleCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.role;
    try {
      const info = await Promise.race([
        (0, deps.oneBotAction)('get_group_member_info', { group_id: Number(gid), user_id: Number(id), no_cache: false }),
        new Promise((_r, rej) => (0, deps.setTimeout)(() => rej(new Error('timeout')), 3000))
      ]);
      const role = String(info?.role || info?.data?.role || '');
      if (role) { deps.memberRoleCache.set(cacheKey, { role, at: Date.now() }); return role; }
    } catch {}
    return '';
  }
// @bridge-function groupMemberRole:end

// @bridge-function botSelfId:start
async function botSelfId(deps) {
    if (deps.botSelfIdCache) return deps.botSelfIdCache;
    try {
      const info = await Promise.race([
        (0, deps.oneBotAction)('get_login_info', {}),
        new Promise((_r, rej) => (0, deps.setTimeout)(() => rej(new Error('timeout')), 3000))
      ]);
      const id = String(info?.user_id || info?.data?.user_id || '');
      const nick = String(info?.nickname || info?.data?.nickname || '').trim();
      if (id) deps.botSelfIdCache = id;
      if (nick) deps.botNicknameCache = nick;
    } catch {}
    return deps.botSelfIdCache;
  }
// @bridge-function botSelfId:end

// @bridge-function warmSelfIdentity:start
async function warmSelfIdentity(deps) {
    for (let i = 0; i < 2 && !deps.botSelfIdCache; i += 1) { try { await botSelfId(deps); } catch {} }
    if (deps.botSelfIdCache) (0, deps.log)(`[启动] 机器人 self_id=${deps.botSelfIdCache}${deps.botNicknameCache ? `（${deps.botNicknameCache}）` : ''}（唤醒兜底用）`);
  }
// @bridge-function warmSelfIdentity:end

// @bridge-function isAddressedToBot:start
async function isAddressedToBot(deps, event) {
    const segs = Array.isArray(event?.message) ? event.message : [];
    // SnowLuma 的事件里 self_id 不一定存在（实测有的推送不带），所以再兜一层 get_login_info。
    const ids = new Set([String(event?.self_id ?? ''), deps.botSelfIdCache].filter(Boolean));
    if (!ids.size) ids.add(await botSelfId(deps)) && ids.delete('');
    for (const seg of segs) {
      if (seg?.type !== 'at') continue;
      const qq = String(seg?.data?.qq ?? '');
      if (qq && ids.has(qq)) return true;
    }
    const text = segs.filter((x) => x?.type === 'text').map((x) => String(x?.data?.text ?? '')).join(' ');
    return /大肥鱼|肥鱼|鲸鱼|DeepSeek|deepseek|D老师|d老师/i.test(text);
  }
// @bridge-function isAddressedToBot:end

// @bridge-function handlePeakLocalReply:start
async function handlePeakLocalReply(deps, kind, id, event, key) {
    const plc = (0, deps.peakLocalCfg)(deps.cfg.socialV2?.peakPause?.localModel);
    if (!plc.enabled) return false;
    // 高峰期闸门在「白名单判定」之前，必须在这里再卡一次 allow.groups，
    // 否则非白名单群（实测 992835975）也会被本地模型接话——用户明确要求只限允许聊天的群。
    const groupAllow = (deps.cfg.allow?.groups ?? []).map(String);
    if (!groupAllow.includes(String(id))) {
      // 每组每小时最多记一行：非白名单群可能很活跃，逐条打日志会刷屏。
      const k = `skip:${id}`;
      const last = deps.peakLocalLastAt.get(k) || 0;
      if (Date.now() - last > 3600 * 1000) { deps.peakLocalLastAt.set(k, Date.now()); (0, deps.log)(`[峰值-本地] 跳过非白名单群 ${id}（每小时只记一次）`); }
      return false;
    }
    const uid = String(event?.user_id ?? '');
    const role = await groupMemberRole(deps, id, uid).catch(() => '');
    const mentioned = await isAddressedToBot(deps, event).catch(() => false);
    let incoming = '';
    try { incoming = await (0, deps.segmentsToText)(event.message ?? [], { includeReply: false }); } catch {}
    const hasMedia = (() => { try { return (0, deps.extractMediaFromSegments)(event.message ?? []).length > 0; } catch { return false; } })();
    const verdict = (0, deps.shouldPeakLocal)({ cfg: plc, role, mentioned, uid, text: incoming, hasMedia });
    if (!verdict.ok) {
      (0, deps.log)(`[峰值-本地] 不接管（${verdict.reason}，uid=${uid || '?'}，role=${role || '?'}，mentioned=${mentioned}）`);
      return false;
    }
    // 刷屏闸门（用户实测：每说一句就跟一句，10 分钟 22 条）。
    // 只有三种情况才回：@/点名、这句是问句、或按 probability 随机接一次；
    // 另外还有「同群最小间隔」和「10 分钟上限」。
    const addressed = mentioned;
    const isQuestion = /[?？]|吗|呢|怎么|为啥|为什么|如何|吗$/.test(String(incoming || ''));
    const gapKey = `gap:${key}`;
    const lastAt = deps.peakLocalLastAt.get(gapKey) || 0;
    const gapMs = Number(plc.minGapMs) > 0 ? Number(plc.minGapMs) : 20000;
    const bucket = peakLocalBucket(deps, key);
    if (!addressed && !isQuestion && !(Math.random() < (Number(plc.probability) > 0 ? Number(plc.probability) : 0.08))) {
      return false; // 闲聊不接话，安静看着
    }
    if (Date.now() - lastAt < gapMs) return false;
    if (bucket.count >= (Number(plc.maxRepliesPer10Min) > 0 ? Number(plc.maxRepliesPer10Min) : 5)) {
      (0, deps.log)(`[峰值-本地] 10 分钟上限已到（${bucket.count} 条），本条跳过`);
      return false;
    }
    // 限频（进程内）：群一热闹时不能让本地模型刷屏。
    const quota = (0, deps.consumePeakQuota)(deps.peakLocalQuota, key, {
      now: Date.now(),
      perMinute: plc.maxRepliesPerMinute,
      perHour: plc.maxRepliesPerHour
    });
    if (!quota.ok) {
      (0, deps.log)(`[峰值-本地] 限频跳过 ${key}（${quota.reason}，uid=${uid || '?'}）`);
      return false;
    }
    const st = (0, deps.getSocialV2State)(key);
    const messages = (0, deps.buildPeakMessages)({
      recent: Array.isArray(st.recentMessages) ? st.recentMessages : [],
      incomingText: incoming,
      cfg: plc,
      personaText: plc.persona
    });
    const t0 = Date.now();
    let replyText = '';
    try {
      const req = (0, deps.buildPeakRequest)({ cfg: plc, messages, apiKey: String(deps.cfg.socialV2?.peakPause?.localModel?.apiKey || '') || process.env[plc.apiKeyEnv] || '' });
      const res = await (0, deps.fetch)(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: deps.AbortSignal.timeout(plc.timeoutMs)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      replyText = (0, deps.parsePeakReply)(await res.json().catch(() => null));
    } catch (error) {
      (0, deps.log)(`[峰值-本地] 生成失败：${error?.message ?? error}`);
      return false;
    }
    let cleaned = (0, deps.cleanLocalReply)(replyText, { maxChars: plc.maxChars, echoOf: incoming }).trim();
    if (!cleaned) { (0, deps.log)('[峰值-本地] 空回复，放弃'); return false; }
    const dupAt = deps.peakLocalRecentTexts.get(`${key}|${cleaned}`);
    if (dupAt && Date.now() - dupAt < 30 * 60 * 1000) {
      (0, deps.log)(`[峰值-本地] 与 30 分钟内发过的句子重复，放弃：${cleaned.slice(0, 30)}`);
      return false;
    }
    // 8B 模型偶尔还是压不住冲气（实测「你们能不能别吵了」）。命中就带更强约束重写一次，
    // 仍然冲就放弃这条——不发负面情绪，比发出去强。
    if ((0, deps.isPeakToneRisky)(cleaned)) {
      (0, deps.log)(`[峰值-本地] 首次输出偏冲，重写一次：${cleaned.slice(0, 40)}`);
      try {
        const retryMessages = [...messages, { role: 'assistant', content: cleaned }, { role: 'user', content: '这句太冲了，换一句温和、不带指责的话，只输出这一句。' }];
        const req2 = (0, deps.buildPeakRequest)({ cfg: plc, messages: retryMessages, apiKey: String(deps.cfg.socialV2?.peakPause?.localModel?.apiKey || '') || process.env[plc.apiKeyEnv] || '' });
        const res2 = await (0, deps.fetch)(req2.url, {
          method: 'POST', headers: req2.headers,
          body: JSON.stringify(req2.body),
          signal: deps.AbortSignal.timeout(plc.timeoutMs)
        });
        if (res2.ok) cleaned = (0, deps.cleanLocalReply)((0, deps.parsePeakReply)(await res2.json().catch(() => null)), { maxChars: plc.maxChars, echoOf: incoming }).trim();
      } catch (error) {
        (0, deps.log)(`[峰值-本地] 重写失败：${error?.message ?? error}`);
      }
      if (!cleaned || (0, deps.isPeakToneRisky)(cleaned)) { (0, deps.log)('[峰值-本地] 重写后仍偏冲，放弃'); return false; }
    }
    try {
      await (0, deps.sendToQQ)(key, cleaned);
      // 把原始回复写进日志 + 会话历史：
      //  · 日志带正文，用户可拿 QQ 里看到的字逐字对照，确认「本地模型 vs API」；
      //  · 历史里记成自己发的，下一轮本地模型才有上下文（否则它只看到群友的话）。
      const costMs = Date.now() - t0;
      deps.peakLocalStats.recent.push({ at: Date.now(), ms: costMs });
      if (deps.peakLocalStats.recent.length > 500) deps.peakLocalStats.recent.splice(0, deps.peakLocalStats.recent.length - 500);
      deps.peakLocalStats.lastAt = Date.now();
      deps.peakLocalStats.lastText = String(cleaned).slice(0, 60);
      deps.peakLocalLastAt.set(`gap:${key}`, Date.now());
      peakLocalBucket(deps, key).count += 1;
      deps.peakLocalRecentTexts.set(`${key}|${cleaned}`, Date.now());
      (0, deps.log)(`[峰值-本地] 已回复 ${key}（模型 ${plc.model}，replyToAll=${plc.replyToAll !== false}，触发者 uid=${uid || '?'}，${costMs}ms，${cleaned.length} 字）：${cleaned.slice(0, 80)}`);
      try {
        (0, deps.appendSocialV2Message)(key, '大肥鱼小姐', cleaned, cleaned, false, true, null, [], '', []);
      } catch (error) {
        (0, deps.log)(`[峰值-本地] 写历史失败：${error?.message ?? error}`);
      }
      return true;
    } catch (error) {
      (0, deps.log)(`[峰值-本地] 发送失败：${error?.message ?? error}`);
      return false;
    }
  }
// @bridge-function handlePeakLocalReply:end
export function createPeakRuntime(deps) {
  return {
    peakCfg: (...args) => peakCfg(deps, ...args),
    minutesOf: (...args) => minutesOf(deps, ...args),
    localDateStr: (...args) => localDateStr(deps, ...args),
    inPeakWindow: (...args) => inPeakWindow(deps, ...args),
    peakPauseActive: (...args) => peakPauseActive(deps, ...args),
    peakLocalBucket: (...args) => peakLocalBucket(deps, ...args),
    peakAgentCfg: (...args) => peakAgentCfg(deps, ...args),
    peakAgentBucket: (...args) => peakAgentBucket(deps, ...args),
    allowPeakAgent: (...args) => allowPeakAgent(deps, ...args),
    notePeakAgentReply: (...args) => notePeakAgentReply(deps, ...args),
    peakStatusView: (...args) => peakStatusView(deps, ...args),
    groupMemberRole: (...args) => groupMemberRole(deps, ...args),
    botSelfId: (...args) => botSelfId(deps, ...args),
    warmSelfIdentity: (...args) => warmSelfIdentity(deps, ...args),
    isAddressedToBot: (...args) => isAddressedToBot(deps, ...args),
    handlePeakLocalReply: (...args) => handlePeakLocalReply(deps, ...args)
  };
}
