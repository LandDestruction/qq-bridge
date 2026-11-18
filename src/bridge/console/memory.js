// console/memory: extracted bridge responsibilities; no startup side effects.
// Live dependencies: addSharedEvent, appendMemoryV2, applyImpressionEdit, formatMemoryV2, getSocialV2State, mergeImpression, normalizeInitialPromptText, parsePersonaRequest, personaKeyError, personaMaxChars, redactKnownTokensOnly, saveSocialV2State, selectEventsForInjection, sessionLabel, sessionLabelsMap, socialV2, v2ToolEnabled
// GET /api/memory/overview 的只读聚合：不写盘、不调 QQ API、不为未知 key 创建会话状态。
// 放在工厂外：工厂体已接近 300 行红线，这里只按 deps 传参，不持有闭包状态。
function buildMemoryOverview(deps) {
    const now = Date.now();
    let labels = {};
    try { labels = (0, deps.sessionLabelsMap)() || {}; } catch { labels = {}; }
    const labelOf = (key) => {
      if (labels[key]) return labels[key];
      try { return (0, deps.sessionLabel)(key); } catch {
        return { kind: 'unknown', id: String(key ?? ''), name: '名称未知', label: `名称未知（${String(key ?? '')}）` };
      }
    };
    const socialV2 = deps.socialV2 || {};
    const events = Array.isArray(socialV2.sharedEvents) ? socialV2.sharedEvents.filter((e) => e && typeof e === 'object') : [];
    let globalEventCount = 0;
    const eventsByScope = new Map();
    for (const event of events) {
      if (event.scope === 'global') globalEventCount += 1;
      else if (event.scope) eventsByScope.set(event.scope, (eventsByScope.get(event.scope) || 0) + 1);
    }
    const sessions = [];
    const conversations = socialV2.conversations;
    if (conversations && typeof conversations.forEach === 'function') {
      conversations.forEach((st, key) => {
        try {
          const info = labelOf(key);
          const topics = Array.isArray(st && st.activeTopics) ? st.activeTopics.length : 0;
          const thoughts = Array.isArray(st && st.pendingThoughts)
            ? st.pendingThoughts.filter((t) => {
              const expiresAt = t && (t.expiresAtMs ?? t.expiresAt);
              return !expiresAt || Number(expiresAt) > now;
            }).length
            : 0;
          const impressions = st && st.memberImpressions && typeof st.memberImpressions === 'object'
            ? Object.keys(st.memberImpressions).length
            : 0;
          const recent = st && Array.isArray(st.recentMessages) ? st.recentMessages.length : 0;
          const counts = { topics, thoughts, impressions, recent, events: globalEventCount + (eventsByScope.get(key) || 0) };
          const lastAt = Math.max(
            Number(st && st.lastIncomingAt) || 0,
            Number(st && st.lastActionAt) || 0,
            Number(st && st.lastAiReplyAt) || 0
          );
          sessions.push({ key, kind: info.kind, id: info.id, name: info.name, label: info.label, counts, lastAt });
        } catch { /* 单个会话字段畸形就跳过，总览其余部分照常返回 */ }
      });
    }
    sessions.sort((a, b) => b.lastAt - a.lastAt);
    const totals = { sessions: sessions.length, topics: 0, thoughts: 0, impressions: 0, recent: 0, sharedEvents: events.length, globalImpressions: 0 };
    for (const session of sessions) {
      totals.topics += session.counts.topics;
      totals.thoughts += session.counts.thoughts;
      totals.impressions += session.counts.impressions;
      totals.recent += session.counts.recent;
    }
    const globalImpressions = [];
    if (socialV2.globalImpressions && typeof socialV2.globalImpressions === 'object') {
      for (const [name, value] of Object.entries(socialV2.globalImpressions)) {
        globalImpressions.push({
          name,
          traits: Array.isArray(value && value.traits) ? value.traits : [],
          interactionCount: Number(value && value.interactionCount) || 0,
          lastSeenAt: Number(value && value.lastSeenAt) || 0
        });
      }
    }
    totals.globalImpressions = globalImpressions.length;
    const scopeLabel = (scope) => {
      if (!scope || scope === 'global') return '所有会话';
      const info = labelOf(scope);
      return info.label || String(scope);
    };
    const sharedEvents = events
      .slice()
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .slice(0, 200)
      .map((e) => ({ id: e.id, at: e.at, text: e.text, scope: e.scope, scopeLabel: scopeLabel(e.scope), by: String(e.by ?? '') }));
  return { ok: true, totals, sessions, globalImpressions, sharedEvents };
}

