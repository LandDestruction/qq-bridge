// console/slang: extracted bridge responsibilities; no startup side effects.
// Live dependencies: SLANG_STATUS, cfg, createSlangEntry, log, saveSlangStore, slangEntries, slangExtractionCooldowns, slangResearchingIds, slangStoreWritable, slangSubmitTimes, slangWindows
// 黑话「预选」：把候选里**已经有含义、有语境、风险不高**的词挑出来，供人批量过。
//
// 为什么单独一层：候选有 500+ 条，逐条点「确认」不现实，但也不能闭眼全确认——
// 没含义的确认了也注不进上下文，带风险提示的确认了可能踩雷。所以先按可核对的硬信号
// （含义、证据、用法/例句、来源、出现次数、风险字段）分层，人只需要看「可批准」那一档。
// 纯函数：不读盘、不调 AI、不加分新请求，结果可单测。

export const PRESELECT_MIN_MEANING_CHARS = 2;
export const PRESELECT_MAX_CONTENT_CHARS = 16;
export const PRESELECT_READY_SCORE = 5;
export const PRESELECT_MAX_ITEMS = 500; // 实测候选里约 397 条「可批准」，一次给全，前端自己分页

// 风险信号：命中就降级到「需细看」，不直接排除（人还能自己判断）。
const RISK_RE = /慎用|敏感|贬义|攻击|辱骂|色情|政治|违法|封号|风险高|别用/;
const RISK_MAX_CHARS = 60;

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

function evidenceOf(entry) {
  return Array.isArray(entry.evidence) ? entry.evidence : [];
}

/** 单条评估：返回 { tier: 'ready'|'review'|'weak', score, reasons, risk }。 */
export function scoreSlangCandidate(entry) {
  const content = str(entry && entry.content).trim();
  const meaning = str(entry && entry.meaning).trim();
  const reasons = [];
  if (!meaning || meaning.length < PRESELECT_MIN_MEANING_CHARS) {
    return { tier: 'weak', score: -1, reasons: ['还没写含义（确认了也注不进上下文）'], risk: false };
  }
  if (content.length < 2) return { tier: 'weak', score: -1, reasons: ['词条太短，多半是噪声'], risk: false };
  if (content.length > PRESELECT_MAX_CONTENT_CHARS) {
    return { tier: 'weak', score: -1, reasons: ['词条过长，像一句话而不是黑话'], risk: false };
  }
  if (/^\d+$/.test(content)) return { tier: 'weak', score: -1, reasons: ['纯数字，不像黑话'], risk: false };
  if (/^[^\p{L}\p{N}]+$/u.test(content)) return { tier: 'weak', score: -1, reasons: ['纯符号，不像黑话'], risk: false };

  let score = 0;
  if (meaning.length >= 6) {
    score += 2;
    reasons.push('含义完整');
  } else {
    score += 1;
    reasons.push('含义偏短');
  }
  const evidence = evidenceOf(entry);
  if (evidence.length) {
    score += Math.min(3, evidence.length);
    reasons.push('有语境证据 ' + evidence.length + ' 条');
  }
  if (str(entry.usage).trim()) {
    score += 1;
    reasons.push('写了用法');
  }
  if (str(entry.example).trim()) {
    score += 1;
    reasons.push('有例句');
  }
  const source = str(entry.source);
  if (source === 'ai-research' || source === 'ai' || str(entry.basis).includes('research')) {
    score += 2;
    reasons.push('AI 研究过');
  }
  const count = Number(entry.count) || 0;
  if (count >= 2) {
    score += 1;
    reasons.push('群聊出现 ' + count + ' 次');
  }
  const riskText = str(entry.risk).trim();
  const risk = RISK_RE.test(riskText) || riskText.length > RISK_MAX_CHARS;
  if (risk) {
    score -= 3;
    reasons.push('带风险提示，需要人工确认');
  }
  const tier = risk ? 'review' : (score >= PRESELECT_READY_SCORE ? 'ready' : 'weak');
  return { tier, score, reasons, risk };
}

/**
 * 给整个库算预选清单。
 * 返回 { counts:{ready,review,weak,candidates}, entries:[{...entry, preselect:{tier,score,reasons,risk}}] }。
 * entries 只含 ready/review（weak 留在「候选」tab 里，不占预选的位置）。
 */
