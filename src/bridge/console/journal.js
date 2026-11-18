// console/journal: extracted bridge responsibilities; no startup side effects.
// Live dependencies: FEEDBACK_FILE, TOOL_LOG_FILE, appendActivity, appendFeedbackEntry, atomicWriteJson, cfg, feedbackTimes, fs, getSocialV2State, log, priceTable, readFeedbackEntries, readThroughSeqV2, readToolLog, tokenLedger, truncateText, v2ToolEnabled
export function createConsoleJournal(deps) {
// @bridge-function handleConsoleJournal:start
async function handleConsoleJournal(request) {
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (request.url.pathname === '/api/tokens/summary' || request.url.pathname.startsWith('/api/tokens/')) {
          if (request.req.headers['x-agent-token']) { request.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; /* @bridge-handled */ }
          if (request.req.method === 'GET' && request.url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(request.url.searchParams.get('limit')) || 200));
            request.sendJson({ ...deps.tokenLedger.summary({ limit }), ledger: deps.tokenLedger.stats() });
            return true; /* @bridge-handled */
          }
          // 按 provider / 计费口径（billed = cacheMiss + output）。用户要和 WorkBuddy 后台
          // 的账单对齐：raw 里 96%+ 是 cacheHit（通常不计费），不能只报 raw。
          if (request.req.method === 'GET' && request.url.pathname === '/api/tokens/providers') {
            const RANGES = ['today', '7d', '30d', 'all'];
            const range = String(request.url.searchParams.get('range') ?? 'today').trim() || 'today';
            if (!RANGES.includes(range)) { request.sendJson({ ok: false, error: `range 只支持 ${RANGES.join(' / ')}` }, 400); return true; /* @bridge-handled */ }
            const basis = String(request.url.searchParams.get('basis') ?? 'billed').trim() || 'billed';
            if (basis !== 'billed' && basis !== 'raw') { request.sendJson({ ok: false, error: 'basis 只支持 billed 或 raw' }, 400); return true; /* @bridge-handled */ }
            // 前端「全部群」下拉传的是字面量 all（中文界面也可能是「全部群」）：视为不筛选，
            // 与 /api/tokens/tools?key=all 同口径；只有真实 sessionKey 才过滤（大小写不敏感）。
            const rawKey = String(request.url.searchParams.get('key') ?? '').trim();
            const key = !rawKey || ['all', '全部群'].includes(rawKey.toLowerCase()) ? '' : rawKey;
            const win = deps.tokenProvidersPure.providerRangeWindow(range);
            const samples = deps.tokenLedger.samplesSince({ from: win.from, to: win.to, key });
            const agg = deps.tokenProvidersPure.aggregateProviderDays(samples, { from: win.from, to: win.to, key, basis });
            request.sendJson({ ok: true, range: { range, from: win.from, to: win.to, days: win.days, key }, basis, from: win.from, to: win.to, total: agg.total, providers: agg.providers, note: '按 provider 归集；billed = cacheMiss + output；cacheHit（缓存命中）通常不计费' });
            return true; /* @bridge-handled */
          }
          if (request.req.method === 'GET' && request.url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(request.url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(request.url.searchParams.get('buckets')) || 48));
            request.sendJson(deps.tokenLedger.series({ hours, maxBuckets }));
            return true; /* @bridge-handled */
          }
          if (request.req.method === 'GET' && request.url.pathname === '/api/tokens/turns') {
            const key = String(request.url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(request.url.searchParams.get('limit')) || 200));
            const detail = deps.tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { request.sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return true; /* @bridge-handled */ }
            request.sendJson(detail);
            return true; /* @bridge-handled */
          }
          if (request.req.method === 'GET' && request.url.pathname === '/api/tokens/today') {
            request.sendJson({ ok: true, ...deps.tokenLedger.todayByKey() });
            return true; /* @bridge-handled */
          }
          if (request.req.method === 'GET' && request.url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(request.url.searchParams.get('limit')) || 50));
            request.sendJson({ ok: true, symbol: deps.priceTable.symbol, entries: deps.tokenLedger.recent(limit) });
            return true; /* @bridge-handled */
          }
          if (request.req.method === 'POST' && request.url.pathname === '/api/tokens/reset') {
            deps.tokenLedger.reset();
            (0, deps.log)('控制台：token 用量账本已重置');
            request.sendJson({ ok: true });
            return true; /* @bridge-handled */
          }
          request.sendJson({ ok: false, error: 'not found' }, 404);
          return true; /* @bridge-handled */
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(request.url.searchParams.get('limit')) || 200));
          request.sendJson({ ok: true, entries: (0, deps.readToolLog)(limit) });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/tool-log/clear') {
          if (request.req.headers['x-agent-token']) { request.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; /* @bridge-handled */ }
          try { deps.fs.writeFileSync(deps.TOOL_LOG_FILE, '', 'utf8'); } catch {}
          (0, deps.log)('控制台：工具调用日志已清空');
          request.sendJson({ ok: true });
          return true; /* @bridge-handled */
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/feedback') {
          request.sendJson({ ok: true, entries: (0, deps.readFeedbackEntries)() });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/feedback-clear') {
          if (request.req.headers['x-agent-token']) { request.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; /* @bridge-handled */ }
          (0, deps.atomicWriteJson)(deps.FEEDBACK_FILE, []);
          (0, deps.log)('控制台：清空 AI 反馈');
          request.sendJson({ ok: true });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/feedback') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { request.sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('feedback')) { request.sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return true; /* @bridge-handled */ }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = deps.feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            request.sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return true; /* @bridge-handled */
          }
          fTimes.push(fNow);
          deps.feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(deps.cfg.socialV2?.feedback?.maxLength) || 500);
          const message = (0, deps.truncateText)(rawMessage, maxLength);
          (0, deps.appendFeedbackEntry)({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          (0, deps.log)(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          (0, deps.appendActivity)(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (deps.cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && deps.cfg.ownerQQ) {
            (0, deps.log)(`[reserved2] 错误级反馈，可通知 owner ${deps.cfg.ownerQQ}（当前仅记录日志）`);
          }
          request.sendJson({ ok: true, key, level, message });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'GET' && request.url.pathname === '/api/socialV2/my-recent') {
          const key = String(request.url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(request.url.searchParams.get('limit')) || 10));
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('getMyRecent')) { request.sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          request.sendJson({ ok: true, key, messages: mine, readThroughSeq: (0, deps.readThroughSeqV2)(st) });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          request.sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleJournal:end
  return { handleConsoleJournal };
}