// GET /api/impressions：只读 state/impressions.json（由 scripts/build-impressions.mjs 生成）。
// 文件不存在就回 exists:false + 空列表，前端显示「还没归纳过」，不当错误。
function buildImpressionsView(deps) {
    const file = (0, deps.path).join(deps.STATE_DIR, 'impressions.json');
    let raw = null;
    try { raw = JSON.parse((0, deps.fs).readFileSync(file, 'utf8')); } catch { raw = null; }
    const peopleRaw = raw && raw.people && typeof raw.people === 'object' ? raw.people : {};
    // 证据锚点是 {key,seq}：给前端一个可读的会话名，方便点开对照。拿不到就退回原 key。
    const keyLabel = (key) => {
        try { return String(((0, deps.sessionLabel)(key) || {}).label || key || ''); } catch { return String(key || ''); }
    };
    const people = [];
    for (const [qq, value] of Object.entries(peopleRaw)) {
        if (!value || typeof value !== 'object') continue;
        const evidence = Array.isArray(value.evidence) ? value.evidence.slice(0, 5).map((item) => ({
            key: String(item && item.key || ''),
            keyLabel: keyLabel(String(item && item.key || '')),
            seq: Number(item && item.seq) || 0
        })) : [];
        people.push({
            userId: String(value.userId || qq),
            name: String(value.name || ''),
            impression: String(value.impression || ''),
            tags: Array.isArray(value.tags) ? value.tags.slice(0, 8).map(String) : [],
            evidence,
            evidenceCount: Number(value.evidenceCount) || evidence.length,
            updatedAt: Number(value.updatedAt) || 0
        });
    }
    people.sort((a, b) => b.evidenceCount - a.evidenceCount);
    return {
        ok: true,
        exists: Boolean(raw),
        generatedAt: Number(raw && raw.generatedAt) || 0,
        window: (raw && raw.window) || null,
        meta: (raw && raw.meta) || {},
        count: people.length,
        people
    };
}

