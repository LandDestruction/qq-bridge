// 自报家门（D37）：回答「你现在用的是哪个模型」。
//
// 为什么不能直接读 config.json —— 这是本模块存在的唯一理由：
// config 里的 `dsh.provider/model` 只是**配置默认值**，不是某一轮真正在跑的模型。
// `state/token-usage.jsonl` 里 `k:"base"` 的行写的是会话创建时抄下来的那份默认
// （线上实测 `workbuddy2api/deepseek-v4.1-flash`），而 `k:"turn"` 的行才是实际推理用的
// （`deepseek-account/deepseek-flash`）。D33 就是拿 base 行当证据，把「视觉路由没生效」
// 误判了一整晚，所以这里按可信度排序，并且**必须把回落值标出来**：
//   override（运行期覆盖，带 reason）
//   > applied（本会话本 epoch 真正 selectModel 生效的那一对，含 media 强制/路由来源）
//   > billed（最近一回合实际计费的模型；只收 turn 采样，绝不收 base）
//   > config-default（配置默认值，标 source 让模型知道这是回落值，别当实况说）
//
// 纯函数、不碰文件、不碰网络：bridge 只负责把运行期事实取出来喂进来，方便离线单测。

/** 提示词里的一行（≤60 字符预算）。挂在 identity 附近，名称就是 prompt-parts 的 selfModel。 */
export const SELF_MODEL_PROMPT = '【自报家门】被问到用什么模型/版本时，先调 qq_self_model 查真实值再答，别猜。';

/** 四种来源 + 回落值的展示名（bridge/控制台/模型看到的是同一套词）。 */
export const SELF_MODEL_SOURCE_LABEL = {
  override: '运行期覆盖',
  media: '含图轮视觉路由',
  kind: '按群/私聊指定',
  session: '本会话本轮实际选型',
  billed: '最近一回合实际计费',
  'config-default': '配置默认值（回落）'
};

/**
 * 运行期覆盖的 reason 是内部短码（'console' / 'malformed tool-call json' / 'empty reply' /
 * 中文自由文本）。给人看的句子在这里翻译，别把内部码原样丢给模型。
 */
const OVERRIDE_REASON_TEXT = {
  console: '管理员在控制台把主模型切成了这个',
  'malformed tool-call json': '上一轮工具调用 JSON 坏了，临时换模型重试',
  'empty reply': '上一轮模型返回空回复，临时换模型重试'
};

const ROUTE_REASON_TEXT = {
  media: '这一轮带了图，用视觉路由（socialV2.modelRouting.visionIdle/visionPeak）',
  idle: '空闲时段路由（socialV2.modelRouting.idle）',
  peak: '高峰时段路由（socialV2.modelRouting.peak）',
  fallback: '主模型不可用时走的降级候选（socialV2.modelRouting.fallback）',
  kind: '按群/私聊指定（socialV2.modelByKind）'
};

/** provider/model 都要非空才算「一对能用的模型」。 */
function pairOf(value) {
  const provider = String(value?.provider ?? '').trim();
  const model = String(value?.model ?? '').trim();
  return provider && model ? { provider, model } : null;
}

export function describeOverrideReason(override) {
  const raw = String(override?.reason ?? '').trim();
  if (!raw) return '主模型不可用，已临时切到备用模型';
  return OVERRIDE_REASON_TEXT[raw] ?? '主模型不可用/被限流，已临时切到备用模型';
}

function describeRoute(source) {
  return ROUTE_REASON_TEXT[source] ?? '';
}

/**
 * DSH 会话 id 只露后 8 位。
 * 完整 sessionId 能把人引到 DSH 控制台的会话上，没必要给；后 8 位够在日志里对照。
 */
export function sessionTailOf(sessionId) {
  const sid = String(sessionId ?? '');
  return sid ? sid.slice(-8) : null;
}

/**
 * 选出生效模型。返回值不含 token / 完整 sid / baseUrl。
 * @returns {{provider:string, model:string, source:string, reason:string, route:string} | null}
 */
