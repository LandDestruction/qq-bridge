import { readBridgeSource } from './bridge-source.mjs';
// 模型切换 / 路由接口契约测试（msg-c12，按 main 上 A 的实现校准）。
//
// 覆盖：
//   - /api/model 六 scope（main/peak/media/group/private/override）与三种 400；
//   - /api/model-routing：GET 字段、POST 保存/校验、400/405、清单缺失（catalog:false）行为；
//   - 路由选择主路径（media > peak > idle > fallback，跳过 disabled / 不在清单）。
//
// 方式：纯函数（src/model-scope.js、src/model-routing.js）+ 对 bridge handler 的静态断言；
// 不启动 HTTP server、不读写真实 config/state。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODEL_SCOPES, scopeValid, readModelScopes, applyModelScope } from '../src/model-scope.js';
import { normalizeRouting, resolveModelChoice, ROUTING_MAX_CANDIDATES } from '../src/model-routing.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bridgeSrc = readBridgeSource();
const docSrc = fs.readFileSync(`${ROOT}docs/api-contract-model.md`, 'utf8');

const cfgFixture = () => ({
  dsh: { provider: 'workbuddy2api', model: 'deepseek-v4.1-flash' },
  socialV2: {
    modelByKind: {
      group: { provider: 'deepseek-account', model: 'deepseek-flash' },
      private: { provider: 'workbuddy2api', model: 'deepseek-v4-pro' }
    },
    modelForMedia: { provider: 'deepseek-account', model: 'deepseek-flash' },
    peakPause: { agent: { enabled: true, provider: 'xiaomi-mimo', model: 'mimo-v2.6-pro' } }
  }
});

console.log('[1] 六个 scope 与校验');
check('MODEL_SCOPES 恰好六项且顺序固定', () => {
  assert.deepEqual(MODEL_SCOPES, ['main', 'peak', 'media', 'group', 'private', 'override']);
  assert.equal(scopeValid('main'), true);
  assert.equal(scopeValid('local'), false, 'local 不是该实现的 scope');
  assert.equal(scopeValid('nope'), false);
});
check('三种 400：scope 非法 / provider 空 / main 不可清', () => {
  const badScope = applyModelScope(cfgFixture(), { scope: 'local', provider: 'p', model: 'm' });
  assert.equal(badScope.ok, false);
  assert.match(badScope.error, /scope 必须是/);

  const noProvider = applyModelScope(cfgFixture(), { scope: 'group', provider: '', model: 'm' });
  assert.equal(noProvider.ok, false);
  assert.match(noProvider.error, /provider 不能为空/);

  const mainClear = applyModelScope(cfgFixture(), { scope: 'main', model: '' });
  assert.equal(mainClear.ok, false);
  assert.match(mainClear.error, /main 不允许清除/);
});
check('六个 scope 合法写入都返回 path 与 clear=false', () => {
  for (const scope of MODEL_SCOPES) {
    const v = applyModelScope(cfgFixture(), { scope, provider: 'deepseek-account', model: scope === 'override' ? 'deepseek-flash' : 'deepseek-flash' });
    assert.equal(v.ok, true, `${scope}: ${v.error}`);
    assert.equal(v.scope, scope);
    assert.equal(v.clear, false);
    assert.ok(Array.isArray(v.path));
    if (scope === 'main') assert.deepEqual(v.path, ['dsh'], 'main 写在 dsh 下（provider/model 由 handler 写入）');
    else if (scope !== 'override') assert.ok(v.path.length >= 2, `${scope} 应有 config 路径`);
    else assert.deepEqual(v.path, []);
  }
});
check('清空：override/main 之外都能 clear；main 报错', () => {
  for (const scope of ['peak', 'media', 'group', 'private']) {
    const v = applyModelScope(cfgFixture(), { scope, model: '' });
    assert.equal(v.ok, true);
    assert.equal(v.clear, true);
  }
  assert.equal(applyModelScope(cfgFixture(), { scope: 'override', model: '' }).clear, true);
});

