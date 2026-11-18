// upstream-health: extracted bridge responsibilities; no startup side effects.
// Live dependencies: AbortSignal, SNOWLUMA_SILENCE_WARN_MS, SNOWLUMA_STATUS_POLL_MS, cfg, checkDsh, dshCheckStarted, fetch, log, setInterval, setTimeout, snowlumaHealth, snowlumaWatchStarted
export function createUpstreamHealth(deps) {
// @bridge-function startDshWatch:start
function startDshWatch() {
    if (deps.dshCheckStarted) return;
    deps.dshCheckStarted = true;
    (0, deps.checkDsh)();
    (0, deps.setInterval)(deps.checkDsh, 5000);
  }
// @bridge-function startDshWatch:end

// @bridge-function noteUpstreamPacket:start
function noteUpstreamPacket(kind) {
    deps.snowlumaHealth.lastPacketAt = Date.now();
    deps.snowlumaHealth.lastPacketKind = String(kind ?? '');
  }
// @bridge-function noteUpstreamPacket:end

// @bridge-function noteReceiveHealth:start
function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    deps.snowlumaHealth.good = good;
    deps.snowlumaHealth.goodSource = source;
    deps.snowlumaHealth.goodError = '';
    deps.snowlumaHealth.goodCheckedAt = Date.now();
  }
// @bridge-function noteReceiveHealth:end

// @bridge-function snowlumaHealthSnapshot:start
function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = deps.snowlumaHealth.lastPacketAt ? now - deps.snowlumaHealth.lastPacketAt : null;
    const silent = deps.snowlumaHealth.lastPacketAt > 0 && agoMs > deps.SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = deps.snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: deps.snowlumaHealth.connected,
      accountOnline: deps.snowlumaHealth.accountOnline,
      good: deps.snowlumaHealth.good,
      goodSource: deps.snowlumaHealth.goodSource || null,
      goodError: deps.snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: deps.snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }
// @bridge-function snowlumaHealthSnapshot:end

// @bridge-function reportSnowlumaHealth:start
function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !deps.snowlumaHealth.degraded) {
      deps.snowlumaHealth.degraded = true;
      deps.snowlumaHealth.reason = snap.hint ?? '';
      (0, deps.log)(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      (0, deps.log)('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      (0, deps.log)('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && deps.snowlumaHealth.degraded) {
      deps.snowlumaHealth.degraded = false;
      deps.snowlumaHealth.reason = '';
      (0, deps.log)('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }
// @bridge-function reportSnowlumaHealth:end

// @bridge-function pollSnowlumaStatus:start
async function pollSnowlumaStatus() {
    const httpUrl = String(deps.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await (0, deps.fetch)(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(deps.cfg.snowluma?.accessToken ? { authorization: `Bearer ${deps.cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: deps.AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        deps.snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') deps.snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      deps.snowlumaHealth.goodError = error?.message ?? String(error);
    }
    deps.snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }
// @bridge-function pollSnowlumaStatus:end

// @bridge-function startSnowlumaWatch:start
function startSnowlumaWatch() {
    if (deps.snowlumaWatchStarted) return;
    deps.snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    (0, deps.setTimeout)(() => { void pollSnowlumaStatus(); }, 5000);
    (0, deps.setInterval)(() => { void pollSnowlumaStatus(); }, deps.SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    (0, deps.setInterval)(reportSnowlumaHealth, 30_000);
  }
// @bridge-function startSnowlumaWatch:end

// @bridge-function v2ToolEnabled:start
function v2ToolEnabled(flag) {
    return deps.cfg.socialV2?.tools?.[flag] !== false;
  }
// @bridge-function v2ToolEnabled:end
  return { startDshWatch, noteUpstreamPacket, noteReceiveHealth, snowlumaHealthSnapshot, reportSnowlumaHealth, pollSnowlumaStatus, startSnowlumaWatch, v2ToolEnabled };
}