export function buildSlangPreselect(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const max = Number(options.max) > 0 ? Math.min(Number(options.max), PRESELECT_MAX_ITEMS) : PRESELECT_MAX_ITEMS;
  const counts = { ready: 0, review: 0, weak: 0, candidates: 0 };
  const ready = [];
  const review = [];
  for (const entry of list) {
    if (!entry || entry.status !== 'candidate') continue;
    counts.candidates += 1;
    const verdict = scoreSlangCandidate(entry);
    counts[verdict.tier] += 1;
    if (verdict.tier === 'ready') ready.push({ entry, verdict });
    else if (verdict.tier === 'review') review.push({ entry, verdict });
  }
  const byScore = (a, b) => b.verdict.score - a.verdict.score
    || (Number(b.entry.count) || 0) - (Number(a.entry.count) || 0)
    || str(a.entry.content).localeCompare(str(b.entry.content));
  ready.sort(byScore);
  review.sort(byScore);
  // 列表只回「审阅需要的字段」：证据正文可能很长（几百条 × 多条证据会拖到几 MB），
  // 这里给证据条数，要看原文再单条走 GET /api/slang（详情/编辑界面里本来就有）。
  const lean = ({ entry, verdict }) => ({
    id: entry.id,
    content: str(entry.content),
    meaning: str(entry.meaning),
    usage: str(entry.usage),
    example: str(entry.example),
    risk: str(entry.risk),
    status: entry.status,
    usagePolicy: str(entry.usagePolicy),
    source: str(entry.source),
    basis: str(entry.basis),
    count: Number(entry.count) || 0,
    evidenceCount: evidenceOf(entry).length,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    preselect: verdict
  });
  const picked = ready.concat(review).slice(0, max).map(lean);
  return { counts, entries: picked, max };
}