console.log('[2] GET /api/models 的 scopes 读取');
check('六个 scope 都能读到配置值或 null', () => {
  const scopes = readModelScopes(cfgFixture(), null);
  assert.deepEqual(Object.keys(scopes).sort(), [...MODEL_SCOPES].sort());
  assert.equal(scopes.main.model, 'deepseek-v4.1-flash');
  assert.equal(scopes.peak.model, 'mimo-v2.6-pro');
  assert.equal(scopes.group.provider, 'deepseek-account');
  assert.equal(scopes.media.model, 'deepseek-flash');
  assert.equal(scopes.override, null);
});
check('运行期 override 单独暴露、不污染 main', () => {
  const scopes = readModelScopes(cfgFixture(), { provider: 'deepseek-account', model: 'deepseek-v4-pro' });
  assert.equal(scopes.override.model, 'deepseek-v4-pro');
  assert.equal(scopes.main.model, 'deepseek-v4.1-flash', 'main 仍是配置值');
});

console.log('[3] 模型路由：主路径选择');
const chain = {
  idle: { provider: 'deepseek-account', model: 'deepseek-flash' },
  peak: { provider: 'xiaomi-mimo', model: 'mimo-v2.6-pro' },
  fallback: [
    { provider: 'workbuddy2api', model: 'glm-5.3' },
    { provider: 'workbuddy2api', model: 'deepseek-v4-pro' }
  ],
  disabled: []
};
check('空闲期：media 缺失 → idle', () => {
  const r = resolveModelChoice({ routing: chain, isPeak: false });
  assert.deepEqual(r, { provider: 'deepseek-account', model: 'deepseek-flash', source: 'idle' });
});
check('带图 → media 优先于 idle', () => {
  const media = { provider: 'deepseek-account', model: 'deepseek-flash' };
  const r = resolveModelChoice({ routing: chain, media, isPeak: false });
  assert.equal(r.source, 'media');
});
check('高峰 → peak 优先于 idle', () => {
  const r = resolveModelChoice({ routing: chain, isPeak: true });
  assert.equal(r.source, 'peak');
  assert.equal(r.model, 'mimo-v2.6-pro');
});
check('idle 缺失 → 按 fallback 顺序；全部 disabled → null', () => {
  const r = resolveModelChoice({ routing: { ...chain, idle: null, peak: null } });
  assert.deepEqual(r, { provider: 'workbuddy2api', model: 'glm-5.3', source: 'fallback' });
  const none = resolveModelChoice({
    routing: { idle: null, peak: null, fallback: chain.fallback, disabled: chain.fallback }
  });
  assert.equal(none, null);
});
check('清单可用时只认清单内模型（不可用 → 跳过）', () => {
  const available = [{ provider: 'workbuddy2api', model: 'deepseek-v4-pro' }];
  const r = resolveModelChoice({ routing: chain, available, isPeak: false });
  assert.deepEqual(r, { provider: 'workbuddy2api', model: 'deepseek-v4-pro', source: 'fallback' });
});
check('清单缺失（available=[]）→ 不过滤，仍按配置选 idle', () => {
  const r = resolveModelChoice({ routing: chain, available: [], isPeak: false });
  assert.equal(r.source, 'idle');
});
check('normalizeRouting：去重、最多 5 个、丢弃残缺项', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ provider: 'p', model: `m${i}` }));
  const r = normalizeRouting({ idle: { provider: 'p', model: 'i' }, fallback: [...many, many[0]], disabled: [{ provider: 'p' }] });
  assert.equal(r.fallback.length, ROUTING_MAX_CANDIDATES);
  assert.equal(new Set(r.fallback.map((m) => m.model)).size, r.fallback.length);
  assert.deepEqual(r.disabled, [], '缺 model 的项被丢弃');
});

