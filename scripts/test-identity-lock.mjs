// 身份锁（src/safety/identity-lock.js + 发送闸）回归。
// 目标：把「允许用哪个 QQ 号说话」钉死，SnowLuma 换了号也绝不会用错号发消息。
import assert from 'node:assert/strict';
import { normalizeSelfId, normalizeIdentityConfig, checkIdentity, describeIdentityLock, assertIdentitySendAllowed } from '../src/safety/identity-lock.js';
import { createOutboundText } from '../src/bridge/outbound-text.js';
import { createIdentityGuardedBot, refreshIdentityForSend, refreshHttpIdentityForSend, assertMcpReadOnlyAction, assertWebSocketIdentityMapping } from '../src/safety/identity-send.js';
import { createLoginRecovery } from '../src/bridge/login-recovery.js';

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log('  ok  ', name);
  } catch (error) {
    fail += 1;
    console.log('  FAIL', name, '—', error?.message ?? error);
  }
};

// ── A. 纯函数 ───────────────────────────────────────────────────────────────
check('normalizeSelfId：数字/字符串/空白都归一，非法回空', () => {
  assert.equal(normalizeSelfId(100000007), '100000007');
  assert.equal(normalizeSelfId(' 100000006 '), '100000006');
  assert.equal(normalizeSelfId('abc'), '');
  assert.equal(normalizeSelfId(''), '');
  assert.equal(normalizeSelfId(null), '');
  assert.equal(normalizeSelfId('123'), ''); // 太短，不是 QQ 号
});

check('normalizeIdentityConfig：去重去空、onMismatch 只认 warn', () => {
  const cfg = normalizeIdentityConfig({ expectedSelfIds: ['100000007', 100000007, ' ', 'abc', '100000006'], onMismatch: 'warn' });
  assert.deepEqual([...cfg.expectedSelfIds], ['100000007', '100000006']);
  assert.equal(cfg.onMismatch, 'warn');
  assert.equal(normalizeIdentityConfig({ onMismatch: 'whatever' }).onMismatch, 'lock');
  assert.equal(normalizeIdentityConfig(null).expectedSelfIds.length, 0);
  assert.equal(normalizeIdentityConfig([]).expectedSelfIds.length, 0);
});

check('checkIdentity：名单为空 = 未启用，不锁也不告警', () => {
  const r = checkIdentity({ selfId: '100000006', expectedSelfIds: [] });
  assert.equal(r.enabled, false);
  assert.equal(r.lock, false);
  assert.equal(r.ok, true);
});

check('checkIdentity：取不到 selfId 时 ready=false，不误锁', () => {
  const r = checkIdentity({ selfId: '', expectedSelfIds: ['100000007'] });
  assert.equal(r.ready, false);
  assert.equal(r.lock, false);
});

check('checkIdentity：登录号在名单内 → ok', () => {
  const r = checkIdentity({ selfId: '100000007', expectedSelfIds: ['100000007'], onMismatch: 'lock' });
  assert.equal(r.ok, true);
  assert.equal(r.lock, false);
  assert.equal(r.text, '');
});

check('checkIdentity：登录号不在名单 → 锁定（默认）', () => {
  const r = checkIdentity({ selfId: '100000006', expectedSelfIds: ['100000007'] });
  assert.equal(r.ok, false);
  assert.equal(r.lock, true);
  assert.match(r.text, /不在允许名单/);
});

check('checkIdentity：onMismatch=warn 只告警不锁', () => {
  const r = checkIdentity({ selfId: '100000006', expectedSelfIds: ['100000007'], onMismatch: 'warn' });
  assert.equal(r.ok, false);
  assert.equal(r.lock, false);
});

check('describeIdentityLock：未启用 / 未检查 / 正常 / 锁定 四种话术', () => {
  assert.match(describeIdentityLock({ enabled: false }), /未启用/);
  assert.match(describeIdentityLock({ enabled: true, checkedAt: 0 }), /尚未检查/);
  assert.match(describeIdentityLock({ enabled: true, checkedAt: 1, ok: true, selfId: '100000007' }), /正常/);
  assert.match(describeIdentityLock({ enabled: true, checkedAt: 1, ok: false, lock: true, selfId: '100000006', expected: ['100000007'] }), /已锁定/);
});

check('assertIdentitySendAllowed：固定机器人 UIN 才允许发送，warn/空名单/未验证全拒绝', () => {
  const base = { enabled: true, ready: true, ok: true, lock: false, selfId: '100000007', expected: ['100000007'], mode: 'warn' };
  assert.equal(assertIdentitySendAllowed(base), true);
  for (const state of [
    { ...base, selfId: '100000006', ok: false, lock: false },
    { ...base, ready: false },
    { ...base, selfId: '' },
    { ...base, expected: [] },
    { ...base, expected: ['100000006'] },
  ]) assert.throws(() => assertIdentitySendAllowed(state));
});

