// context-services: extracted bridge responsibilities; no startup side effects.
// Live dependencies: VISION_MODELS_DEFAULT, api, archiveFactsByKey, buildDigest, cfg, digestCounters, formatArchiveFactsBlock, isArchiveGroup, log, noteMediaTurn, recentMediaTurns, saveSocialV2State, shouldRefreshDigest, socialV2
export function createContextServices(deps) {
// @bridge-function pushArchiveFacts:start
function pushArchiveFacts(key, facts) {
    if (!Array.isArray(facts) || !facts.length) return;
    const list = deps.archiveFactsByKey.get(key) ?? [];
    for (const fact of facts) if (fact && fact.status) list.push(fact);
    // 有界：一批消息最多留 20 条，防止刷屏积压无限增长。
    while (list.length > 20) list.shift();
    deps.archiveFactsByKey.set(key, list);
  }
// @bridge-function pushArchiveFacts:end

// @bridge-function withArchiveFactsHint:start
function withArchiveFactsHint(key, promptText) {
    const matched = /^group:(\d+)$/.exec(String(key ?? ''));
    if (!matched) return promptText;
    const facts = deps.archiveFactsByKey.get(key) ?? [];
    deps.archiveFactsByKey.delete(key);
    const block = (0, deps.formatArchiveFactsBlock)({
      isWhitelisted: (0, deps.isArchiveGroup)(deps.cfg.fileArchive, matched[1]),
      // 把当前口径一起给出去：用户改了规则后，模型对「会转什么」的说法才不会与事实脱节。
      rules: deps.cfg.fileArchive?.rules,
      facts
    });
    return `${promptText}\n\n${block}`;
  }
// @bridge-function withArchiveFactsHint:end

// @bridge-function fetchModelCatalog:start
async function fetchModelCatalog() {
    try {
      return await deps.api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return deps.api.callUnary('session.models', {});
    }
  }
// @bridge-function fetchModelCatalog:end

// @bridge-function maybeRefreshDigest:start
function maybeRefreshDigest(key, st) {
    const cfgM = deps.cfg.socialV2?.memory?.crossSession ?? {};
    if (cfgM.enabled === false) return;
    const every = Math.max(5, Number(cfgM.everyMessages) || 20);
    const n = (deps.digestCounters.get(key) || 0) + 1;
    deps.digestCounters.set(key, n);
    const lastAt = Number(deps.socialV2.digests?.[key]?.at) || 0;
    const verdict = (0, deps.shouldRefreshDigest)({
      count: n,
      lastAt,
      everyMessages: every,
      maxAgeMs: Math.max(5 * 60 * 1000, Number(cfgM.refreshMaxAgeMs) || 2 * 3600 * 1000)
    });
    if (!verdict.refresh) return;
    try {
      const d = (0, deps.buildDigest)({ key, messages: st.recentMessages, maxChars: Number(cfgM.maxChars) || 200 });
      if (!d) return;
      deps.socialV2.digests = deps.socialV2.digests && typeof deps.socialV2.digests === 'object' ? deps.socialV2.digests : {};
      deps.socialV2.digests[key] = d;
      // 顺带把 digest 启发式提取的话题写入 activeTopics（复用 n-gram 结果，零额外 LLM 调用）。
      // 话题记忆不再依赖 AI 主动调 qq_memory 工具（过去几乎从没触发，8 会话常年只有 1 条）。
      if (st && Array.isArray(d.topics) && d.topics.length) {
        if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
        for (const t of d.topics.slice(0, 2)) {
          const topic = String(t || "").trim().slice(0, 200);
          if (!topic) continue;
          const existing = st.activeTopics.find((x) => x && String(x.text || "") === topic);
          if (existing) { existing.lastMentionAt = Date.now(); }
          else st.activeTopics.push({ text: topic, lastMentionAt: Date.now(), participants: (Array.isArray(d.people) ? d.people : []).slice(0, 10), pendingQuestion: "" });
        }
        if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
      }
      (0, deps.saveSocialV2State)();
      if (verdict.why === 'age') deps.digestCounters.set(key, 0); // 按年龄重建后计数归零，别紧接着又按条数重建一次
    } catch (error) { (0, deps.log)(`[跨会话] 摘要刷新失败（不影响回复）：${error?.message ?? error}`); }
  }
// @bridge-function maybeRefreshDigest:end

// @bridge-function sttInlineWaitMs:start
function sttInlineWaitMs() {
    const raw = deps.cfg.socialV2?.stt?.inlineWaitMs;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(30000, Math.round(n));
    return 6000;
  }
// @bridge-function sttInlineWaitMs:end

// @bridge-function visionModels:start
function visionModels() {
    const list = deps.cfg.dsh?.visionModels;
    return Array.isArray(list) && list.length ? list.map((x) => String(x)) : deps.VISION_MODELS_DEFAULT;
  }
// @bridge-function visionModels:end

// @bridge-function modelSeesImages:start
function modelSeesImages(provider, model, meta) {
    if (meta && typeof meta.supportsImages === 'boolean') return meta.supportsImages;
    const m = String(model ?? '');
    const bare = m.replace(/^(?:cn|global):/i, '');
    // workbuddy2api 反代的模型 96% supports_images=true（wb2api /v1/models 实测 129/135），
    // 但 DSH 的 session.modelCatalog 不透传该字段 → 对合池 provider 默认按「能看图」处理，
    // 仅排除已知的纯文本模型（deepseek-r1 / deepseek-v3 / wb-lite）。
    if (/workbuddy/i.test(String(provider ?? ''))) {
      return !/^(?:deepseek-r1|deepseek-v3|wb-lite)(?:-|$)/i.test(bare);
    }
    const hit = visionModels().some((v) => v === m || v === bare || bare.startsWith(`${v}-`));
    return hit;
  }
// @bridge-function modelSeesImages:end

// @bridge-function markMediaTurn:start
function markMediaTurn(key) {
    if (!key) return;
    try { (0, deps.noteMediaTurn)(deps.recentMediaTurns, key); } catch {}
    try {
      const st = deps.socialV2.conversations.get(key);
      if (st) st.lastMediaAt = Date.now();
    } catch {}
  }
// @bridge-function markMediaTurn:end

// @bridge-function withMemoryContext:start
function withMemoryContext(key, text, promptText) {
    const cfgM = (deps.cfg.socialV2 && deps.cfg.socialV2.memory && deps.cfg.socialV2.memory.recall) || {};
    if (cfgM.enabled === false) return promptText;
    const q = String(text || '').trim();
    const maxItems = Math.max(1, Math.min(12, Number(cfgM.maxItems) || 6));
    const maxChars = Math.max(200, Math.min(2400, Number(cfgM.maxChars) || 900));
    const now = Date.now();
    const isGroup = /^group:/.test(String(key || ''));
    const cand = [];
    try {
      const d = deps.socialV2 && deps.socialV2.digests && deps.socialV2.digests[key];
      if (d && d.summary) cand.push({ score: 0.55, text: '[' + '上次聊到 · ' + fmtDay(d.at) + '] ' + clip(d.summary, 120) });
      const st = deps.socialV2 && deps.socialV2.conversations && deps.socialV2.conversations.get(key);
      if (st && Array.isArray(st.activeTopics)) {
        for (const t of st.activeTopics.filter((x) => x && typeof x.text === 'string'
        && x.text.trim().length >= 4 && !/^[a-zA-Z0-9\s\-_]+$/.test(x.text.trim()))
        .slice(-5).slice(0, 2)) {
          const age = (now - (Number(t.lastMentionAt) || now)) / 86400000;
          cand.push({ score: 0.65 * Math.exp(-age / 7), text: '[' + '近期话题 · ' + fmtDay(t.lastMentionAt) + '] ' + clip(t.text, 120) });
        }
      }
      // 4) 群友档案（impressions.json 的 memories）：只带本会话最近活跃的人，避免整份档案泄进上下文
      try {
        const imp = deps.impressionsLoad && deps.impressionsLoad();
        const people = imp && imp.people;
        const st2 = deps.socialV2 && deps.socialV2.conversations && deps.socialV2.conversations.get(key);
        const recent2 = st2 && Array.isArray(st2.recentMessages) ? st2.recentMessages : [];
        const activeNames = new Set();
        for (const m of recent2.slice(-8)) {
          if (m && !m.isSelf) { const nm = String(m.sender || '').trim(); if (nm) activeNames.add(nm); }
        }
        if (people && (activeNames.size || q.length >= 2)) {
          for (const userId of Object.keys(people)) {
            if (cand.length > maxItems * 3) break;
            const p = people[userId];
            if (!p || !Array.isArray(p.memories) || !p.memories.length) continue;
            const pname = String(p.name || '').trim();
            if (!activeNames.has(pname) && !(q.length >= 2 && pname && q.includes(pname))) continue;
            for (const mem of p.memories.slice(0, 3)) {
              if (!mem || !mem.content) continue;
              const age = (now - (Number(mem.at) || now)) / 86400000;
              const w = (Number(mem.importance) || 0.5) * Math.exp(-age / 90);
              const kindText = mem.kind === 'event' ? '经历过' : mem.kind === 'preference' ? '偏好' : mem.kind === 'promise' ? '约定' : '档案';
              cand.push({ score: 0.75 * w, text: '[' + (pname || userId) + ' · ' + kindText + '] ' + clip(mem.content, 80) });
            }
          }
        }
      } catch {}
      const db = typeof deps.messageDb === 'function' ? deps.messageDb() : deps.messageDb;
      if (q.length >= 2 && db && typeof deps.searchMessages === 'function') {
        // 整句当 FTS 查询几乎永远 0 结果（"上班累就摸鱼" 不是数据库里的词），
        // 拆成关键词分别检索，再按「命中几个词」合并排序。
        const terms = [...entityTokens(q)].filter((t) => t.length >= 2).slice(0, 6);
        if (!terms.length) terms.push(q.slice(0, 8));
        const hitMap = new Map();
        for (const t of terms) {
          let part = [];
          try { part = deps.searchMessages(db, { key, q: t, limit: maxItems, sinceMs: now - 30 * 86400000 }).rows || []; } catch { part = []; } // 必须带 key：全库检索会让私聊读到别人的原话
          for (const r of part) {
            const rk = String(r.key || '');
            if (isGroup && rk.startsWith('private:')) continue;
            const id = r.id ?? r.message_id ?? (rk + '|' + r.ts + '|' + String(r.text || '').slice(0, 12));
            const prev = hitMap.get(id);
            if (prev) { prev.hits += 1; continue; }
            hitMap.set(id, { r, hits: 1 });
          }
        }
        const merged = [...hitMap.values()].sort((a, b) => b.hits - a.hits).slice(0, maxItems * 3);
        for (const { r, hits } of merged) {
          const age = (now - (Number(r.ts) || now)) / 86400000;
          const who = r.is_self ? '我' : (r.sender || '有人');
          cand.push({ score: (0.7 + 0.12 * Math.min(hits, 3)) * Math.exp(-age / 14), kw: true, text: '[' + '历史 · ' + fmtDay(r.ts) + '] ' + who + ' 说过：' + clip(r.text, 60) });
        }
      }
      // 5) 语义召回（向量）：只有调用方预热过 query 向量（memoryVector.embedQuery）才有结果，
      //    没预热时返回 null，这里直接跳过，绝不因为向量没准备好而拖慢投递
      try {
        const mv = deps.memoryVector;
        if (mv && typeof mv.semanticSearchSync === 'function') {
          const hit = mv.semanticSearchSync(q, key, maxItems);
          if (Array.isArray(hit)) {
            for (const r of hit) {
              if (isGroup && String(r.key || '').startsWith('private:')) continue;
              cand.push({ score: 0.35 * (Number(r.sim) || 0) * Math.exp(-(Number(r.age) || 0) / 30), sem: Number(r.sim) || 0, text: '[' + '语义 · ' + fmtDay(r.ts) + '] ' + r.sender + ' 说过：' + clip(r.text, 60) });
            }
          }
        }
      } catch {}
    } catch (error) {
      (0, deps.log)('[记忆] 检索失败（不影响回复）：' + (error && error.message ? error.message : error));
      return promptText;
    }
    if (!cand.length) return promptText;
    // 实体匹配加权：查询里的词（中文 2-gram / 英文词）与候选文本重合越多越靠前
    const qEnt = entityTokens(q);
    if (qEnt.size) {
      for (const c of cand) c.score += 0.2 * entityScore(qEnt, entityTokens(c.text));
    }
    cand.sort((a, b) => b.score - a.score);
    // 去重：同一句话可能来自关键词与语义两路，或群友连发同一句（[表情13]×2），
    // 重复内容会白占席位。按「去掉来源标签后的正文」判重，保留分高的一条。
    const seenText = new Set();
    const uniq = [];
    for (const c of cand) {
      const kk = String(c.text).replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, '').slice(0, 40);
      if (seenText.has(kk)) continue;
      seenText.add(kk);
      uniq.push(c);
    }
    const picked = [];
    let used = 0;
    for (const c of uniq) {
      if (picked.length >= maxItems) break;
      if (used + c.text.length > maxChars) break;
      picked.push(c.text);
      used += c.text.length + 1;
    }
    if (!picked.length) return promptText;
    // 语义召回保底一条：跨措辞的记忆（sim≥0.72）说明「换了说法但确实是同一件事」，
    // 这类信息最容易被高分候选挤掉，单独留一个席位，最多替换掉排名最后的一条。
    if (cand.length) {
      const semList = uniq.filter((c) => Number(c.sem) >= 0.72).sort((a, b) => b.sem - a.sem);
      const best = semList[0];
      if (best && !picked.includes(best.text)) {
        if (picked.length >= maxItems) picked[picked.length - 1] = best.text;
        else if (used + best.text.length <= maxChars) picked.push(best.text);
      }
    }
    // 关键词命中保底：摘要+话题是「固定背景」，若它们把席位占满，检索就形同虚设。
    // 查询词确实在历史消息里出现过时，至少保留 2 条命中（去重后按分数取）。
    const kwList = uniq.filter((c) => c.kw && !picked.includes(c.text)).slice(0, 2);
    for (let i = kwList.length - 1; i >= 0; i -= 1) {
      const kw = kwList[i];
      if (picked.length >= maxItems) picked[picked.length - 1] = kw.text;
      else if (used + kw.text.length <= maxChars) { picked.push(kw.text); used += kw.text.length + 1; }
    }
    (0, deps.log)(`[记忆] 注入 ${picked.length} 条 / ${used} 字`);
    return promptText + '\n\n【相关记忆】\n' + picked.map((x) => '- ' + x).join('\n');
  }