console.log('[4] bridge handler 静态契约');
check('/api/model-routing GET 返回 peakPause/routing/effective/catalog/note', () => {
  assert.match(bridgeSrc, /url\.pathname === '\/api\/model-routing'/);
  assert.match(bridgeSrc, /peakPause: \{ enabled: pp\.enabled/);
  assert.match(bridgeSrc, /routing,/);
  assert.match(bridgeSrc, /effective: eff \|\|/);
  assert.match(bridgeSrc, /catalog: catalog\.length > 0/);
  assert.match(bridgeSrc, /note: '保存后下一轮生效，无需重启'/);
});
check('/api/model-routing POST 读 idle/peak/fallback/disabled/peakPauseEnabled 并 400/405', () => {
  assert.match(bridgeSrc, /body\.idle !== undefined \? body\.idle : cur\.idle/);
  assert.match(bridgeSrc, /body\.peakPauseEnabled === 'boolean'/);
  assert.match(bridgeSrc, /sendJson\(\{ ok: false, error: `模型 \$\{m\.provider\}\/\$\{m\.model\} 不在 DSH 可用清单里` \}, 400\)/);
  assert.match(bridgeSrc, /sendJson\(\{ ok: false, error: '只支持 GET\/POST' \}, 405\)/);
});
check('清单缺失时 routing POST 仍写入（只有 empty 告警）', () => {
  assert.match(bridgeSrc, /verdict\.empty && /);
  assert.match(bridgeSrc, /拿不到 DSH 清单，无法校验，按请求写入|当前拿不到 DSH 可用清单/);
});
// 2026-10-26 事故回归：面板发 "provider/model" 字符串，旧版 normalizeRouting 只认对象 →
// 保存即把 modelRouting 写空。现在补了两道闸门，这里断言它们还在。
check('routing POST 有「无法解析就 400」守卫', () => {
  assert.match(bridgeSrc, /import \{[^}]*normalizeModelRef[^}]*\} from '\.\/model-routing\.js'/);
  assert.match(bridgeSrc, /const badRefs = \[\];/);
  assert.match(bridgeSrc, /无法解析的模型（要 "provider\/model" 或 \{provider,model\}）/);
});
check('routing POST 有「拒绝把 idle/peak/fallback 全清空」守卫（allowEmpty 才放行）', () => {
  assert.match(bridgeSrc, /const curHasRouting = Boolean\(cur\?\.idle \|\| cur\?\.peak/);
  assert.match(bridgeSrc, /const nextEmpty = !next\.idle && !next\.peak && (?:!next\.visionIdle && !next\.visionPeak && )?next\.fallback\.length === 0/);
  assert.match(bridgeSrc, /curHasRouting && nextEmpty && body\.allowEmpty !== true/);
  assert.match(bridgeSrc, /拒绝写入：这次请求会把 idle\/peak\/fallback 全部清空/);
});
check('/api/model 使用 model-scope；override 不落盘、DELETE 默认 override', () => {
  assert.match(bridgeSrc, /applyModelScope\(cfg, \{ scope, provider, model \}\)/);
  assert.match(bridgeSrc, /scope === 'override'/);
  assert.match(bridgeSrc, /url\.searchParams\.get\('scope'\) \|\| 'override'/);
  assert.match(bridgeSrc, /persisted: Boolean\(persist\)/);
});
check('/api/models 返回 scopes + catalog + note', () => {
  assert.match(bridgeSrc, /scopes: readModelScopes\(cfg, activeModelOverride\)/);
  assert.match(bridgeSrc, /catalog: catalog\.length > 0/);
  assert.match(bridgeSrc, /note: '切换对下一轮生效，无需重启'/);
});

console.log('[5] 契约文档完整性');
check('doc 覆盖六 scope、routing 字段、错误码与 curl', () => {
  for (const scope of MODEL_SCOPES) assert.ok(docSrc.includes(scope), `缺 scope ${scope}`);
  for (const field of ['idle', 'peak', 'fallback', 'disabled', 'peakPauseEnabled']) assert.ok(docSrc.includes(field), `缺字段 ${field}`);
  assert.match(docSrc, /\/api\/model-routing/);
  assert.match(docSrc, /400/);
  assert.match(docSrc, /405/);
  assert.match(docSrc, /catalog/);
  const curls = (docSrc.match(/curl -/g) || []).length;
  assert.ok(curls >= 6, `至少 6 条 curl（实际 ${curls}）`);
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
