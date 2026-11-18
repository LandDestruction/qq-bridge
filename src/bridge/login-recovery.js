// login-recovery: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, ROOT, assertFreshHttpIdentitySendAllowed, bot, cfg, discoverSnowLumaConnection, fetch, log, path, persistSnowLumaEndpoint, persistToken, tokenHealAt
export function createLoginRecovery(deps) {
// @bridge-function approveDoubtFriendRequests:start
async function approveDoubtFriendRequests() {
    if (deps.cfg.allow?.privateOpen !== true || deps.cfg.socialV2?.autoAcceptFriendRequests === false) return;
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const auth = deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {};
    const call = async (action, body) => {
      if (action === 'set_doubt_friends_add_request') await (0, deps.assertFreshHttpIdentitySendAllowed)();
      return (0, deps.fetch)(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify(body),
        signal: deps.AbortSignal.timeout(10000)
      }).then((res) => res.json());
    };

    const list = await call('get_doubt_friends_add_request', { count: 50 });
    if (list?.status !== 'ok' || !Array.isArray(list.data) || list.data.length === 0) return;
    for (const item of list.data) {
      const uid = String(item.user_id ?? '');
      if (!uid) continue;
      const done = await call('set_doubt_friends_add_request', { flag: item.uid, approve: true });
      (0, deps.log)(done?.status === 'ok'
        ? `已自动通过好友申请：${uid}（${item.nick ?? '无昵称'}）`
        : `好友申请处理失败 ${uid}：${done?.wording ?? '未知错误'}`);
    }
  }
// @bridge-function approveDoubtFriendRequests:end

// @bridge-function applyHealedTokens:start
async function applyHealedTokens(r) {
    await deps.assertDiscoveredIdentityAllowed(r);
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = deps.cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || deps.cfg.snowluma.wsUrl) : deps.cfg.snowluma.wsUrl;
    const wsChanged = deps.bot.accessToken !== wsToken || deps.bot.url !== wsUrl;
    deps.bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    deps.bot.url = wsUrl;
    if (wsChanged) (0, deps.log)(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (deps.cfg.snowluma.accessToken !== httpToken) {
      (0, deps.log)(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(deps.cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      deps.cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== deps.cfg.snowluma.wsUrl) {
      (0, deps.log)(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${deps.cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = deps.cfg.snowluma.wsUrl;
    deps.cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = (0, deps.persistSnowLumaEndpoint)(deps.path.join(deps.ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) (0, deps.log)(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else (0, deps.log)('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) deps.cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      (0, deps.log)(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { deps.bot.close(1000, 'token-refresh'); }
      catch (error) { (0, deps.log)(`[安全] 关闭旧 SnowLuma 连接失败：${error?.message ?? error}`); }
      try { await deps.assertIdentityReconnectAllowed(); await deps.bot.connect(); }
      catch (error) { (0, deps.log)(`[安全] 自愈后连接未启动：${error?.message ?? error}`); throw error; }
    }
    return wsChanged;
  }
// @bridge-function applyHealedTokens:end

// @bridge-function syncTokenToFile:start
async function syncTokenToFile() {
    try {
      const r = (0, deps.persistToken)(deps.path.join(deps.ROOT, 'config.json'), deps.cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) (0, deps.log)('🔄 已把当前 token 写回 config.json');
    } catch {}
  }
// @bridge-function syncTokenToFile:end

// @bridge-function healTokenIfStale:start
async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - deps.tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    deps.tokenHealAt = now;
    try {
      const r = await (0, deps.discoverSnowLumaConnection)({ cfg: deps.cfg, timeoutMs: 4000 });
      if (!r.ok) {
        (0, deps.log)(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      (0, deps.log)(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      (0, deps.log)(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }
// @bridge-function healTokenIfStale:end
  return { approveDoubtFriendRequests, applyHealedTokens, syncTokenToFile, healTokenIfStale };
}
