import { assertIdentitySendAllowed as assertIdentitySnapshotAllowed, REQUIRED_BOT_SELF_ID } from './identity-lock.js';

const READ_ONLY_REQUESTS = new Set([
  'get_login_info', 'get_status', 'get_group_list', 'get_group_msg_history',
  'get_group_member_list', 'get_forward_msg', 'get_msg', 'fetch_custom_face_detail',
]);
const READ_ONLY_METHODS = new Set([
  'getLoginInfo', 'getStatus', 'getVersionInfo', 'canSendImage', 'canSendRecord',
  'getMessage', 'getFriendList', 'getStrangerInfo', 'getGroupList', 'getGroupInfo',
  'getGroupMemberList', 'getGroupMemberInfo', 'getGroupHonorInfo', 'getGroupSystemMessages',
  'getGroupFileUrl', 'getGroupRootFiles', 'getGroupFilesByFolder', 'getPrivateFileUrl',
  'getGroupNotice', 'getForwardMessage', 'getEssenceMessageList', 'getGroupFileSystemInfo',
  'getGroupInfoEx', 'getGroupDetailInfo', 'checkUrlSafely', 'getClientKey', 'getImage', 'getRecord', 'getCookies',
  'getCsrfToken', 'getCredentials', 'fetchSysFaces', 'fetchFaceEntity', 'searchSysFaces',
  'fetchSuperFaceId', 'getGroupMessageHistory', 'getFriendMessageHistory', 'getRKey',
]);
const LIFECYCLE_METHODS = new Set(['connect', 'close', 'on', 'once', 'off', 'onEvent', 'onPrivateMessage', 'onGroupMessage', 'onNotice', 'onRequest', 'onBotStatus', 'onMetaEvent', 'onMessage']);
const MCP_READ_ONLY_ACTIONS = new Set(['get_login_info', 'get_status', 'get_group_list', 'get_group_msg_history']);

export function assertMcpReadOnlyAction(action) {
  const name = String(action ?? '');
  if (!MCP_READ_ONLY_ACTIONS.has(name)) throw new Error(`OneBot action is not allowed through the read-only MCP client: ${name || '(empty)'}`);
}

export function assertLocalWebSocketEndpoint(wsUrl) {
  let endpoint;
  try { endpoint = new URL(String(wsUrl ?? '')); } catch { throw new Error('SnowLuma WebSocket 身份复核端点无效'); }
  const localHost = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]';
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || !localHost || endpoint.username || endpoint.password) {
    throw new Error('SnowLuma WebSocket 身份复核仅允许本机端点');
  }
  return endpoint;
}

export function assertWebSocketIdentityMapping(candidate, current) {
  const candidateId = String(candidate?.self?.user_id ?? candidate?.self?.userId ?? '');
  if (candidateId !== REQUIRED_BOT_SELF_ID) throw new Error('拒绝采用其他 QQ 账号的 WebSocket 映射');
  if (!candidate?.wsUrl || !candidate?.wsToken) throw new Error('固定机器人账号缺少可验证的 WebSocket 映射');
  assertLocalWebSocketEndpoint(candidate.wsUrl);
  if (String(current?.url ?? '') !== String(candidate.wsUrl) || String(current?.accessToken ?? '') !== String(candidate.wsToken)) {
    throw new Error('当前 WebSocket 地址/token 与已验证机器人账号映射不一致');
  }
  return true;
}

export function assertLoginInfoSendAllowed(login) {
  const state = {
    enabled: true,
    ready: Boolean(login?.user_id ?? login?.userId),
    ok: String(login?.user_id ?? login?.userId ?? '') === REQUIRED_BOT_SELF_ID,
    lock: String(login?.user_id ?? login?.userId ?? '') !== REQUIRED_BOT_SELF_ID,
    selfId: String(login?.user_id ?? login?.userId ?? ''),
    expected: [REQUIRED_BOT_SELF_ID],
  };
  return assertIdentitySnapshotAllowed(state);
}

