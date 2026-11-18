// console/models-affinity: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ROOT, activeModelOverride, affinityLoad, affinityOn, affinityShift, appliedModelBySession, applyModelScope, atomicWriteJson, buildSelfModelPayload, canonicalV2Key, cfg, checkModelAgainstList, currentMode, describeLocalFallback, inPeakWindow, lastModelFailureNotifyAt, listAvailableModels, listForConsole, localCfgNow, localFallbackState, log, modelSelectionEpoch, normalizeModelRef, normalizeRouting, path, peakCfg, peakPauseActive, probeAvailableModels, readConfigObject, readModelScopes, reloadConfigFromDisk, resolveModelChoice, state, tokenLedger, updateConfigFile, v2ToolEnabled
async function dispatchAffinityRoutes(request, deps) {
  // 历史消息检索：跨会话（不传 key）或限定会话，FTS5 主检索 + LIKE 兜底短词。
  // 运行期切模型：{ provider, model, clearFallback? }；只对后续回合生效，不重启桥接。
  // 可切换的模型清单（可在 config.socialV2.modelOptions 覆盖）。
  // ── 好感度名单（M7 规格 §7，P2）：只读、仅管理端 ──────────────────────
  // 智能体（MCP 工具进程）也持有控制台令牌，所以「有 consoleToken」不等于管理员；
  // 这里显式拒绝带 x-agent-call / x-agent-token 的调用，防止模型把别人的分读出来。
  if (request.req.method === 'GET' && request.url.pathname === '/api/affinity') {
    if (request.req.headers['x-agent-call'] !== undefined || request.req.headers['x-agent-token']) {
      request.sendJson({ ok: false, code: 'admin_only', error: '好感度名单只允许管理端查询（智能体不得读取别人的分数）' }, 403);
      return true; /* @bridge-handled */
    }
    if (!(0, deps.affinityOn)()) { request.sendJson({ ok: false, code: 'disabled', error: '好感度功能关着' }); return true; /* @bridge-handled */ }
    try {
      const store = (0, deps.affinityLoad)();
      const people = (0, deps.listForConsole)(store, { limit: Number(request.url.searchParams.get('limit') || 50) });
      request.sendJson({ ok: true, rulesVer: Number(store?.rulesVer) || 0, count: people.length, people });
    } catch (error) {
      request.sendJson({ ok: false, error: `好感度名单读取失败：${error?.message ?? error}` }, 500);
    }
    return true; /* @bridge-handled */
  }

  // ── 好感度改分（M7-B）：桥接侧硬限速，不信模型自觉 ────────────────────
  if (request.req.method === 'POST' && request.url.pathname === '/api/affinity/shift') {
    const body = await request.readBody();
    const key = String(body.key ?? '').trim();
    const agentToken = String(request.req.headers['x-agent-token'] || body.token || '').trim();
    if (!key) { request.sendJson({ ok: false, code: 'bad_key', error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
    if (!agentToken || !request.agentTokenOk(key, agentToken)) { request.sendJson({ ok: false, code: 'bad_token', error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
    if (!(0, deps.v2ToolEnabled)('affinityShift')) { request.sendJson({ ok: false, code: 'tool_disabled', error: '工具未启用：qq_affinity_shift' }, 403); return true; /* @bridge-handled */ }
    const r = (0, deps.affinityShift)({ key, userId: body.userId, delta: body.delta, reason: body.reason });
    // 拒绝分支一律 200 + ok:false + code（模型要看得到人话原因；HTTP 错误码会变成异常文本）
    request.sendJson({ ok: r.ok === true, ...r });
    return true; /* @bridge-handled */
  }

  // ── 自报家门（D37）：回答「你现在用的是哪个模型 / 什么版本」──────────────
  // 为什么不复用 GET /api/model：那个是「配置/覆盖」口径，其中的配置默认值不是实况。
  // 这里按 override > 本轮选型 > 最近实际计费回合 > 配置默认 取，并在返回里标 source/reason，
  // 让模型知道「config-default 只是回落值」，不能当实况说出去（D33 踩过 k=base 的坑）。
  // 只读：不写 state、不写 config、不动模型选择。
  if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/self-model') {
    const body = await request.readBody();
    const key = (0, deps.canonicalV2Key)(String(body.key ?? '').trim());
    const agentToken = String(request.req.headers['x-agent-token'] || body.token || '').trim();
    if (!key) { request.sendJson({ ok: false, code: 'bad_key', error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
    if (!agentToken || !request.agentTokenOk(key, agentToken)) { request.sendJson({ ok: false, code: 'bad_token', error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
    if (!(0, deps.v2ToolEnabled)('selfModel')) { request.sendJson({ ok: false, code: 'tool_disabled', error: '工具未启用：qq_self_model' }, 403); return true; /* @bridge-handled */ }
    const sid = deps.state.sessions[key] || null;
    // 计费账本只当「最近一回合真实模型」的旁证：它是 turn 采样（不是 base 配置默认）。
    // conversation() 会全量扫一遍采样，只在模型主动问时才调，频率很低。
    let billed = null;
    try {
      const row = deps.tokenLedger.conversation(key, { turnLimit: 1 })?.turns?.[0] ?? null;
      if (row && row.provider && row.model) {
        billed = { provider: row.provider, model: row.model, at: row.endedAt, buckets: row.buckets, source: 'turn' };
      }
    } catch (error) {
      (0, deps.log)(`[self-model] 读计费账本失败（不影响回答）：${error?.message ?? error}`);
    }
    request.sendJson((0, deps.buildSelfModelPayload)({
      key,
      sessionId: sid,
      mode: deps.currentMode,
      preset: deps.cfg.socialV2?.agentPreset || deps.cfg.agentPreset || null,
      override: deps.activeModelOverride,
      applied: sid ? deps.appliedModelBySession.get(sid) ?? null : null,
      billed,
      cfg: deps.cfg,
      now: Date.now()
    }));
    return true; /* @bridge-handled */
  }

  return false;
}

async function dispatchModelRoutingRoute(request, deps) {
  // ── 模型路由（空闲/高峰/降级/禁用）──────────────────────────────────
  if (request.url.pathname === '/api/model-routing') {
    if (request.req.method === 'GET') {
      const routing = (0, deps.normalizeRouting)(deps.cfg.socialV2?.modelRouting);
      // 2026-11-02：视觉链路默认值 —— 没配过就用 modelForMedia 当第一级，末尾固定「不可用」。
      const mediaCfg = deps.cfg.socialV2?.modelForMedia || null;
      if (!routing.visionIdle && mediaCfg) routing.visionIdle = { provider: mediaCfg.provider, model: mediaCfg.model };
      if (!routing.visionPeak && mediaCfg) routing.visionPeak = { provider: mediaCfg.provider, model: mediaCfg.model };
      if (!Array.isArray(routing.visionFallback) || routing.visionFallback.length === 0) {
        routing.visionFallback = [
          mediaCfg ? { provider: mediaCfg.provider, model: mediaCfg.model } : null,
          { provider: 'none', model: 'none' }
        ].filter(Boolean);
      }
      let catalog = [];
      try { catalog = await (0, deps.probeAvailableModels)(); } catch {}
      const isPeakNow = (0, deps.peakPauseActive)();
      const mediaNow = null;
      const eff = (0, deps.resolveModelChoice)({ routing, media: mediaNow, isPeak: isPeakNow, available: catalog });
      const pp = (0, deps.peakCfg)();
      request.sendJson({
        ok: true,
        peakPause: { enabled: pp.enabled, schedule: pp.schedule, windows: pp.windows, inWindow: (0, deps.inPeakWindow)(), active: isPeakNow },
        routing,
        effective: eff || { provider: deps.cfg.dsh?.provider || '', model: deps.cfg.dsh?.model || '', source: 'main' },
        options: (catalog.length ? catalog : [
          { provider: 'deepseek-account', model: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash（官方）' },
          { provider: 'deepseek-account', model: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro（官方）' },
          { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', label: 'DeepSeek-V4.1-Flash（合池）' },
          { provider: 'workbuddy2api', model: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro（合池）' },
          { provider: 'workbuddy2api', model: 'glm-5.3', label: 'GLM-5.3（合池）' },
          { provider: 'xiaomi-mimo', model: 'mimo-v2.6-pro', label: 'MiMo-V2.6-Pro' },
          { provider: 'xiaomi-mimo', model: 'mimo-v2.6-flash', label: 'MiMo-V2.6-Flash' }
        ]).map((m) => ({ provider: m.provider, model: m.model, label: m.label || m.model })),
        // 清单来自 DSH 探测；探测失败时给静态兜底，避免面板下拉整片变空（实测保存后 catalog 抖动 → 选项全空）。
        catalog: catalog.length > 0,
        note: '保存后下一轮生效，无需重启'
      });
      return true; /* @bridge-handled */
    }
    if (request.req.method === 'POST') {
      const body = await request.readBody();
      // 未提交的字段以**磁盘最新值**为基线（不是内存快照）：另一个写入者刚改过的
      // idle/peak/fallback 不会被这次部分更新覆盖。
      const diskCfg = (0, deps.readConfigObject)(deps.path.join(deps.ROOT, 'config.json'));
      const diskRouting = diskCfg.socialV2?.modelRouting;
      const memRouting = deps.cfg.socialV2?.modelRouting;
      const cur = (diskRouting && typeof diskRouting === 'object' ? diskRouting : null)
        || (memRouting && typeof memRouting === 'object' ? memRouting : {});
      const next = (0, deps.normalizeRouting)({
        idle: body.idle !== undefined ? body.idle : cur.idle,
        peak: body.peak !== undefined ? body.peak : cur.peak,
        fallback: body.fallback !== undefined ? body.fallback : cur.fallback,
        disabled: body.disabled !== undefined ? body.disabled : cur.disabled,
        visionIdle: body.visionIdle !== undefined ? body.visionIdle : cur.visionIdle,
        visionPeak: body.visionPeak !== undefined ? body.visionPeak : cur.visionPeak,
        visionFallback: body.visionFallback !== undefined ? body.visionFallback : cur.visionFallback
      });
      // 解析守卫：请求里给的候选解析不出 provider/model 就 400，别静默丢成 null。
      // 背景：面板发的是 "provider/model" 字符串，旧版只认对象 → 一保存就把路由写空
      //（2026-10-26 21:1x 真机复现，见 src/model-routing.js normalizeModelRef 注释）。
      const badRefs = [];
      for (const field of ['idle', 'peak', 'visionIdle', 'visionPeak']) {
        const raw = body[field];
        if (raw !== undefined && raw !== null && raw !== '' && !(0, deps.normalizeModelRef)(raw)) badRefs.push(`${field}=${JSON.stringify(raw)}`);
      }
      for (const field of ['fallback', 'disabled', 'visionFallback']) {
        if (Array.isArray(body[field])) {
          for (const item of body[field]) {
            if (item === null || item === '') continue;
            if (!(0, deps.normalizeModelRef)(item)) badRefs.push(`${field}[]=${JSON.stringify(item)}`);
          }
        }
      }
      if (badRefs.length) {
        request.sendJson({ ok: false, error: `无法解析的模型（要 "provider/model" 或 {provider,model}）：${badRefs.slice(0, 4).join('、')}` }, 400);
        return true; /* @bridge-handled */
      }
      // 清空守卫：本来有路由，这次却把 idle/peak/fallback 一起清空 → 几乎都是客户端 bug，
      // 拒绝写入（想真的全清空请显式带 allowEmpty:true）。模型路由一旦被清空，
      // 下一轮就退回 dsh 默认模型，群里表现成「换模型没生效 / 高峰没切」。
      const curHasRouting = Boolean(cur?.idle || cur?.peak || cur?.visionIdle || cur?.visionPeak);
      const nextEmpty = !next.idle && !next.peak && !next.visionIdle && !next.visionPeak && next.fallback.length === 0 && next.visionFallback.length === 0;
      if (curHasRouting && nextEmpty && body.allowEmpty !== true) {
        (0, deps.log)('[模型] 拒绝清空路由：请求会导致 idle/peak/fallback 全空（要清空请带 allowEmpty:true）');
        request.sendJson({ ok: false, error: '拒绝写入：这次请求会把 idle/peak/fallback 全部清空，疑似客户端把模型传成了无法解析的值。确实要清空请带 allowEmpty:true。' }, 400);
        return true; /* @bridge-handled */
      }
      // 校验：只校验「设置了的」候选（清单为空只告警，避免 DSH 挂掉改不了配置）。
      const available = await (0, deps.probeAvailableModels)().catch(() => []);
      for (const m of [next.idle, next.peak, next.visionIdle, next.visionPeak, ...next.fallback, ...next.visionFallback].filter(Boolean)) {
        if (String(m.provider) === 'none') continue; // 「无」不参与可用性校验
        const verdict = (0, deps.checkModelAgainstList)({ provider: m.provider, model: m.model, list: available });
        if (!verdict.empty && !verdict.ok) { request.sendJson({ ok: false, error: `模型 ${m.provider}/${m.model} 不在 DSH 可用清单里` }, 400); return true; /* @bridge-handled */ }
      }            deps.cfg.socialV2 = deps.cfg.socialV2 && typeof deps.cfg.socialV2 === 'object' ? deps.cfg.socialV2 : {};
      deps.cfg.socialV2.modelRouting = next;
      if (typeof body.peakPauseEnabled === 'boolean') {
        deps.cfg.socialV2.peakPause = deps.cfg.socialV2.peakPause && typeof deps.cfg.socialV2.peakPause === 'object' ? deps.cfg.socialV2.peakPause : {};
        deps.cfg.socialV2.peakPause.enabled = body.peakPauseEnabled;
      }
      // 读盘再合并：只改 modelRouting / peakPause.enabled，不用内存整份 cfg 覆盖磁盘
      //（否则另一个 API/脚本刚写的 allow 等字段会被旧快照抹掉）。
      try {
        (0, deps.updateConfigFile)(deps.path.join(deps.ROOT, 'config.json'), (disk) => {
          disk.socialV2 = disk.socialV2 && typeof disk.socialV2 === 'object' ? disk.socialV2 : {};
          disk.socialV2.modelRouting = next;
          if (typeof body.peakPauseEnabled === 'boolean') {
            disk.socialV2.peakPause = disk.socialV2.peakPause && typeof disk.socialV2.peakPause === 'object' ? disk.socialV2.peakPause : {};
            disk.socialV2.peakPause.enabled = body.peakPauseEnabled;
          }
        }, { atomicWrite: deps.atomicWriteJson });
      } catch (error) {
        (0, deps.log)(`[模型] 写入 config.json 失败：${error?.message ?? error}`);
        request.sendJson({ ok: false, error: `写入 config.json 失败：${error?.message ?? error}` }, 500);
        return true; /* @bridge-handled */
      }
      try { (0, deps.reloadConfigFromDisk)('model-routing'); } catch {}
      deps.modelSelectionEpoch += 1;
      (0, deps.log)(`[模型] 路由已更新：idle=${next.idle ? `${next.idle.provider}/${next.idle.model}` : '-'} peak=${next.peak ? `${next.peak.provider}/${next.peak.model}` : '-'} fallback=${next.fallback.length} 视觉=${next.visionIdle ? `${next.visionIdle.provider}/${next.visionIdle.model}` : '-'}/${next.visionFallback.length} disabled=${next.disabled.length}`);
      request.sendJson({ ok: true, routing: next, persisted: true, restartRequired: false });
      return true; /* @bridge-handled */
    }
    request.sendJson({ ok: false, error: '只支持 GET/POST' }, 405);
    return true; /* @bridge-handled */
  }
  return false;
}

async function dispatchModelRoute(request, deps) {
  if (request.req.method === 'GET' && request.url.pathname === '/api/models') {
    const fallbackList = [
      { provider: 'deepseek-account', model: 'deepseek-flash', label: 'DeepSeek Flash（官方，便宜快）' },
      // 注意：这份清单**仅用于展示**（GET /api/models 的下拉），不参与任何默认选择。
      // id 必须写 provider 注册表里的真实名字（合池后已去掉 cn:/global: 前缀）——
      // 写成带前缀的旧 id 会让控制台把人带进「选了就失败」的坑。
      { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash（中转，快）' },
      { provider: 'workbuddy2api', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro（中转，强）' },
      { provider: 'workbuddy2api', model: 'glm-5.3', label: 'GLM-5.3（中转）' }
    ];
    const list = Array.isArray(deps.cfg.socialV2?.modelOptions) && deps.cfg.socialV2.modelOptions.length ? deps.cfg.socialV2.modelOptions : fallbackList;
    const use = deps.activeModelOverride || { provider: deps.cfg.dsh?.provider, model: deps.cfg.dsh?.model };
    // 动态清单（DSH 可用模型）优先；拿不到时回落到静态 modelOptions。
    let catalog = [];
    try { catalog = await (0, deps.probeAvailableModels)(); } catch {}
    const options = catalog.length
      ? catalog.map((m) => ({ provider: m.provider, model: m.model, label: m.label || m.model }))
      : list;
    request.sendJson({
      ok: true,
      current: { provider: use.provider, model: use.model },
      scopes: (0, deps.readModelScopes)(deps.cfg, deps.activeModelOverride),
      options,
      catalog: catalog.length > 0,
      byKind: deps.cfg.socialV2?.modelByKind || null,
      note: '切换对下一轮生效，无需重启'
    });
    return true; /* @bridge-handled */
  }

  // /api/dsh/model 的 GET 在上面单独实现（读当前值 + 思考强度选项）；前端保存模型时
  // 优先打的是 POST /api/dsh/model，所以这里把它当**别名**接过来，走同一套校验逻辑。
  // 不这么做的话每次保存都要先吃一个 404 再退回 /api/model（多一次无用请求），
  // 而前端注释写着「优先用带清单校验的 /api/dsh/model」，与实现自相矛盾。
  const isModelSetAlias = request.req.method === 'POST' && request.url.pathname === '/api/dsh/model';
  if (request.url.pathname === '/api/model' || isModelSetAlias) {
    if (request.req.method === 'GET' && !isModelSetAlias) {
      const use = deps.activeModelOverride || { provider: deps.cfg.dsh?.provider, model: deps.cfg.dsh?.model };
      const lc = (0, deps.localCfgNow)();
      request.sendJson({
        ok: true,
        provider: use.provider,
        model: use.model,
        degraded: !!deps.activeModelOverride,
        fallbacks: deps.cfg.dsh?.modelFallbacks ?? [],
        local: {
          enabled: lc.enabled,
          active: deps.localFallbackState.active,
          since: deps.localFallbackState.since || 0,
          model: lc.model,
          baseUrl: lc.baseUrl,
          ok: deps.localFallbackState.ok,
          fail: deps.localFallbackState.fail,
          description: (0, deps.describeLocalFallback)({ cfg: lc, active: deps.localFallbackState.active, since: deps.localFallbackState.since })
        }
      });
      return true; /* @bridge-handled */
    }
    if (request.req.method === 'DELETE') {
      const scope = String(request.url.searchParams.get('scope') || 'override');
      const verdict = (0, deps.applyModelScope)(deps.cfg, { scope, provider: '', model: '' });
      if (!verdict.ok) { request.sendJson({ ok: false, error: verdict.error }, 400); return true; /* @bridge-handled */ }
      if (scope === 'override') { deps.activeModelOverride = null; deps.modelSelectionEpoch += 1; request.sendJson({ ok: true, scope, cleared: true, persisted: false }); return true; /* @bridge-handled */ }
      const parent = verdict.path.slice(0, -1).reduce((o, k) => (o && typeof o[k] === 'object' ? o[k] : null), deps.cfg);
      if (parent) delete parent[verdict.path[verdict.path.length - 1]];
      // 读盘再合并：只删对应 scope 节点，保留磁盘上其它字段的并发修改。
      try {
        (0, deps.updateConfigFile)(deps.path.join(deps.ROOT, 'config.json'), (disk) => {
          const leaf = verdict.path[verdict.path.length - 1];
          const diskParent = verdict.path.slice(0, -1).reduce((o, k) => (o && typeof o[k] === 'object' ? o[k] : null), disk);
          if (diskParent) delete diskParent[leaf];
        }, { atomicWrite: deps.atomicWriteJson });
      } catch {}
      try { (0, deps.reloadConfigFromDisk)('model-api'); } catch {}
      deps.modelSelectionEpoch += 1;
      (0, deps.log)(`[模型] scope=${scope} 已清除（已落盘，下一轮生效）`);
      request.sendJson({ ok: true, scope, cleared: true, persisted: true, restartRequired: false });
      return true; /* @bridge-handled */
    }
    const body = await request.readBody();
    const scope = String(body.scope || 'override').trim();
    const provider = String(body.provider ?? '').trim();
    const model = String(body.model ?? '').trim();
    const persist = body.persist !== false;
    const verdict = (0, deps.applyModelScope)(deps.cfg, { scope, provider, model });
    if (!verdict.ok) { request.sendJson({ ok: false, error: verdict.error }, 400); return true; /* @bridge-handled */ }
    if (model) {
      const available = await (0, deps.probeAvailableModels)().catch(() => []);
      const chk = (0, deps.checkModelAgainstList)({ provider, model, list: available });
      if (chk.empty) (0, deps.log)(`⚠️ 设置模型 ${provider}/${model}：拿不到 DSH 清单，无法校验，按请求写入`);
      else if (!chk.ok) {
        request.sendJson({ ok: false, error: `模型 ${provider}/${model} 不在可用清单里`, models: (0, deps.listAvailableModels)(available, 40) }, 400);
        return true; /* @bridge-handled */
      }
    }
    if (scope === 'override') {
      deps.activeModelOverride = model ? { provider, model, since: Date.now(), reason: 'console' } : null;
      deps.lastModelFailureNotifyAt = 0;
      deps.modelSelectionEpoch += 1;
      (0, deps.log)(`[模型] scope=override → ${model ? `${provider}/${model}` : '已清除'}（仅运行期，下一轮生效）`);
      request.sendJson({ ok: true, scope, applied: model ? { provider, model } : null, persisted: false, restartRequired: false });
      return true; /* @bridge-handled */
    }
    // 写入 cfg 对应路径（main/peak/media/group/private）
    const pathArr = verdict.path;
    let node = deps.cfg;
    for (let i = 0; i < pathArr.length - 1; i += 1) {
      const k = pathArr[i];
      if (!node[k] || typeof node[k] !== 'object') node[k] = {};
      node = node[k];
    }
    const leaf = pathArr[pathArr.length - 1];
    if (verdict.clear) { delete node[leaf]; } else { node[leaf] = { provider, model }; }
    // 读盘再合并：只写本次 scope 的路径，磁盘上其它字段的并发修改不会被旧快照覆盖。
    if (persist) {
      try {
        (0, deps.updateConfigFile)(deps.path.join(deps.ROOT, 'config.json'), (disk) => {
          let diskNode = disk;
          for (let i = 0; i < pathArr.length - 1; i += 1) {
            const k = pathArr[i];
            if (!diskNode[k] || typeof diskNode[k] !== 'object') diskNode[k] = {};
            diskNode = diskNode[k];
          }
          if (verdict.clear) delete diskNode[leaf];
          else diskNode[leaf] = { provider, model };
        }, { atomicWrite: deps.atomicWriteJson });
      } catch {}
    }
    try { (0, deps.reloadConfigFromDisk)('model-api'); } catch {}
    deps.modelSelectionEpoch += 1;
    (0, deps.log)(`[模型] scope=${scope} → ${verdict.clear ? '已清除' : `${provider}/${model}`}（${persist ? '已落盘' : '仅内存'}，下一轮生效）`);
    request.sendJson({ ok: true, scope, applied: verdict.clear ? null : { provider, model }, persisted: Boolean(persist), restartRequired: false });
    return true; /* @bridge-handled */
  }
  return false;
}

export function createConsoleModelsAffinity(deps) {
// @bridge-function handleConsoleModelsAffinity:start
async function handleConsoleModelsAffinity(request) {

        if (await dispatchAffinityRoutes(request, deps)) return true; /* @bridge-handled */
        if (await dispatchModelRoutingRoute(request, deps)) return true; /* @bridge-handled */
        if (await dispatchModelRoute(request, deps)) return true; /* @bridge-handled */
    return false;
  }
// @bridge-function handleConsoleModelsAffinity:end
  return { handleConsoleModelsAffinity };
}