export function createConsoleSlang(deps) {
// @bridge-function handleConsoleSlang:start
async function handleConsoleSlang(request) {

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/slang') {
          const status = request.url.searchParams.get('status') || '';
          const list = status ? deps.slangEntries.filter((e) => e.status === status) : deps.slangEntries;
          request.sendJson({ entries: list, config: deps.cfg.slang, writable: deps.slangStoreWritable });
          return true; /* @bridge-handled */
        }
        // 预选：把候选里「有含义 + 有语境 + 风险不高」的挑出来供人批量过（纯函数，无副作用）。
        // 候选动辄几百条，逐条点确认不现实；但没含义的确认了也注不进上下文，所以先分层。
        if (request.req.method === 'GET' && request.url.pathname === '/api/slang/preselect') {
          const view = buildSlangPreselect(deps.slangEntries, {});
          request.sendJson({ ok: true, writable: deps.slangStoreWritable, ...view });
          return true; /* @bridge-handled */
        }
        // 黑话库升权/降权：只有人工（控制台）能把词从「听懂」升到「可以用」。
        if (request.req.method === 'POST' && request.url.pathname === '/api/slang/policy') {
          const body = await request.readBody();
          const content = String(body.content ?? '').trim();
          const policy = String(body.usagePolicy ?? '').trim();
          if (!content) { request.sendJson({ ok: false, error: 'content 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (!['usable', 'understand-only'].includes(policy)) { request.sendJson({ ok: false, error: 'usagePolicy 必须是 usable 或 understand-only' }, 400); return true; /* @bridge-handled */ }
          const entry = deps.slangEntries.find((e) => e.content === content);
          if (!entry) { request.sendJson({ ok: false, error: '找不到该词条' }, 404); return true; /* @bridge-handled */ }
          if (entry.status !== 'confirmed' && policy === 'usable') { request.sendJson({ ok: false, error: '未确认的词条不能升为可用（先在控制台确认）' }, 400); return true; /* @bridge-handled */ }
          entry.usagePolicy = policy;
          entry.policyUpdatedAt = new Date().toISOString();
          entry.policySource = 'console';
          (0, deps.saveSlangStore)();
          (0, deps.log)(`黑话库：${content} → ${policy}（控制台）`);
          request.sendJson({ ok: true, content, usagePolicy: policy });
          return true; /* @bridge-handled */
        }

        if (request.req.method === 'POST' && request.url.pathname === '/api/slang') {
          const body = await request.readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { request.sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; /* @bridge-handled */ }
          if (deps.slangEntries.some((e) => e.content === content)) { request.sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return true; /* @bridge-handled */ }
          const entry = (0, deps.createSlangEntry)({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === deps.SLANG_STATUS.CANDIDATE ? deps.SLANG_STATUS.CANDIDATE : deps.SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          deps.slangEntries.push(entry);
          (0, deps.saveSlangStore)();
          (0, deps.log)(`控制台：新增黑话「${content}」`);
          request.sendJson({ ok: true, entry });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/slang/clear') {
          const body = await request.readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![deps.SLANG_STATUS.CANDIDATE, deps.SLANG_STATUS.CONFIRMED, deps.SLANG_STATUS.REJECTED].includes(status)) {
            request.sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return true; /* @bridge-handled */
          }
          let removedCount = 0;
          if (status) {
            removedCount = deps.slangEntries.filter((e) => e.status === status).length;
            deps.slangEntries = deps.slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = deps.slangEntries.length;
            deps.slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            deps.slangWindows.clear();
            deps.slangExtractionCooldowns.clear();
            deps.slangSubmitTimes.clear();
            deps.slangResearchingIds.clear();
          }
          (0, deps.saveSlangStore)();
          (0, deps.log)(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          request.sendJson({ ok: true, removedCount });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/slang/batch-delete') {
          const body = await request.readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = deps.slangEntries.length;
            deps.slangEntries = deps.slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - deps.slangEntries.length;
            if (!removedCount) { request.sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return true; /* @bridge-handled */ }
            (0, deps.saveSlangStore)();
            (0, deps.log)(`控制台：批量删除黑话 ${removedCount} 条`);
            request.sendJson({ ok: true, removedCount });
            return true; /* @bridge-handled */
          }
          if (status && ![deps.SLANG_STATUS.CANDIDATE, deps.SLANG_STATUS.CONFIRMED, deps.SLANG_STATUS.REJECTED].includes(status)) {
            request.sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return true; /* @bridge-handled */
          }
          if (!status) { request.sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return true; /* @bridge-handled */ }
          const removedCount = deps.slangEntries.filter((e) => e.status === status).length;
          deps.slangEntries = deps.slangEntries.filter((e) => e.status !== status);
          (0, deps.saveSlangStore)();
          (0, deps.log)(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          request.sendJson({ ok: true, removedCount });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/slang/batch-confirm') {
          const body = await request.readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { request.sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return true; /* @bridge-handled */ }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = deps.slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = deps.slangEntries[idx];
            if (entry.status !== deps.SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = deps.SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) (0, deps.saveSlangStore)();
          (0, deps.log)(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          request.sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/slang/batch-reject') {
          const body = await request.readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { request.sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return true; /* @bridge-handled */ }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = deps.slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = deps.slangEntries[idx];
            if (entry.status === deps.SLANG_STATUS.REJECTED) continue;
            entry.status = deps.SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) (0, deps.saveSlangStore)();
          (0, deps.log)(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          request.sendJson({ ok: true, rejectedCount });
          return true; /* @bridge-handled */
        }
        const slangMatch = request.url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (request.req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = deps.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { request.sendJson({ ok: false, error: '黑话不存在' }, 404); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const entry = { ...deps.slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && deps.slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            request.sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return true; /* @bridge-handled */
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [deps.SLANG_STATUS.CANDIDATE, deps.SLANG_STATUS.CONFIRMED, deps.SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { request.sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; /* @bridge-handled */ }
          entry.updatedAt = new Date().toISOString();
          deps.slangEntries[idx] = entry;
          (0, deps.saveSlangStore)();
          (0, deps.log)(`控制台：更新黑话「${entry.content}」`);
          request.sendJson({ ok: true, entry });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = deps.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { request.sendJson({ ok: false, error: '黑话不存在' }, 404); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const entry = deps.slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            request.sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return true; /* @bridge-handled */
          }
          entry.status = deps.SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          (0, deps.saveSlangStore)();
          (0, deps.log)(`控制台：确认黑话「${entry.content}」`);
          request.sendJson({ ok: true, entry });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = deps.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { request.sendJson({ ok: false, error: '黑话不存在' }, 404); return true; /* @bridge-handled */ }
          const entry = deps.slangEntries[idx];
          entry.status = deps.SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          (0, deps.saveSlangStore)();
          (0, deps.log)(`控制台：拒绝黑话「${entry.content}」`);
          request.sendJson({ ok: true, entry });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = deps.slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { request.sendJson({ ok: false, error: '黑话不存在' }, 404); return true; /* @bridge-handled */ }
          const [removed] = deps.slangEntries.splice(idx, 1);
          (0, deps.saveSlangStore)();
          (0, deps.log)(`控制台：删除黑话「${removed.content}」`);
          request.sendJson({ ok: true, removed });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleSlang:end
  return { handleConsoleSlang };
}