export function resolveSelfModel({ override, applied, billed, cfg } = {}) {
  const over = pairOf(override);
  if (over) {
    return { ...over, source: 'override', reason: describeOverrideReason(override), route: 'override' };
  }
  const app = pairOf(applied);
  if (app) {
    const src = applied?.source;
    const media = src === 'media' || applied?.media === true;
    return {
      ...app,
      source: media ? 'media' : (src === 'kind' ? 'kind' : 'session'),
      reason: describeRoute(src),
      route: String(src ?? (media ? 'media' : 'session'))
    };
  }
  // base 行 = 会话创建时抄的配置默认，等于把配置当实况；宁可标 config-default 也不拿它充数。
  const bill = billed && billed.source !== 'base' ? pairOf(billed) : null;
  if (bill) {
    return {
      ...bill,
      source: 'billed',
      reason: '桥接进程里还没有本会话的选型记录（刚重启/还没投递过），这是最近一回合实际计费的模型',
      route: 'billed'
    };
  }
  const cfgPair = pairOf(cfg?.dsh);
  if (cfgPair) {
    return {
      ...cfgPair,
      source: 'config-default',
      reason: '本会话还没跑过一回合，这是配置默认值，不代表实际推理用的模型',
      route: 'config-default'
    };
  }
  return null;
}

/**
 * 上下文占用：用最近一回合实际计费的 token 桶估算「下一轮的提示有多大」。
 * 只做保守估计：projected = 输入桶 + 输出桶；没有可信样本时给 null 而不是 0
 * （0 会被读成「上下文是空的」，比不知道更糟）。
 * window 只能来自配置（DSH 的 modelCatalog 不返回上下文长度）：没有配置就不给 pct。
 */
export function contextFromBuckets(buckets, { windowTokens = null } = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const input = num(buckets?.cacheMiss) + num(buckets?.cacheHit) + num(buckets?.cacheWrite);
  const output = num(buckets?.output);
  const projected = input + output;
  const win = Number(windowTokens) > 0 ? Number(windowTokens) : null;
  if (!(projected > 0)) return { projected: null, window: win, pct: null, basis: 'last-billed-turn' };
  return {
    projected,
    window: win,
    pct: win ? Math.round((projected / win) * 1000) / 10 : null,
    basis: 'last-billed-turn'
  };
}

/**
 * 组装端点返回体。字段名就是 MCP 工具返回给模型看到的那份 JSON。
 * @param {object} args
 * @param {string} args.key
 * @param {string|null} [args.sessionId] 完整 id 只用来取尾巴
 * @param {string} [args.mode]  'reserved2' 等
 * @param {string|null} [args.preset]
 * @param {object|null} [args.override]   activeModelOverride
 * @param {object|null} [args.applied]    appliedModelBySession.get(sid)
 * @param {object|null} [args.billed]     tokenLedger 最近一回合（source:'turn'）
 * @param {object} args.cfg
 * @param {number} [args.now]
 */
export function buildSelfModelPayload({ key, sessionId, mode, preset, override, applied, billed, cfg, now = Date.now() } = {}) {
  const resolved = resolveSelfModel({ override, applied, billed, cfg });
  if (!resolved) {
    return { ok: false, code: 'no_model', error: '还确定不了当前模型：没有选型记录，配置里也没有默认模型' };
  }
  const effort = String(applied?.effort ?? cfg?.dsh?.reasoningEffort ?? '').trim() || null;
  // 窗口长度只能靠配置补；没配就返回 null，别编一个数字。
  const windowTokens = Number(cfg?.dsh?.contextWindowTokens ?? cfg?.socialV2?.contextWindowTokens ?? 0) || null;
  return {
    ok: true,
    key: String(key ?? ''),
    mode: String(mode ?? ''),
    preset: String(preset ?? '') || null,
    provider: resolved.provider,
    model: resolved.model,
    reasoningEffort: effort,
    source: resolved.source,
    sourceLabel: SELF_MODEL_SOURCE_LABEL[resolved.source] ?? resolved.source,
    reason: resolved.reason,
    route: resolved.route,
    media: Boolean(applied?.media),
    context: contextFromBuckets(billed?.buckets, { windowTokens }),
    sessionTail: sessionTailOf(sessionId),
    asOf: Number(now) || Date.now()
  };
}