export function createConsoleMemory(deps) {
// @bridge-function handleConsoleMemory:start
async function handleConsoleMemory(request) {
        if (request.req.method === 'GET' && request.url.pathname === '/api/memory/overview') {
          request.sendJson(buildMemoryOverview(deps));
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/impressions') {
          const view = buildImpressionsView(deps);
          // D1：带上「有没有在跑 / 上次什么时候跑的 / 下次自动归纳在什么时候」，按钮据此显示进度。
          view.run = deps.impressionRunner ? deps.impressionRunner.status() : null;
          request.sendJson(view);
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/impressions/rebuild') {
          // D1：点「立即归纳」→ 后台 spawn 一轮 CLI（不阻塞请求，跑完自己写 state/impressions.json）。
          const runner = deps.impressionRunner;
          if (!runner) { request.sendJson({ ok: false, error: '归纳运行器未就绪' }, 503); return true; /* @bridge-handled */ }
          const result = runner.startRun('console');
          if (!result.ok) {
            request.sendJson({ ok: false, busy: Boolean(result.busy), error: result.busy ? '已经有一轮在跑，等它结束' : String(result.error || '启动失败'), run: result.status }, result.busy ? 409 : 500);
            return true; /* @bridge-handled */
          }
          request.sendJson({ ok: true, started: true, run: result.status });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/memory-append') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { request.sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { request.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; /* @bridge-handled */ }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { request.sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('memory')) { request.sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          (0, deps.appendMemoryV2)(st, category, content, extra);
          request.sendJson({ ok: true, key, category, content, memory: (0, deps.formatMemoryV2)(st) });
          return true; /* @bridge-handled */
        }
        // ── 私聊自定义人设：私聊对象可以给自己这个会话设一个运行时角色/人设 ──────────
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/set-persona') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          // key 格式与「只有私聊能设人设」这两条判定在 src/persona.js，便于单测覆盖。
          const keyError = (0, deps.personaKeyError)(key);
          if (keyError) { request.sendJson({ ok: false, error: keyError.error }, keyError.status); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('setPersona')) { request.sendJson({ ok: false, error: '工具未启用：qq_set_persona' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          const parsed = (0, deps.parsePersonaRequest)(body, (0, deps.personaMaxChars)(), deps.normalizeInitialPromptText);
          if (parsed.action === 'reset') {
            st.persona = null;
            (0, deps.saveSocialV2State)();
            request.sendJson({ ok: true, key, persona: null, reset: true });
            return true; /* @bridge-handled */
          }
          if (parsed.action === 'error') { request.sendJson({ ok: false, error: parsed.error }, parsed.status); return true; /* @bridge-handled */ }
          st.persona = { text: parsed.text, setAt: Date.now() };
          (0, deps.saveSocialV2State)();
          request.sendJson({ ok: true, key, persona: { text: parsed.text, setAt: st.persona.setAt, maxChars: (0, deps.personaMaxChars)() } });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/memory-update') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = (0, deps.redactKnownTokensOnly)(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? (0, deps.redactKnownTokensOnly)(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => (0, deps.redactKnownTokensOnly)(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { request.sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { request.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; /* @bridge-handled */ }
          if (category === 'memberImpression' && !target) { request.sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return true; /* @bridge-handled */ }
          if (category !== 'memberImpression' && !oldContent) { request.sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('memory')) { request.sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          // 印象编辑的最终落点（改名后是新名字），供下面并入跨会话全局表时使用。
          // 这个路由作用域里没有 extra（那是 memory-append 的变量），别再引用它。
          let impressionTarget = '';
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { request.sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return true; /* @bridge-handled */ }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { request.sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return true; /* @bridge-handled */ }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            // 改名 / 就地更新 / 拒绝（找不到、非法名字）全在纯函数里，见 memory-layers.js。
            const edit = (0, deps.applyImpressionEdit)(st.memberImpressions, {
              oldTarget: target,
              newTarget: cleanNewExtra.target,
              traits: newContent !== undefined ? newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20) : undefined,
              interactionCount: cleanNewExtra.interactionCount,
              // 保持本路由原有的 50 条上限（全局表是 200，两个上限不要混）。
              maxNames: 50
            });
            if (!edit.ok) { request.sendJson({ ok: false, error: edit.error }, edit.status); return true; /* @bridge-handled */ }
            impressionTarget = edit.target;
          }
          // 印象类记忆同时并入跨会话全局表（群聊/私聊共享同一份对人的认知）。
          if (category === 'memberImpression') {
            // 用编辑后的真实落点（改名时是新名字）：以前这里误用另一个路由才有的 extra，
            // 抛 ReferenceError → 500 → saveSocialV2State 永不执行、跨会话合并成死代码。
            const entry = impressionTarget ? st.memberImpressions?.[impressionTarget] : null;
            if (impressionTarget && entry) {
              (0, deps.mergeImpression)(deps.socialV2.globalImpressions, impressionTarget, {
                traits: entry.traits,
                interactionCount: 0,
                lastSeenAt: Number(entry.lastSeenAt) || Date.now()
              });
            }
          }
          (0, deps.saveSocialV2State)();
          request.sendJson({ ok: true, key, category, memory: (0, deps.formatMemoryV2)(st) });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/memory') {
          const key = String(request.url.searchParams.get('key') ?? '').trim();
          const category = String(request.url.searchParams.get('category') ?? '').trim();
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('memory')) { request.sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          request.sendJson({ ok: true, key, category, formatted: (0, deps.formatMemoryV2)({ ...st, ...raw }), raw });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/memory-remove') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { request.sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { request.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; /* @bridge-handled */ }
          if (category === 'memberImpression' && !target) { request.sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return true; /* @bridge-handled */ }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { request.sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; /* @bridge-handled */ }
          if (category !== 'memberImpression' && !content) { request.sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('memory')) { request.sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          (0, deps.saveSocialV2State)();
          request.sendJson({ ok: true, key, category, memory: (0, deps.formatMemoryV2)(st) });
          return true; /* @bridge-handled */
        }
        // 共享事件记忆：记录「一起经历过的事」，跨会话可见（scope: global | group:xxx）。
        if (request.url.pathname === '/api/socialV2/memory-event') {
          const keyParam = String(request.url.searchParams.get('key') ?? '').trim();
          if (request.req.method === 'GET') {
            if (keyParam && request.req.headers['x-agent-token'] && !request.agentTokenOk(keyParam, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
            const limit = Math.min(Math.max(Number(request.url.searchParams.get('limit')) || 20, 1), 100);
            const visible = deps.socialV2.sharedEvents
              .map((e) => ({ e, score: (0, deps.selectEventsForInjection)([e], { key: keyParam }).picked.length ? 1 : 0 }))
              .filter((x) => !keyParam || x.score > 0 || x.e.scope === 'global')
              .map((x) => x.e)
              .slice(-limit)
              .reverse();
            request.sendJson({ ok: true, count: visible.length, events: visible });
            return true; /* @bridge-handled */
          }
          const body = await request.readBody();
          const action = String(body.action ?? 'add').trim();
          const key = String(body.key ?? keyParam).trim();
          if (key && request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (key && request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('memory')) { request.sendJson({ ok: false, error: '工具未启用：qq_memory_event' }, 403); return true; /* @bridge-handled */ }
          if (action === 'add') {
            const text = String(body.text ?? '').trim();
            if (!text) { request.sendJson({ ok: false, error: 'text 不能为空' }, 400); return true; /* @bridge-handled */ }
            const scope = String(body.scope ?? (key.startsWith('group:') ? key : 'global')).trim();
            if (scope !== 'global' && !/^(group|private):\d+$/.test(scope)) { request.sendJson({ ok: false, error: 'scope 必须是 global 或 group:群号' }, 400); return true; /* @bridge-handled */ }
            const event = (0, deps.addSharedEvent)(deps.socialV2.sharedEvents, { text, scope, by: body.by, key });
            (0, deps.saveSocialV2State)();
            request.sendJson({ ok: true, event, count: deps.socialV2.sharedEvents.length });
            return true; /* @bridge-handled */
          }
          if (action === 'remove') {
            const id = String(body.id ?? '').trim();
            const text = String(body.text ?? '').trim();
            const before = deps.socialV2.sharedEvents.length;
            deps.socialV2.sharedEvents = deps.socialV2.sharedEvents.filter((e) => (id ? e.id !== id : !text || !String(e.text).includes(text)));
            (0, deps.saveSocialV2State)();
            request.sendJson({ ok: true, removed: before - deps.socialV2.sharedEvents.length });
            return true; /* @bridge-handled */
          }
          request.sendJson({ ok: false, error: 'action 必须是 add / remove / list' }, 400);
          return true; /* @bridge-handled */
        }

        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/memory-clear') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { request.sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('memory')) { request.sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') {
            // 就地把键删掉而不是换一个新对象：`st.memberImpressions = {}` 会让
            // 别处已捕获的旧引用继续往一张看不见的表里写（方案截图里踩过的坑）。
            if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
            for (const n of Object.keys(st.memberImpressions)) delete st.memberImpressions[n];
          }
          (0, deps.saveSocialV2State)();
          request.sendJson({ ok: true, key, category: category || 'all', memory: (0, deps.formatMemoryV2)(st) });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleMemory:end
  return { handleConsoleMemory };
}
