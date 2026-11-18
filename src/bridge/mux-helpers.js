// mux-helpers: 单轮步数上限 / 传输层注入 / 取消回执等纯辅助（从 mux-runtime.js 拆出，
// 让 mux-runtime.js 回到 800 行文件红线以下）。无启动副作用。
// ⑨ 单轮步数上限（2026-10-28）：普通聊天 socialV2.turnMaxSteps（默认 25，0=不限），
// 黑话学习走 socialV2.slangLearn.maxStepsPerRun（默认 12，0=不限），两条路径互不影响。
// 而 tool/call 只有 58 个 —— 只数 tool/call 会把上限数漏，138 步那轮就是这么跑穿的）。
// 记账与收尾都放模块作用域，避免撑大冻结的 createMuxRuntime/pumpMux。
const TURN_STEP_STATE = new Map(); // sessionId -> { steps, stopped, sawStep, currentStep }
// 工具日志补 step 用：step/start 里 DSH 自带的 step 字段优先，没有就用我们自增的步数。
// 只读不写（guardTurnSteps 负责维护），导出给 bridge.js 注入 muxCurrentStep。
export function muxCurrentStep(sessionId) {
  const state = TURN_STEP_STATE.get(sessionId);
  return state && Number.isFinite(state.currentStep) ? state.currentStep : null;
}
export function turnStepLimit(cfg, learner) {
  const social = cfg?.socialV2 && typeof cfg.socialV2 === 'object' ? cfg.socialV2 : {};
  // 纯净模式（②）：有效步数上限固定 6 —— 这里才是运行期真正被 guardTurnSteps 读的值，
  // 只看 cfg 里被 loadConfig 压过的数不够（热加载/别处替换 cfg 时可能绕过）。6 与
  // src/pure-mode.js 的 PURE_MODE_TURN_MAX_STEPS 一致（模块源码不能 import，测试里有等值断言）。
  if (!learner && social.pureMode && social.pureMode.enabled === true) return 6;
  const raw = learner ? social.slangLearn?.maxStepsPerRun : social.turnMaxSteps;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
// 到步数上限时**不发任何消息**（2026-10-29 用户明确要求取消）。
// 演进史：最早把「这轮说到 8 步了…」发进群（像机器自报参数）→ 换成「等下 / 让我捋捋」
// 这类短句（还是突兀：聊天里突然插一句没来由的收尾，像被打断的旁白）→ 现在直接闭嘴，
// 只写后端日志 + 停止本轮。别再加回来：用户观察了多轮，结论是「以后就直接不发了」。
// Agent 传输层注入点（P0，零行为变化）：装了 deps.agentTransport 就走它（默认是 dsh transport，
// 内部仍转发到同一个 NodeApiClient），没装就原样用 deps.api / deps.createTurnCollector。
// 这样任意 agent 只要实现同一 shape 就能接进来，旧路径永远是 fallback；mux 的业务分支一律不动。
export function agentTransportOf(deps) {
  const transport = deps.agentTransport;
  if (transport && typeof transport.events === 'function') return transport;
  return {
    events: () => deps.api.events.mux({}),
    respond: (message) => deps.api.respond(message),
    stopSessionWork: (sessionId, options) => deps.api.stopSessionWork(sessionId, options),
    createCollector: () => deps.createTurnCollector(),
    get baseUrl() { return deps.api.baseUrl; },
    set baseUrl(value) { deps.api.baseUrl = value; },
    invalidateAuth: () => deps.api.invalidateAuth(),
    discoverBaseUrl: (options) => deps.discoverDshBaseUrl({ current: options?.current ?? deps.api.baseUrl, log: options?.log ?? deps.log })
  };
}
// host 工具循环（P1）：caps.toolLoop==='host' 时模型只回 tool_calls，工具由桥接执行。
export function agentToolLoopModeOf(deps) {
  if (deps?.cfg?.agent?.type === 'openai') return 'host';
  const transport = deps?.agentTransport;
  if (!transport || typeof transport.capabilities !== 'function') return 'agent';
  try { const caps = transport.capabilities(); return caps && typeof caps === 'object' && caps.toolLoop ? caps.toolLoop : 'agent'; } catch { return 'agent'; }
}
export async function runHostTurn(deps, request) {
  const transport = (typeof deps?.agentTransportFor === 'function' ? deps.agentTransportFor(deps.cfg?.agent?.type) : null) || agentTransportOf(deps);
  if (typeof transport.startTurn !== 'function') return { ok: false, text: '', events: [], usage: null, error: '当前 agent transport 不支持 startTurn（host 工具循环）' };
  const events = []; const textParts = []; let usage = null; let error = '';
  try {
    for await (const event of transport.startTurn(request ?? {})) {
      if (!event || typeof event !== 'object') continue;
      events.push(event);
      // host 工具日志：工具由桥接执行（不过 DSH 事件泵），补同格式记录供工具统计/排查。
      try { if (typeof deps.appendToolLog === 'function' && (event.type === 'tool_call' || event.type === 'tool_result')) { const sid = request?.sessionId ?? ''; const call = event.type === 'tool_call'; (0, deps.appendToolLog)({ type: call ? 'call' : 'result', time: new Date().toISOString(), key: request?.key ?? '', sessionId: sid, turn: deps.currentTurnBySession?.get?.(sid) ?? 0, ...(call ? { step: 1, tool: String(event.name ?? ''), args: JSON.stringify(event.arguments ?? {}) } : { ok: event.ok !== false, error: event.error ? String(event.error) : null }) }); } } catch {}
      if (event.type === 'text_delta' && typeof event.text === 'string') textParts.push(event.text);
      if (event.type === 'usage' && event.usage) usage = event.usage;
      if (event.type === 'error') { error = String(event.error ?? '未知错误'); break; }
    }
  } catch (caught) { error = `host 工具循环异常：${caught?.message ?? caught}`; }
  return { ok: !error, text: textParts.join(''), events, usage, error };
}
export async function guardTurnSteps(deps, frame) {
  const event = frame?.event;
  if (!event || typeof event.type !== 'string') return;
  const sid = frame.sessionId;
  const learner = Boolean(deps.learnerSessions?.has(sid));
  if (event.type === 'turn/end') { TURN_STEP_STATE.delete(sid); return; }
  if (event.type === 'turn/start') { TURN_STEP_STATE.set(sid, { steps: 0, stopped: false, sawStep: false, currentStep: 0 }); return; }
  const isStep = event.type === 'step/start';
  if (!isStep && event.type !== 'tool/call') return;
  const limit = turnStepLimit(deps.cfg, learner);
  if (limit <= 0) return;
  const state = TURN_STEP_STATE.get(sid) ?? { steps: 0, stopped: false, sawStep: false, currentStep: 0 };
  TURN_STEP_STATE.set(sid, state);
  if (isStep) {
    state.sawStep = true;
    state.steps += 1;
    const evented = Number(event.data?.step);
    // 工具日志要的是「工具是在第几步被调的」：DSH 给 step 就用它，没给就用自增步数。
    state.currentStep = Number.isFinite(evented) && evented > 0 ? evented : state.steps;
  }
  else if (state.sawStep) return; // 已有真实步事件：tool/call 不再重复计数
  else state.steps += 1;          // 旧版 DSH 没有 step/*：退回按工具调用估步
  if (state.stopped || state.steps < limit) return;
  state.stopped = true;
  const where = learner ? '黑话学习' : '普通聊天';
  const field = learner ? 'socialV2.slangLearn.maxStepsPerRun' : 'socialV2.turnMaxSteps';
  (0, deps.log)(`[步数上限] ${where}会话 ${sid} 单轮已到 ${limit} 步，收尾本轮（${field} 可调，0=不限）`);
  try {
    if (typeof deps.appendActivity === 'function') deps.appendActivity('turn-step-capped', { sessionId: sid, steps: state.steps, limit, learner });
    // 到上限就安静收尾：不发「等下 / 让我捋捋」这类过渡句。
    // 私聊、群聊一视同仁 —— 聊天里凭空插一句收尾话，比直接安静下来更突兀。
  } catch (error) { (0, deps.log)(`[步数上限] 收尾提示发送失败：${error?.message ?? error}`); }
  try {
    const opts = { timeoutMs: deps.DSH_CONTROL_TIMEOUT_MS };
    await (0, deps.withTimeout)(agentTransportOf(deps).stopSessionWork(sid, opts), deps.DSH_CONTROL_TIMEOUT_MS, 'turn-step-cap');
  } catch (error) { (0, deps.log)(`[步数上限] 停止本轮失败：${error?.message ?? error}`); }
  try { const k = deps.reverse?.get(sid); if (k && deps.keyHasRecentMedia?.(k) && deps.scheduleMediaFollowup) (0, deps.scheduleMediaFollowup)(k, 'stepCapMediaFollowup'); } catch (error) { (0, deps.log)(`[步数上限] 补看唤醒安排失败：${error?.message ?? error}`); }
}
// ── 工具结果的「取消回执」与错误文本 ─────────────────────────────────────
// DSH 取消一个正在飞行的工具调用时，错误体是个对象（{code,message}）而不是字符串；
// 直接 String() 落成「[object Object]」，控制台里就成了一条看不懂的红色失败。
// 另外「回合被中止」本身不是工具失败：中止后 15 秒内回来的错误结果按取消记。
const MUX_ABORT_GRACE_MS = 15000;
export const MUX_ABORT_MARKS = new Map(); // sessionId -> 最近一次「回合被中止」的时间

function muxErrorText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const picked = value.message ?? value.error ?? value.msg;
    if (typeof picked === 'string' && picked.trim()) return picked.trim();
    try {
      const text = JSON.stringify(value);
      return text && text !== '{}' ? text : '';
    } catch {
      return '';
    }
  }
  return String(value);
}

// 纯函数：把一条 tool/result 的原始字段算成「要不要当失败显示」。
// 抽出来是为了能单测 —— 线上就是这里把「回合中止」显示成红色报错的。
export function describeToolResult({ resultError, rawError, abortAt, now } = {}) {
  const at = Number(now ?? Date.now());
  const mark = Number(abortAt ?? 0);
  const errorText = resultError ? muxErrorText(rawError) : '';
  const cancelled = Boolean(resultError) && mark > 0 && at - mark >= 0 && at - mark <= MUX_ABORT_GRACE_MS;
  return { errorText, cancelled };
}
// 占位 factory：满足 manifest 模块约定（installBridgeModules 会 globalThis.createMuxHelpers=...），
// 辅助函数本身靠模块加载顺序进 VM 全局，mux-runtime.js 经 import 使用（VM 里 import 被剥）。
export function createMuxHelpers() { return {}; }
