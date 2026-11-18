// console/slang-tools: extracted bridge responsibilities; no startup side effects.
// Live dependencies: SLANG_STATUS, allowSlangSubmit, appendActivity, buildSlangContext, cfg, confirmedSlangListV2, createSlangEntry, log, mergeEvidence, publicSlangEntry, queueSlangTask, redactKnownTokensOnly, runSlangResearch, saveSlangStore, slangEntries, v2ToolEnabled
export function createConsoleSlangTools(deps) {
// @bridge-function handleConsoleSlangTools:start
async function handleConsoleSlangTools(request) {
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/slang/query') {
          const key = String(request.url.searchParams.get('key') ?? '').trim();
          const q = String(request.url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('slangQuery')) { request.sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return true; /* @bridge-handled */ }
          const list = (0, deps.confirmedSlangListV2)().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          request.sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: (0, deps.buildSlangContext)(deps.slangEntries, deps.cfg.slang?.injectMax ?? 8)
          });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/slang/submit') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = (0, deps.redactKnownTokensOnly)(String(body.content ?? '')).trim();
          const context = (0, deps.redactKnownTokensOnly)(String(body.context ?? '')).trim();
          // AI 可带上网查到的释义；一律只存「听懂」档，升权必须人工确认。
          const meaning = (0, deps.redactKnownTokensOnly)(String(body.meaning ?? '')).trim().slice(0, 200);
          const usage = (0, deps.redactKnownTokensOnly)(String(body.usage ?? '')).trim().slice(0, 100);
          const example = (0, deps.redactKnownTokensOnly)(String(body.example ?? '')).trim().slice(0, 100);
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('slangSubmit')) { request.sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return true; /* @bridge-handled */ }
          if (deps.cfg.slang?.enabled === false) { request.sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return true; /* @bridge-handled */ }
          if (!content) { request.sendJson({ ok: false, error: 'content 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (content.length > 50) { request.sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return true; /* @bridge-handled */ }
          if (!(0, deps.allowSlangSubmit)(key)) { request.sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return true; /* @bridge-handled */ }
          const existing = deps.slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === deps.SLANG_STATUS.CONFIRMED) {
              request.sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: (0, deps.publicSlangEntry)(existing) });
              return true; /* @bridge-handled */
            }
            if (existing.status === deps.SLANG_STATUS.REJECTED) {
              request.sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return true; /* @bridge-handled */
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = (0, deps.mergeEvidence)(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            (0, deps.saveSlangStore)();
            if (deps.cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(deps.cfg.slang?.inferenceThresholds) ? deps.cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [1, 3, 6];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                (0, deps.queueSlangTask)(() => (0, deps.runSlangResearch)([existing]));
              }
            }
            (0, deps.log)(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            request.sendJson({ ok: true, duplicate: true, status: 'candidate', entry: (0, deps.publicSlangEntry)(existing) });
            return true; /* @bridge-handled */
          }
          const entry = (0, deps.createSlangEntry)({ usagePolicy: 'understand-only', meaning, usage, example, source: 'ai-research',
            content,
            status: deps.SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          deps.slangEntries.push(entry);
          (0, deps.saveSlangStore)();
          if (deps.cfg.slang?.autoResearch !== false) {
            (0, deps.queueSlangTask)(() => (0, deps.runSlangResearch)([entry]));
          }
          (0, deps.log)(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          (0, deps.appendActivity)(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          request.sendJson({ ok: true, entry: (0, deps.publicSlangEntry)(entry) });
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleSlangTools:end
  return { handleConsoleSlangTools };
}
