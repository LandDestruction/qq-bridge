// outbound-policy: extracted bridge responsibilities; no startup side effects.
// Live dependencies: KNOWN_AGENT_TOKENS, PERSONA_GUIDE_TTL_MS, SENSITIVE_RE, appendActivity, appendPersonaGuide, cfg, currentMode, describeSensitiveMatch, isSessionAllowedInCurrentMode, log, onebotSend, personaGuideCooldown, personaGuidePending, randInt, readRoleState, sendChain, sendToQQ, sessionPolicy, sleep, state
export function createOutboundPolicy(deps) {
// @bridge-function clampGapV2:start
function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }
// @bridge-function clampGapV2:end

// @bridge-function computeGapsV2:start
function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2((0, deps.randInt)(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }
// @bridge-function computeGapsV2:end

// @bridge-function applyPersonaGuideToMessages:start
function applyPersonaGuideToMessages(key, messages) {
    const pending = deps.personaGuidePending.get(key);
    if (!pending) return messages;
    if (Date.now() - Number(pending.at) > deps.PERSONA_GUIDE_TTL_MS) { deps.personaGuidePending.delete(key); return messages; }
    const out = (0, deps.appendPersonaGuide)(messages);
    deps.personaGuidePending.delete(key);
    // 补过一次就进入 10 分钟冷却：同一会话不刷屏，即使又有人贴同样的模板。
    deps.personaGuideCooldown.set(key, Date.now());
    return out.messages;
  }
// @bridge-function applyPersonaGuideToMessages:end

// @bridge-function sendMessagesV2:start
function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    // 系统总开关：暂停期间连 MCP 发送工具也发不出去（agent 会收到明确原因，而不是静默丢消息）。
    if (deps.socialV2?.paused) {
      throw new Error('机器人系统已停止（控制台可一键启动），这段时间不发送任何消息');
    }
    // 乱码闸：U+FFFD（替换字符）意味着这段文字原来是别的编码（GBK 之类）被硬按 UTF-8 解了，
    // 一旦发出去对方只会看到一串替换符。宁可这条不发并在日志里报出来，也别往群里发垃圾。
    const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
    const garbled = (Array.isArray(messages) ? messages : []).filter((m) => typeof m === 'string' && m.includes(REPLACEMENT_CHAR));
    if (garbled.length) {
      (0, deps.log)(`拦下 ${garbled.length}/${messages.length} 条乱码消息 (${key})：正文含 U+FFFD 替换字符，疑似编码不对`);
      throw new Error('这条消息里有乱码字符（替换符 U+FFFD），原编码可能是 GBK，已拦下不发送；请把中文按 UTF-8 重新编码后再发');
    }
    messages = applyPersonaGuideToMessages(key, messages);
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      deps.sendChain = deps.sendChain
        .then(async () => {
          assertSendAllowed();
          await (0, deps.onebotSend)(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          (0, deps.log)(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        deps.sendChain = deps.sendChain.then(() => (0, deps.sleep)(d));
      }
    }
    return deps.sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }
// @bridge-function sendMessagesV2:end

// @bridge-function shouldAuditKey:start
function shouldAuditKey(key) {
    if (deps.currentMode === 'closed-agent') {
      return !(key === `private:${String(deps.cfg.ownerQQ ?? '')}`);
    }
    return true;
  }
// @bridge-function shouldAuditKey:end

// @bridge-function captureSendGuard:start
function captureSendGuard(key) {
    (0, deps.assertIdentitySendAllowed)();
    const policy = (0, deps.sessionPolicy)(key);
    const sessionId = deps.state.sessions[key];
    return () => {
      if (!(0, deps.isSessionAllowedInCurrentMode)(key) || policy !== (0, deps.sessionPolicy)(key)
          || (sessionId && deps.state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
      (0, deps.assertIdentitySendAllowed)();
    };
  }
// @bridge-function captureSendGuard:end

// @bridge-function shouldBlockSilentReply:start
function shouldBlockSilentReply(key) {
    const roleState = (0, deps.readRoleState)();
    return roleState.mode === 'silent' && key !== `private:${String(deps.cfg.ownerQQ ?? '')}`;
  }
// @bridge-function shouldBlockSilentReply:end

// @bridge-function auditAndSend:start
async function auditAndSend(key, text) {
    const hasKnownToken = [...deps.KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (deps.SENSITIVE_RE.test(text) || hasKnownToken)) {
      const hit = hasKnownToken ? { name: 'known-agent-token', excerpt: '***', length: 0 } : ((0, deps.describeSensitiveMatch)(text) || { name: 'unknown', excerpt: '***', length: 0 });
      (0, deps.log)(`⚠️ 回复被安全策略拦截 (${key})：规则=${hit.name} 片段=${hit.excerpt} 长度=${hit.length}${hasKnownToken ? '（命中已知会话令牌名单）' : ''}`);
      (0, deps.appendActivity)(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (deps.cfg.security?.interceptNotify !== false) {
        await (0, deps.sendToQQ)(key, `⚠️ 本条回复含疑似敏感信息（${hasKnownToken ? '会话令牌' : '本机路径/凭据'}），已被安全策略拦截、没有发出去。`);
      }
      return false;
    }
    await (0, deps.sendToQQ)(key, text);
    return true;
  }
// @bridge-function auditAndSend:end
  return { clampGapV2, computeGapsV2, applyPersonaGuideToMessages, sendMessagesV2, shouldAuditKey, captureSendGuard, shouldBlockSilentReply, auditAndSend };
}