// ── B. 发送闸：锁定后一条都不许发 ───────────────────────────────────────────
function makeOutbound(identityLock) {
  const sent = [];
  const logs = [];
  const deps = {
    KNOWN_AGENT_TOKENS: [],
    SEND_TIMEOUT_MS: 5000,
    cfg: { sendDelayMs: 0 },
    socialV2: { paused: false },
    log: (...args) => logs.push(args.join(' ')),
    splitForQQ: (s) => [String(s)],
    escapeCqText: (s) => s,
    text: (s) => s,
    withTimeout: (p) => p,
    sleep: () => Promise.resolve(),
    captureSendGuard: () => () => {},
    reserveSendSlot: () => Promise.resolve(),
    lastSendFailed: new Map(),
    sendChain: Promise.resolve(),
    bot: {
      sendGroupMessage: async (id, msg) => { sent.push({ kind: 'group', id, msg }); return { messageId: 1 }; },
      sendPrivateMessage: async (id, msg) => { sent.push({ kind: 'private', id, msg }); return { messageId: 2 }; },
    },
    identityLock,
    assertIdentitySendAllowed: () => assertIdentitySendAllowed(identityLock),
    assertFreshIdentitySendAllowed: async () => assertIdentitySendAllowed(identityLock),
  };
  const api = createOutboundText(deps);
  return { api, deps, sent, logs };
}

