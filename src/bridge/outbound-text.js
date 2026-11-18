// outbound-text: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, KNOWN_AGENT_TOKENS, SEND_TIMEOUT_MS, bot, captureSendGuard, cfg, escapeCqText, fetch, lastSendFailed, log, privateTempSession, randInt, recentUserGroup, sendChain, sleep, splitForQQ, text, withTimeout
// @bridge-function redactKnownTokensOnly:start
function redactKnownTokensOnly(deps, text) {
    let s = String(text ?? '');
    for (const token of deps.KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }
// @bridge-function redactKnownTokensOnly:end

// @bridge-function sendPrivateViaTempSession:start
async function sendPrivateViaTempSession(deps, uid, message) {
    // D67：策略在 src/private-temp-session.js（只试最近那个群一次、失败写 30 分钟冷却、白名单群成员只在冷却刚触发时收一条群内兜底提示；陌生人静默）。
    (0, deps.assertIdentitySendAllowed)();
    return deps.privateTempSession(Number(uid), message);
  }
// @bridge-function sendPrivateViaTempSession:end

// @bridge-function sendPrivateSafe:start
async function sendPrivateSafe(deps, id, message) {
    try {
      (0, deps.assertIdentitySendAllowed)();
      return await deps.bot.sendPrivateMessage(Number(id), message);
    } catch (error) {
      if (/好友|result=16|temp session/i.test(String(error?.message ?? ""))) {
        const ok = await sendPrivateViaTempSession(deps, Number(id), message);
        if (ok) return { messageId: null, viaTempSession: true };
      }
      throw error;
    }
  }
// @bridge-function sendPrivateSafe:end

// @bridge-function sendToQQ:start
function sendToQQ(deps, key, msg) {
    // 系统总开关：暂停后一条都不许发（排队回复、报错提示、模式提示全部拦下）。
    if (deps.socialV2?.paused) {
      (0, deps.log)(`[系统] 已暂停，丢弃发送 ${key}: ${String(msg).slice(0, 40)}`);
      return Promise.resolve({ ok: true, skipped: true });
    }
    // 身份锁：SnowLuma 登录号与 identity.expectedSelfIds 不符时，一条都不许发。
    // 宁可机器人哑掉，也不要用用户的私人号说话（穿帮/封号风险都算在号主头上）。
    try {
      (0, deps.assertIdentitySendAllowed)();
    } catch (error) {
      (0, deps.log)(`[安全] 身份锁拦截发送 ${key}: ${error?.message ?? error}`);
      return Promise.resolve({ ok: true, skipped: true, identityLocked: true, reason: error?.message ?? String(error) });
    }
    const assertSendAllowed = (0, deps.captureSendGuard)(key);
    const safeMsg = redactKnownTokensOnly(deps, msg);
    const [kind, id] = key.split(':');
    const parts = (0, deps.splitForQQ)(safeMsg);
    deps.lastSendFailed.delete(key);
    for (const part of parts) {
      deps.sendChain = deps.sendChain
        .then(async () => {
          assertSendAllowed(); await (0, deps.reserveSendSlot)('text', part); // 节奏：每一条都排队
          (0, deps.assertIdentitySendAllowed)();
          if (kind === 'private') await (0, deps.withTimeout)(sendPrivateSafe(deps, Number(id), (0, deps.text)((0, deps.escapeCqText)(part))), deps.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await (0, deps.withTimeout)(deps.bot.sendGroupMessage(Number(id), (0, deps.text)((0, deps.escapeCqText)(part))), deps.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch(async (error) => {
          // 陌生人不允许直接发私聊（QQ 要求先加好友）→ 用临时会话兜底重试一次。
          if (kind === 'private' && /好友|result=16|temp session/i.test(String(error?.message ?? ''))) {
            const ok = await sendPrivateViaTempSession(deps, Number(id), [{ type: 'text', data: { text: (0, deps.escapeCqText)(part) } }]);
            if (ok) return;
          }
          deps.lastSendFailed.set(key, true);
          (0, deps.log)(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => (0, deps.sleep)(deps.cfg.sendDelayMs));
    }
    return deps.sendChain;
  }
// @bridge-function sendToQQ:end

// @bridge-function lastSendSucceeded:start
function lastSendSucceeded(deps, key) {
    return deps.lastSendFailed.get(key) !== true;
  }
// @bridge-function lastSendSucceeded:end

// @bridge-function singleLineForQQ:start
function singleLineForQQ(deps, s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
// @bridge-function singleLineForQQ:end

// @bridge-function splitLongSegment:start
function splitLongSegment(deps, segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }
// @bridge-function splitLongSegment:end

// @bridge-function isCjkChar:start
function isCjkChar(deps, ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }
// @bridge-function isCjkChar:end

// @bridge-function splitByCjkSpaces:start
function splitByCjkSpaces(deps, src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(deps, prevLast) || isCjkChar(deps, currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }
// @bridge-function splitByCjkSpaces:end

// @bridge-function planSocialTimeline:start
function planSocialTimeline(deps, text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(deps, src, maxChars).map((s) => singleLineForQQ(deps, s)), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(deps, src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(deps, parts[0] || src, maxChars).map((s) => singleLineForQQ(deps, s)), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(deps, part, maxChars).map((s) => singleLineForQQ(deps, s)));
    }
    return { main: main.filter(Boolean), followUp: null };
  }
// @bridge-function planSocialTimeline:end

// @bridge-function sendBurstToQQ:start
function sendBurstToQQ(deps, key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = (0, deps.captureSendGuard)(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(deps, messages[i]);
      const isLast = i === messages.length - 1;
      deps.sendChain = deps.sendChain
        .then(async () => {
          assertSendAllowed();
          (0, deps.assertIdentitySendAllowed)();
          if (kind === 'private') await (0, deps.withTimeout)(sendPrivateSafe(deps, Number(id), (0, deps.text)((0, deps.escapeCqText)(msg))), deps.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await (0, deps.withTimeout)(deps.bot.sendGroupMessage(Number(id), (0, deps.text)((0, deps.escapeCqText)(msg))), deps.SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          (0, deps.log)(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          deps.lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? (0, deps.randInt)(longMin, longMax) : (0, deps.randInt)(min, max);
        deps.sendChain = deps.sendChain.then(() => (0, deps.sleep)(delay));
      }
    }
    return deps.sendChain.then(() => sent);
  }
// @bridge-function sendBurstToQQ:end

// @bridge-function onebotSend:start
async function onebotSend(deps, kind, id, message, replyToMessageId, atUserId = null) {
    (0, deps.assertIdentitySendAllowed)();
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...deps.KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      (0, deps.log)(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: (0, deps.escapeCqText)(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    await (0, deps.reserveSendSlot)('text', rawMessage); // 兜底路径也排队
    await (0, deps.assertFreshHttpIdentitySendAllowed)(); // 从目标 HTTP 网关自身读取当前登录号。
    const res = await (0, deps.fetch)(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: deps.AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      // 非好友私聊（result=16）→ 临时会话重试
      if (kind === 'private' && /好友|result=16/i.test(String(body.wording || ''))) {
        const viaTemp = await sendPrivateViaTempSession(deps, Number(id), segments);
        if (viaTemp) return { message_id: null, viaTempSession: true };
      }
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }
// @bridge-function onebotSend:end
export function createOutboundText(deps) {
  return {
    redactKnownTokensOnly: (...args) => redactKnownTokensOnly(deps, ...args),
    sendPrivateViaTempSession: (...args) => sendPrivateViaTempSession(deps, ...args),
    sendPrivateSafe: (...args) => sendPrivateSafe(deps, ...args),
    sendToQQ: (...args) => sendToQQ(deps, ...args),
    lastSendSucceeded: (...args) => lastSendSucceeded(deps, ...args),
    singleLineForQQ: (...args) => singleLineForQQ(deps, ...args),
    splitLongSegment: (...args) => splitLongSegment(deps, ...args),
    isCjkChar: (...args) => isCjkChar(deps, ...args),
    splitByCjkSpaces: (...args) => splitByCjkSpaces(deps, ...args),
    planSocialTimeline: (...args) => planSocialTimeline(deps, ...args),
    sendBurstToQQ: (...args) => sendBurstToQQ(deps, ...args),
    onebotSend: (...args) => onebotSend(deps, ...args)
  };
}