// 实体特征：中文 2-gram + 英文/数字词，用于相关性加权（等价于「实体匹配」项）
const ENTITY_STOP = new Set(['这个', '那个', '什么', '怎么', '就是', '可以', '不是', '他们', '我们', '你们', '自己', '时候', '现在', '今天', '明天', '昨天', '一下', '这样', '那样', '知道', '觉得', '应该', '还是', '因为', '所以', '但是', '如果', '然后', '还有', '已经', '没有', '这么', '那么', '真的', '可能', '需要', '问题', '东西', '事情', '地方', '一个', '有点', '比较', '非常', '特别', '其实', '当然', '确实', '感觉', '说的', '说过', '上次', '这次', '历史', '记忆', '档案', '偏好', '经历', '约定', '话题', '聊到', '相关', '最近', '之前', '以后', '现在', '大家', '有人', '我的', '你的', '他的']);
function entityTokens(text) {
  const out = new Set();
  const s = String(text || '');
  const cn = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of cn) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const w = seg.slice(i, i + 2);
      if (!ENTITY_STOP.has(w)) out.add(w);
    }
  }
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_]{2,}/g)) out.add(m[0].toLowerCase());
  return out;
}
function entityScore(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

function fmtDay(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '未知时间';
    const d = new Date(n);
    return (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0');
  }

function clip(s, n) {
    const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
// @bridge-function withMemoryContext:end

  return { pushArchiveFacts, withArchiveFactsHint, withMemoryContext, fetchModelCatalog, maybeRefreshDigest, sttInlineWaitMs, visionModels, modelSeesImages, markMediaTurn };
}
