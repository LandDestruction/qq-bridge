// console/draw: extracted bridge responsibilities; no startup side effects.
// Live dependencies: MAX_MEDIA_BYTES, STATE_DIR, api, appendActivity, cfg, currentMode, describeImagegenError, ensureSlangLearnerSession, fs, generateByTier, getSocialV2State, imagegenCfg, localCfgNow, localClientNow, log, modeAllowed, needsTranslation, normalizeObserveConfig, path, readQuota, safeFetchBuffer, safeFetchJsonCompat, saveSocialV2State, scheduleReplyCheckV2, sendImageV2, shouldBlockSilentReply, tierAskSatisfied, translateImagePrompt, truncateText, v2ToolEnabled, waitLearnerTurn, writeQuota
export function createConsoleDraw(deps) {
// @bridge-function handleConsoleDraw:start
async function handleConsoleDraw(request) {
        if (request.req.method === 'POST' && request.url.pathname === '/api/socialV2/draw') {
          if (deps.cfg.imagegen?.enabled === false) { request.sendJson({ ok: false, error: '出图/发图功能已关闭' }, 403); return true; /* @bridge-handled */ }
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const prompt = String(body.prompt ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // tier 必填、无默认值：模型必须先问过用户再调，代码不替它做选择。
          const tier = String(body.tier ?? '').trim();
          if (!key || !prompt) { request.sendJson({ ok: false, error: 'key 和 prompt 不能为空' }, 400); return true; /* @bridge-handled */ }
          // 两档都要过「先问档位」：工具契约是「调用前必须先问用户选哪档」，不是只问 high。
          // 用户回「随便/都行/你决定」也算问过（reason=user-deferred），由模型按契约落到 free。
          // 观察群只看不说：出图在生成之前就拦掉（否则模型在观察群里也能刷图）。
          {
            const obs = (0, deps.normalizeObserveConfig)(deps.cfg.observe);
            const om = /^group:(\d+)$/.exec(key);
            if (obs.enabled && om && obs.groups.includes(om[1])) {
              request.sendJson({ ok: false, error: '这是观察学习群：只收集词汇/表情，不发图不发言' }, 403);
              return true; /* @bridge-handled */
            }
          }
          if (tier !== 'free' && tier !== 'high') {
            request.sendJson({ ok: false, error: "tier 必填，只能取 'free'（免费档，带 AI生成 标注，不限次）或 'high'（高质量档，同样带 AI生成 标注，画质更好，每天 30 次）；请先问用户选哪档（tier 只能是 free/high）" }, 400);
            return true; /* @bridge-handled */
          }
          if (deps.cfg.imagegen?.requireTierAsk !== false) {
            // 硬约束：软提示管不住模型（19:01 实测没问就直接 high）。没问过就拒，且**不偷偷改 free**。
            const st0 = (0, deps.getSocialV2State)(key);
            const lastUser = [...(st0?.recentMessages ?? [])].reverse().find((m) => m && !m.isSelf);
            const verdict = (0, deps.tierAskSatisfied)({
              recent: st0?.recentMessages ?? [],
              lastUserText: String(lastUser?.text ?? lastUser?.plain ?? ''),
              enabled: true
            });
            if (verdict.ok && verdict.reason === 'user-free' && tier === 'high') {
              request.sendJson({ ok: false, error: '用户要的是免费档，不要用高质量档（会消耗每日 30 次）；请改传 tier=free。', tier, reason: 'user-free' }, 409);
              return true; /* @bridge-handled */
            }
            if (!verdict.ok) {
              request.sendJson({ ok: false, error: '本轮还没问用户选哪档：请先问「要免费档（带 AI生成标注、不限次）还是高质量档（同样带 AI生成标注、画质更好，今天还剩 N 次）？」，拿到答复后再调用。', tier, reason: verdict.reason }, 400);
              return true; /* @bridge-handled */
            }
            (0, deps.log)(`[imagegen] tier=${tier} 通过问档校验（${verdict.reason}）`);
          }
          if (prompt.length > 500) { request.sendJson({ ok: false, error: 'prompt 过长（最多 500 字）' }, 400); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.agentTokenOk(key, request.req.headers['x-agent-token'])) { request.sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !request.v2SessionAllowed(key)) { request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; /* @bridge-handled */ }
          if (request.req.headers['x-agent-token'] && !(0, deps.v2ToolEnabled)('draw')) { request.sendJson({ ok: false, error: '工具未启用：qq_draw' }, 403); return true; /* @bridge-handled */ }
          if (deps.currentMode !== 'reserved2') { request.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; /* @bridge-handled */ }
          if (!request.req.headers['x-agent-token']) { request.sendJson({ ok: false, error: 'reserved2 模式出图必须携带 agent token' }, 403); return true; /* @bridge-handled */ }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; /* @bridge-handled */ }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
            request.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return true; /* @bridge-handled */
          }
          if ((0, deps.shouldBlockSilentReply)(key)) { request.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; /* @bridge-handled */ }
          const st = (0, deps.getSocialV2State)(key);
          const now = Date.now();
          // 频率限制：出图源通常有冷却（pollinations 45s/张）
          const cooldownMs = Number(deps.cfg.imagegen?.cooldownMs) || 45000;
          const maxPerHour = Number(deps.cfg.imagegen?.maxPerHour) || 10;
          const lastDraw = st.lastDrawAt || 0;
          if (now - lastDraw < cooldownMs) {
            const waitSec = Math.ceil((cooldownMs - (now - lastDraw)) / 1000);
            request.sendJson({ ok: false, error: `出图冷却中，请 ${waitSec} 秒后再试` }, 429);
            return true; /* @bridge-handled */
          }
          const drawTimes = (st.drawTimes || []).filter((t) => now - t < 3600000);
          if (drawTimes.length + 1 > maxPerHour) {
            request.sendJson({ ok: false, error: '出图太频繁了（每小时上限），请稍后再试' }, 429);
            return true; /* @bridge-handled */
          }
          st.drawTimes = drawTimes;
          st.drawTimes.push(now);
          st.lastDrawAt = now;
          if (st.drawTimes.length > 500) st.drawTimes = st.drawTimes.slice(-500);
          try {
            // 生图 provider 可插拔：url-template（pollinations，默认、行为与旧版一致）
            // 或 openai-image（POST /images/generations + Bearer key，b64_json 或 url 都能取）。
            // 字节下载仍走同一个 safeFetchBuffer，SSRF 与字节上限都不绕过。
            const ig = (0, deps.imagegenCfg)(deps.cfg);
            // 中文提示词 → 英文提示词（实测：同一句中文出来是白毛团，同义英文才命中橘猫+水彩）。
            // 失败/超时一律退回原文，绝不让翻译把生图搞挂。
            let drawPrompt = prompt;
            if (deps.cfg.imagegen?.promptTranslate !== false && (0, deps.needsTranslation)(prompt)) {
              const tr = await (0, deps.translateImagePrompt)({
                prompt,
                timeoutMs: Number(deps.cfg.imagegen?.promptTranslateTimeoutMs) || 5000,
                // 用本地兜底客户端做翻译：不占付费额度、不污染 QQ 会话上下文。
                // 本地模型没起时 callModel 自己会抛错 → translateImagePrompt 退回原文。
                callModel: async ({ system, user, temperature, maxTokens, timeoutMs }) => {
                  // 顺序：**本地优先**（不占付费额度、不污染 QQ 会话上下文），
                  // 本地未启用/未就绪/超时才回落到「主模型的专用翻译会话」。
                  // 回落是兜底，不是默认 —— 本地实测 1.6s 可用，主模型每次多一次调用（成本+延迟）。
                  try {
                    const lc = (0, deps.localCfgNow)();
                    if (!lc.enabled) throw new Error('本地翻译器未启用');
                    const cli = (0, deps.localClientNow)();
                    if (!(await cli.probe())) throw new Error('本地翻译器未就绪');
                    const out = await cli.chat([{ role: 'system', content: system }, { role: 'user', content: user }], {
                      timeoutMs,
                      temperature,
                      maxTokens
                    });
                    return String(out?.text ?? '');
                  } catch (localError) {
                    if (deps.cfg.imagegen?.translateViaMainModel === false) throw localError;
                    (0, deps.log)(`[imagegen] 本地翻译不可用（${localError?.message ?? localError}），回落到主模型专用会话`);
                    const sessionId = await (0, deps.ensureSlangLearnerSession)();
                    const accepted = await deps.api.sessions.prompt({
                      sessionId,
                      mode: 'queue',
                      content: [{ type: 'text', text: `${system}

${user}` }]
                    });
                    if (!accepted?.result?.ok) throw new Error(`主模型翻译会话被拒：${accepted?.result?.error?.message ?? 'unknown'}`);
                    const text = String(await (0, deps.waitLearnerTurn)(sessionId, Math.max(8000, Number(timeoutMs) || 15000)) || '').trim();
                    if (!text) throw new Error('主模型翻译会话没有返回文本');
                    return text;
                  }
                }
              });
              drawPrompt = tr.text;
              (0, deps.log)(`[imagegen] 提示词翻译（${tr.translated ? '成功' : '回退'}，${tr.reason}）：${prompt.slice(0, 40)} → ${drawPrompt.slice(0, 60)}`);
            }
            (0, deps.log)(`[imagegen] tier=${tier}（${tier === 'free' ? '免费档（有 AI生成标注）' : '高质量档（画质更高，有 AI生成标注）'}）`);
            // 双通道：free → CogView（带 AI生成 标注、不扣配额）；high → Z-Image（先占配额、失败回滚）。
            // 铁律：free 失败不自动切 high；high 配额用尽不静默降级，直接报错让模型问用户。
            const quotaFile = deps.path.join(deps.STATE_DIR, 'imagegen-quota.json');
            const quotaStore = {
              read: (at) => (0, deps.readQuota)(quotaFile, deps.fs, at),
              write: (state) => (0, deps.writeQuota)(quotaFile, state, deps.fs)
            };
            let drawn;
            try {
              drawn = await (0, deps.generateByTier)(deps.cfg, drawPrompt, {
                tier,
                deps: {
                  safeFetchBuffer: deps.safeFetchBuffer,
                  safeFetchJson: deps.safeFetchJsonCompat,
                  quotaStore,
                  maxBytes: ig.maxBytes || deps.MAX_MEDIA_BYTES,
                  timeoutMs: ig.timeoutMs
                }
              });
              (0, deps.log)(`[imagegen] tier=${tier} 出图成功（${drawn.source}${drawn.charged ? `，已用 ${drawn.quota.used}/${drawn.quota.limit}` : '，未扣配额'}）`);
            } catch (error) {
              const status = Number(error?.status) || (error?.code === 'QUOTA_EXHAUSTED' ? 429 : 502);
              const text = (0, deps.describeImagegenError)(status, error?.message ?? error, deps.cfg.imagegen?.fallback?.apiKey || '').error;
              (0, deps.log)(`[imagegen] tier=${tier} 出图失败：${text}`);
              request.sendJson({ ok: false, error: text, tier, ...(error?.quota ? { quota: error.quota } : {}) }, status);
              return true; /* @bridge-handled */
            }
            const fetched = { buffer: drawn.buffer, contentType: drawn.contentType };
            const sent = await (0, deps.sendImageV2)(key, 'base64://' + fetched.buffer.toString('base64'), { replyToMessageId, atUserId });
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: `[图片:${(0, deps.truncateText)(prompt, 60)}]`,
              plain: `[图片:${(0, deps.truncateText)(prompt, 60)}]`,
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              time: Date.now()
            });
            const recentLimit = Number(deps.cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            (0, deps.saveSocialV2State)();
            (0, deps.scheduleReplyCheckV2)(key);
            (0, deps.log)(`[draw] 工具出图并发送 ${key}: ${(0, deps.truncateText)(prompt, 60)}`);
            (0, deps.appendActivity)(`${key} [draw] 工具出图并发送：${(0, deps.truncateText)(prompt, 60)}`);
            request.sendJson({ ok: true, key, messageId: sent.messageId, sent: 1 });
          } catch (error) {
            // 出图失败回滚 drawTimes，避免冷却误锁
            const st2 = (0, deps.getSocialV2State)(key);
            const idx = (st2.drawTimes || []).indexOf(now);
            if (idx >= 0) st2.drawTimes.splice(idx, 1);
            if (now === st2.lastDrawAt) st2.lastDrawAt = 0;
            (0, deps.saveSocialV2State)();
            (0, deps.log)(`[draw] 工具出图失败 ${key}: ${error?.message ?? error}`);
            request.sendJson({ ok: false, error: `出图失败：${error?.message ?? error}` }, 500);
          }
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleDraw:end
  return { handleConsoleDraw };
}
