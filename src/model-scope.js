// 模型作用域（纯逻辑）：把「切哪个范围的模型」从路由里抽出来，便于单测与热加载。
export const MODEL_SCOPES = ['main', 'peak', 'media', 'group', 'private', 'override'];

const PATHS = {
  main: ['dsh'],
  peak: ['socialV2', 'peakPause', 'agent'],
  media: ['socialV2', 'modelForMedia'],
  group: ['socialV2', 'modelByKind', 'group'],
  private: ['socialV2', 'modelByKind', 'private']
};

function dig(obj, path) {
  let cur = obj;
  for (const k of path) { if (!cur || typeof cur !== 'object') return null; cur = cur[k]; }
  return cur && typeof cur === 'object' ? cur : null;
}

export function scopeValid(scope) { return MODEL_SCOPES.includes(String(scope)); }

/**
 * 规整一次 scope 写入请求（不落盘、不改 cfg）。
 * @returns {{ok:true, scope, provider, model, clear:boolean, path:string[]} | {ok:false, error:string}}
 */
export function applyModelScope(cfg, { scope, provider = '', model = '' } = {}) {
  const sc = String(scope || 'override');
  if (!scopeValid(sc)) return { ok: false, error: `scope 必须是 ${MODEL_SCOPES.join('/')}` };
  const p = String(provider || '').trim();
  const m = String(model || '').trim();
  if (m && !p) return { ok: false, error: '设置模型时 provider 不能为空' };
  if (sc === 'main' && !m) return { ok: false, error: 'main 不允许清除（至少要给一个模型）' };
  if (sc === 'override') {
    if (!m) return { ok: true, scope: sc, provider: '', model: '', clear: true, path: [] };
    return { ok: true, scope: sc, provider: p, model: m, clear: false, path: [] };
  }
  return { ok: true, scope: sc, provider: p, model: m, clear: !m, path: PATHS[sc] };
}

/** 六个 scope 的当前值（override 来自运行期）。 */
export function readModelScopes(cfg = {}, activeModelOverride = null) {
  const base = cfg && typeof cfg === 'object' ? cfg : {};
  const pick = (path) => { const v = dig(base, path); return v && v.model ? { provider: String(v.provider || ''), model: String(v.model) } : null; };
  return {
    main: pick(PATHS.main) || (base.dsh?.model ? { provider: String(base.dsh.provider || ''), model: String(base.dsh.model) } : null),
    peak: pick(PATHS.peak),
    media: pick(PATHS.media),
    group: pick(PATHS.group),
    private: pick(PATHS.private),
    override: activeModelOverride && activeModelOverride.model
      ? { provider: String(activeModelOverride.provider || ''), model: String(activeModelOverride.model) }
      : null
  };
}