export async function refreshIdentityForSend({ getLoginInfo, applyIdentityCheck, getIdentityLock, log, timeoutMs = 2500 }) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('读取 SnowLuma 当前登录号超时')), timeoutMs);
    });
    const login = await Promise.race([Promise.resolve().then(getLoginInfo), timeout]);
    applyIdentityCheck(login);
    assertIdentitySnapshotAllowed(getIdentityLock());
    return login;
  } catch (error) {
    applyIdentityCheck(null);
    log(`[安全] 出站身份复核失败，按 fail-closed 拦截：${error?.message ?? error}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshHttpIdentityForSend({ httpUrl, accessToken, fetch, AbortSignal = globalThis.AbortSignal, applyIdentityCheck, getIdentityLock, log, timeoutMs = 2500 }) {
  return refreshIdentityForSend({
    getLoginInfo: async () => {
      let endpoint;
      try { endpoint = new URL(String(httpUrl ?? '')); } catch { throw new Error('SnowLuma HTTP 身份复核端点无效'); }
      const localHost = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]';
      if (endpoint.protocol !== 'http:' || !localHost || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
        throw new Error('SnowLuma HTTP 身份复核仅允许本机根端点');
      }
      if (typeof fetch !== 'function') throw new Error('SnowLuma HTTP 身份复核 fetch 不可用');
      const response = await fetch(`${endpoint.origin}/get_login_info`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        cache: 'no-store',
      });
      if (!response?.ok) throw new Error(`读取 SnowLuma HTTP 登录号失败：HTTP ${response?.status ?? '未知'}`);
      const body = await response.json();
      if (body?.status !== 'ok' || body?.retcode !== 0 || !body?.data) throw new Error('SnowLuma HTTP 登录号响应无效');
      return body.data;
    },
    applyIdentityCheck,
    getIdentityLock,
    log,
    timeoutMs,
  });
}

export function createIdentityGuardedBot(bot, guard, { beforeConnect, afterConnect } = {}) {
  if (!bot || typeof bot !== 'object') throw new TypeError('SnowLuma bot instance is required');
  let guarded;
  guarded = new Proxy(bot, {
    get(target, property) {
      // Hide the live socket through direct/reflection reads; keep URL/token state for reconnect healing.
      if (property === 'socket' || property === 'WebSocketCtor' || property === 'constructor' || property === '__proto__') return undefined;
      if (property === 'valueOf') return () => guarded;
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'connect') {
        return async (...args) => {
          try {
            if (beforeConnect) await beforeConnect();
            else await guard();
            const connected = await value.apply(target, args);
            if (afterConnect) await afterConnect();
            return connected;
          } catch (error) {
            try { target.close(4003, 'identity-mismatch'); }
            catch (closeError) { throw new AggregateError([error, closeError], 'WebSocket identity verification failed and close also failed'); }
            throw error;
          }
        };
      }
      const ensureConnected = async () => {
        if (typeof target.connect === 'function' && target.isConnected !== true) await guarded.connect();
      };
      if (property === 'sendGroupMessage' || property === 'sendPrivateMessage') {
        return async (...args) => { await ensureConnected(); await guard(); return value.apply(guarded, args); };
      }
      if (property === 'request' || property === 'raw' || property === 'rawResponse' || property === 'call') {
        return async (action, ...args) => {
          await ensureConnected();
          if (!READ_ONLY_REQUESTS.has(String(action))) await guard();
          return value.call(target, action, ...args);
        };
      }
      if (LIFECYCLE_METHODS.has(String(property))) return value.bind(target);
      if (READ_ONLY_METHODS.has(String(property))) {
        return async (...args) => { await ensureConnected(); return value.apply(target, args); };
      }
      // Unknown SDK methods fail closed, and identity-check the connection before SDK internals can connect.
      return async (...args) => { await ensureConnected(); await guard(); return value.apply(target, args); };
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => key !== 'socket' && key !== 'WebSocketCtor');
    },
    getOwnPropertyDescriptor(target, property) {
      if (property === 'socket' || property === 'WebSocketCtor') return undefined;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    set(target, property, value) {
      if (property === 'socket' || property === 'WebSocketCtor') return false;
      return Reflect.set(target, property, value, target);
    },
    defineProperty(target, property, descriptor) {
      if (property === 'socket' || property === 'WebSocketCtor') return false;
      return Reflect.defineProperty(target, property, descriptor);
    },
    getPrototypeOf() {
      // Do not expose the SDK constructor through Object.getPrototypeOf(proxy).constructor.
      return null;
    },
    setPrototypeOf() {
      return false;
    },
    preventExtensions() {
      return false;
    },
  });
  return guarded;
}