async function main() {
  // 锁定时：不调用 bot，返回 skipped + identityLocked。
  {
    const { api, sent, logs } = makeOutbound({ lock: true, selfId: '100000006', expected: ['100000007'] });
    const r = await api.sendToQQ('group:100000003', '不该发出去的话');
    assert.equal(sent.length, 0, '锁定后不应该有任何发送');
    assert.equal(r.skipped, true);
    assert.equal(r.identityLocked, true);
    assert.ok(logs.some((l) => /身份锁拦截发送/.test(l)), '应写一条安全日志');
    pass += 1; console.log('  ok   锁定后 sendToQQ 一条都不发，并写安全日志');
  }
  // 未锁定：正常发（对照组，证明闸门不是无脑拦）。
  {
    const { api, sent } = makeOutbound({ enabled: true, ready: true, ok: true, lock: false, selfId: '100000007', expected: ['100000007'] });
    await api.sendToQQ('group:100000003', '正常内容');
    assert.equal(sent.length, 1);
    pass += 1; console.log('  ok   未锁定时 sendToQQ 正常发送');
  }

  {
    const calls = [];
    let identity = { user_id: 100000007 };
    const lock = { enabled: true, ready: false, ok: true, lock: false, selfId: '', expected: ['100000007'] };
    const guarded = createIdentityGuardedBot({
      sendGroupMessage: async (...args) => { calls.push(['group', ...args]); return 'sent'; },
      sendPrivateMessage: async (...args) => { calls.push(['private', ...args]); return 'sent'; },
      raw: async (action) => { calls.push(['raw', action]); return 'raw'; },
      rawResponse: async (action) => { calls.push(['rawResponse', action]); return 'rawResponse'; },
      call: async (action) => { calls.push(['call', action]); return 'call'; },
      request: async (action) => { calls.push(['request', action]); return 'request'; },
      setGroupKick: async (...args) => { calls.push(['kick', ...args]); return 'kicked'; },
      getLoginInfo: async () => identity,
      socket: { send() { calls.push(['socket']); } },
      accessToken: 'fixture-secret',
    }, async () => {
      const result = checkIdentity({ selfId: identity.user_id, expectedSelfIds: ['100000007'] });
      Object.assign(lock, result);
      return assertIdentitySendAllowed(lock);
    });
    await guarded.sendGroupMessage(1, 'ok');
    assert.equal(calls.length, 1);
    identity = { user_id: 100000006 };
    await assert.rejects(guarded.sendGroupMessage(1, 'blocked'));
    await assert.rejects(guarded.sendPrivateMessage(2, 'blocked'));
    await assert.rejects(guarded.raw('group_poke', {}));
    await assert.rejects(guarded.request('set_friend_add_request', {}));
    await assert.rejects(guarded.rawResponse('send_group_msg', {}));
    await assert.rejects(guarded.call('send_private_msg', {}));
    await assert.rejects(guarded.setGroupKick(1, 2));
    assert.equal(guarded.socket, undefined);
    assert.equal(guarded.accessToken, 'fixture-secret', 'token getter is retained for internal reconnect healing');
    assert.equal(guarded.constructor, undefined);
    assert.equal(guarded.valueOf(), guarded);
    assert.equal(await guarded.raw('get_forward_msg', {}), 'raw');
    assert.equal(await guarded.request('get_group_member_list', {}), 'request');
    assert.equal(calls.length, 3, '错号时除只读查询外不得调用 SDK');
    pass += 1; console.log('  ok   SDK send/raw/request/unknown mutators fail closed; read-only routes pass and socket is hidden');
  }
  {
    const calls = [];
    const guarded = createIdentityGuardedBot({
      connect: async () => { calls.push('connect'); return 'connected'; },
      close: (...args) => { calls.push(['close', ...args]); },
    }, async () => { calls.push('send-guard'); }, {
      beforeConnect: async () => { calls.push('preflight'); throw new Error('wrong account'); },
      afterConnect: async () => { calls.push('postflight'); },
    });
    await assert.rejects(guarded.connect(), /wrong account/);
    assert.deepEqual(calls, ['preflight', ['close', 4003, 'identity-mismatch']], '拒绝身份时不能 connect，且应确保旧 socket 关闭');
    const allowed = createIdentityGuardedBot({ connect: async () => { calls.push('connect-ok'); return 'connected'; }, close: (...args) => { calls.push(['close', ...args]); } }, async () => {}, {
      beforeConnect: async () => { calls.push('preflight-ok'); },
      afterConnect: async () => { calls.push('postflight-ok'); throw new Error('WS identity mismatch'); },
    });
    await assert.rejects(allowed.connect(), /WS identity mismatch/);
    assert.ok(calls.some((item) => Array.isArray(item) && item[0] === 'close' && item[1] === 4003));
    pass += 1; console.log('  ok   connect preflight blocks wrong account; postflight mismatch closes socket');
  }
  {
    let state = { enabled: true, ready: true, ok: true, lock: false, selfId: '100000007', expected: ['100000007'] };
    let freshCalls = 0;
    const { api, deps } = makeOutbound(state);
    deps.KNOWN_AGENT_TOKENS = [];
    deps.cfg.snowluma = { httpUrl: 'http://127.0.0.1:3000' };
    deps.AbortSignal = { timeout: () => undefined };
    deps.fetch = async () => { throw new Error('fetch must not run on failed identity recheck'); };
    deps.assertFreshHttpIdentitySendAllowed = async () => { freshCalls += 1; throw new Error('identity changed while queued'); };
    await assert.rejects(api.onebotSend('group', 123, 'message'));
    assert.equal(freshCalls, 1);
    pass += 1; console.log('  ok   OneBot HTTP send rechecks after pacing and before POST');
  }
  {
    let state = { enabled: true, ready: true, ok: true, lock: false, selfId: '100000007', expected: ['100000007'] };
    let login = { user_id: 100000007 };
    const logs = [];
    const checkFresh = () => refreshIdentityForSend({
      getLoginInfo: async () => login,
      applyIdentityCheck: (value) => Object.assign(state, checkIdentity({ selfId: value?.user_id, expectedSelfIds: ['100000007'] })),
      getIdentityLock: () => state,
      log: (message) => logs.push(message),
      timeoutMs: 20,
    });
    await checkFresh();
    login = { user_id: 100000006 };
    await assert.rejects(checkFresh());
    assert.equal(state.ready, false);
    login = null;
    await assert.rejects(checkFresh());
    assert.ok(logs.length >= 2);
    pass += 1; console.log('  ok   fresh identity refresh blocks switched/unknown account');
  }
  {
    let state = { enabled: true, ready: false, ok: true, lock: false, selfId: '', expected: ['100000007'] };
    let userId = 100000006;
    let requests = 0;
    const logs = [];
    await assert.rejects(refreshHttpIdentityForSend({
      httpUrl: 'http://127.0.0.1:3000',
      fetch: async (url, init) => {
        requests += 1;
        assert.match(url, /get_login_info$/);
        assert.equal(init.method, 'POST');
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: userId } }) };
      },
      AbortSignal: { timeout: () => undefined },
      applyIdentityCheck: (login) => Object.assign(state, checkIdentity({ selfId: login?.user_id, expectedSelfIds: ['100000007'] })),
      getIdentityLock: () => state,
      log: (line) => logs.push(line),
    }));
    assert.equal(requests, 1);
    assert.equal(state.ready, false);
    await assert.rejects(refreshHttpIdentityForSend({ httpUrl: 'https://remote.example', fetch: async () => { throw new Error('must not fetch remote'); }, applyIdentityCheck() {}, getIdentityLock: () => state, log: () => {} }));
    pass += 1; console.log('  ok   same-endpoint HTTP identity check blocks personal UIN and rejects remote targets');
  }
  {
    const calls = [];
    let lockForTest = { enabled: true, ready: false, ok: true, lock: false, selfId: '', expected: ['100000007'] };
    const recovery = createLoginRecovery({
      cfg: { allow: { privateOpen: true }, socialV2: { autoAcceptFriendRequests: true }, snowluma: { httpUrl: 'http://127.0.0.1:3000' } },
      AbortSignal: { timeout: () => undefined },
      assertFreshHttpIdentitySendAllowed: async () => {
        calls.push('guard');
        const refreshed = await refreshHttpIdentityForSend({
          httpUrl: 'http://127.0.0.1:3000',
          fetch: async (url) => {
            calls.push(url.split('/').at(-1));
            return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 100000007 } }) };
          },
          AbortSignal: { timeout: () => undefined },
          applyIdentityCheck: (login) => { lockForTest = Object.assign(lockForTest, checkIdentity({ selfId: login?.user_id, expectedSelfIds: ['100000007'] })); },
          getIdentityLock: () => lockForTest,
          log: () => {},
        });
        assert.equal(String(refreshed.user_id), '100000007');
      },
      fetch: async (url) => {
        calls.push(url.split('/').at(-1));
        if (url.endsWith('get_doubt_friends_add_request')) return { json: async () => ({ status: 'ok', data: [{ user_id: 'u1', uid: 'flag1' }] }) };
        return { json: async () => ({ status: 'ok' }) };
      },
      log: () => {},
    });
    await recovery.approveDoubtFriendRequests();
    assert.deepEqual(calls, ['get_doubt_friends_add_request', 'guard', 'get_login_info', 'set_doubt_friends_add_request']);
    pass += 1; console.log('  ok   auto friend approval refreshes identity immediately before write');
  }
  {
    const calls = [];
    const cfg = { allow: {}, socialV2: {}, snowluma: { accessToken: 'original-http', wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' } };
    const bot = { accessToken: 'original-ws', url: 'ws://127.0.0.1:3001', close() { calls.push('close'); }, connect() { calls.push('connect'); } };
    const recovery = createLoginRecovery({
      cfg,
      bot,
      ROOT: '.',
      path: { join: (...parts) => parts.join('/') },
      log: () => {},
      assertDiscoveredIdentityAllowed: async (candidate) => {
        calls.push('verify-candidate');
        assert.equal(String(candidate?.self?.user_id ?? ''), '100000007');
      },
      persistSnowLumaEndpoint: () => { calls.push('persist'); return { updated: false, changed: {} }; },
    });
    await assert.rejects(recovery.applyHealedTokens({
      token: 'personal-token', wsToken: 'personal-ws', wsUrl: 'ws://127.0.0.1:3999', baseUrl: 'http://127.0.0.1:3998',
      self: { user_id: 100000006 }, source: 'fixture',
    }));
    assert.equal(cfg.snowluma.accessToken, 'original-http');
    assert.equal(bot.accessToken, 'original-ws');
    assert.equal(bot.url, 'ws://127.0.0.1:3001');
    assert.deepEqual(calls, ['verify-candidate'], 'must reject before mutation, persistence, close or reconnect');
    pass += 1; console.log('  ok   token healing rejects a non-bot discovery before changing config or reconnecting');
  }
  check('WebSocket endpoint/token must match the verified fixed-bot mapping', () => {
    const candidate = { self: { user_id: 100000007 }, wsUrl: 'ws://127.0.0.1:3001', wsToken: 'bot-ws-token' };
    assert.equal(assertWebSocketIdentityMapping(candidate, { url: candidate.wsUrl, accessToken: candidate.wsToken }), true);
    assert.throws(() => assertWebSocketIdentityMapping({ ...candidate, self: { user_id: 100000006 } }, { url: candidate.wsUrl, accessToken: candidate.wsToken }));
    assert.throws(() => assertWebSocketIdentityMapping(candidate, { url: 'ws://127.0.0.1:3999', accessToken: candidate.wsToken }));
    assert.throws(() => assertWebSocketIdentityMapping(candidate, { url: candidate.wsUrl, accessToken: 'personal-token' }));
    assert.throws(() => assertWebSocketIdentityMapping({ ...candidate, wsToken: null }, { url: candidate.wsUrl, accessToken: null }));
    assert.throws(() => assertWebSocketIdentityMapping({ ...candidate, wsUrl: 'wss://remote.example/socket' }, { url: 'wss://remote.example/socket', accessToken: candidate.wsToken }));
    pass += 1; console.log('  ok   WebSocket endpoint/token must match the verified fixed-bot mapping');
  });
  check('MCP OneBot client only allows explicit read actions', () => {
    for (const action of ['get_login_info', 'get_status', 'get_group_list', 'get_group_msg_history']) assert.equal(assertMcpReadOnlyAction(action), undefined);
    for (const action of ['send_group_msg', 'send_private_msg', 'set_doubt_friends_add_request', 'group_poke']) assert.throws(() => assertMcpReadOnlyAction(action));
  });
  console.log(`\n身份锁：通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exitCode = 1;
}
await main();
