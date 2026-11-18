// console/security-social: extracted bridge responsibilities; no startup side effects.
// Live dependencies: ROOT, SENSITIVE_RE, STATE_DIR, allowed, appendActivity, atomicWriteJson, atomicWriteText, bot, cfg, crypto, currentMode, deliverPrompt, dshReady, ensureChatModel, ensureSession, enterActive, escapeCqText, flushSummaries, getSocialV2State, hardenStateDirAcl, leaveActive, log, manualDirCommand, modeAllowed, path, readConfigObject, readRoleState, redactKnownTokensOnly, sendPrivateSafe, social, state, stateDirHardened, text
export function createConsoleSecuritySocial(deps) {
// @bridge-function handleConsoleSecuritySocial:start
async function handleConsoleSecuritySocial(request) {

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/security') {
          request.sendJson({
            security: deps.cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: deps.stateDirHardened,
              path: deps.STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? (0, deps.manualDirCommand)(deps.STATE_DIR)
                : `chmod 700 "${deps.STATE_DIR}"`
            }
          });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/security') {
          const body = await request.readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            deps.stateDirHardened = null;
            (0, deps.hardenStateDirAcl)();
            request.sendJson({ ok: deps.stateDirHardened === true, hardened: deps.stateDirHardened, path: deps.STATE_DIR });
            return true; /* @bridge-handled */
          }
          const configFile = deps.path.join(deps.ROOT, 'config.json');
          const file = (0, deps.readConfigObject)(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          (0, deps.atomicWriteJson)(configFile, file);
          deps.cfg.security = { ...(deps.cfg.security ?? {}), ...next };
          (0, deps.log)(`控制台：安全拦截通知已更新（interceptNotify=${deps.cfg.security.interceptNotify}）`);
          request.sendJson({ ok: true, security: deps.cfg.security });
          return true; /* @bridge-handled */
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (request.req.method === 'POST' && request.url.pathname === '/api/console/token') {
          const body = await request.readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = deps.crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            request.sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return true; /* @bridge-handled */
          }
          if (newToken.length > 128) {
            request.sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return true; /* @bridge-handled */
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            request.sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return true; /* @bridge-handled */
          }
          const configFile = deps.path.join(deps.ROOT, 'config.json');
          const file = (0, deps.readConfigObject)(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          (0, deps.atomicWriteJson)(configFile, file);
          deps.cfg.consoleToken = generated ? '' : newToken;
          (0, deps.atomicWriteText)(deps.path.join(deps.STATE_DIR, 'console-token'), newToken);
          request.consoleToken = newToken;
          (0, deps.log)(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          request.sendJson({ ok: true, token: newToken, generated });
          return true; /* @bridge-handled */
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (request.req.method === 'POST' && request.url.pathname === '/api/test-send') {
          try { (0, deps.assertIdentitySendAllowed)(); } catch (error) {
            request.sendJson({ ok: false, error: error?.message ?? String(error) }, 423);
            return true; /* @bridge-handled */
          }
          const body = await request.readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { request.sendJson({ ok: false, error: '目标 id 无效' }, 400); return true; /* @bridge-handled */ }
          if (!message) { request.sendJson({ ok: false, error: '消息不能为空' }, 400); return true; /* @bridge-handled */ }
          if (deps.SENSITIVE_RE.test(message)) { request.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; /* @bridge-handled */ }
          if (!(0, deps.allowed)(kind, id, deps.cfg)) { request.sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return true; /* @bridge-handled */ }
          if (!(0, deps.modeAllowed)(`${kind}:${id}`, kind, id, deps.cfg, deps.currentMode)) { request.sendJson({ ok: false, error: `当前模式（${deps.currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return true; /* @bridge-handled */ }
          try {
            (0, deps.assertIdentitySendAllowed)();
            const safeMessage = (0, deps.escapeCqText)((0, deps.redactKnownTokensOnly)(message));
            const result = kind === 'private'
              ? await (0, deps.sendPrivateSafe)(id, (0, deps.text)(safeMessage))
              : await deps.bot.sendGroupMessage(id, (0, deps.text)(safeMessage));
            (0, deps.log)(`控制台：测试发送 ${kind}:${id} 成功`);
            request.sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            request.sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/social/state') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { request.sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; /* @bridge-handled */ }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            (0, deps.enterActive)(key);
            (0, deps.log)(`控制台：手动将 ${key} 设为活跃`);
            request.sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            (0, deps.leaveActive)(key);
            (0, deps.log)(`控制台：手动将 ${key} 设为观望`);
            request.sendJson({ ok: true, key, phase: 'idle' });
          } else {
            request.sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return true; /* @bridge-handled */
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (request.req.method === 'GET' && request.url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of deps.social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...deps.social.states.keys(), ...deps.social.recentMessages.keys()]);
          for (const k of keys) {
            const st = deps.social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          request.sendJson({ config: deps.cfg.social, pendingSummaries: stats, states });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/social') {
          const body = await request.readBody();
          const configFile = deps.path.join(deps.ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = (0, deps.readConfigObject)(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          (0, deps.atomicWriteJson)(configFile, file);
          deps.cfg.social = { ...deps.cfg.social, ...merged };
          (0, deps.log)('控制台：社交配置已更新');
          request.sendJson({ ok: true, config: deps.cfg.social });
          return true; /* @bridge-handled */
        }
        if (request.req.method === 'POST' && request.url.pathname === '/api/social/flush') {
          const body = await request.readBody();
          await (0, deps.flushSummaries)(body.key || null);
          request.sendJson({ ok: true });
          return true; /* @bridge-handled */
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (request.req.method === 'POST' && request.url.pathname === '/api/console/notify-ai') {
          const body = await request.readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            request.sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return true; /* @bridge-handled */
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            request.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return true; /* @bridge-handled */
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            request.sendJson({ ok: false, error: 'id 无效' }, 400);
            return true; /* @bridge-handled */
          }
          if (!(0, deps.modeAllowed)(key, kind, id, deps.cfg, deps.currentMode)) {
            request.sendJson({ ok: false, error: `该会话不在当前模式（${deps.currentMode}）允许范围内` }, 403);
            return true; /* @bridge-handled */
          }
          if (!deps.state.sessions[key] && !(0, deps.allowed)(kind, id, deps.cfg)) {
            request.sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return true; /* @bridge-handled */
          }
          if (!deps.dshReady) {
            request.sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return true; /* @bridge-handled */
          }
          const isV2 = deps.currentMode === 'reserved2';
          const roleState = (0, deps.readRoleState)();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isV2) {
            const stV2 = (0, deps.getSocialV2State)(key);
            tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具 qq_send_message。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await (0, deps.ensureSession)(key);
      await (0, deps.ensureChatModel)(sessionId, key); // 每轮投递前对齐模型（高峰/视觉/降级）
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = deps.social.silentTurns.get(sessionId) ?? [];
            deps.social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = deps.social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) deps.social.silentTurns.set(sessionId, next);
              else deps.social.silentTurns.delete(sessionId);
            };
            const result = await (0, deps.deliverPrompt)(key, promptText, { silent: true });
            if (result.ok) {
              (0, deps.log)(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              (0, deps.appendActivity)(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              request.sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              request.sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            request.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return true; /* @bridge-handled */
        }
    return false;
  }
// @bridge-function handleConsoleSecuritySocial:end
  return { handleConsoleSecuritySocial };
}
