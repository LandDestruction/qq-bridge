// /api/model-routing 真机往返探针（面板「高峰期与模型」保存后下拉全空那条线的回归）。
//
// 为什么需要它：scripts/test-model-api-contract.mjs 只做**静态断言 + 纯函数**，
// 而 10-26 的故障是运行期行为——面板一保存，紧接着的 GET 抖动/清单为空，整块下拉就空白。
// 这个探针真的打控制台，走一圈 GET → POST（原值回写）→ GET，并核对 config.json 没被写坏。
//
// 用法：node scripts/probe-model-routing-live.mjs [--json]
// 纪律：
//   * 只把**当前值原样**回写，绝不改用户的模型选择；
//   * 写盘前先快照整份 config.json，写后逐键 deep-equal，任何其他字段被改动/丢失都判失败
//     （17:51 那次 modelRouting 被旧快照清空就是这么来的）；
//   * 不打印 token。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = process.env.QQ_BRIDGE_CONSOLE || 'http://127.0.0.1:3100';
const TOKEN = fs.readFileSync(path.join(ROOT, 'state/console-token'), 'utf8').trim();
const OUT_JSON = process.argv.includes('--json');

let pass = 0; let fail = 0;
const rows = [];
function check(name, ok, detail = '') {
  rows.push({ name, ok, detail });
  if (ok) { pass += 1; if (!OUT_JSON) console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; if (!OUT_JSON) console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
async function api(method, pathname, body) {
  const url = `${BASE}${pathname}${pathname.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`;
  const r = await fetch(url, {
    method,
    headers: { 'x-console-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const key = (m) => (m && m.provider && m.model ? `${m.provider}/${m.model}` : '');
const cfgPath = path.join(ROOT, 'config.json');
const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

console.log(`[1] GET /api/model-routing`);
const g1 = await api('GET', '/api/model-routing');
check('HTTP 200 + ok:true', g1.status === 200 && g1.json?.ok === true, `HTTP ${g1.status}`);
const o1 = g1.json || {};
check('options 非空（下拉有东西可选）', Array.isArray(o1.options) && o1.options.length > 0, `${o1.options?.length ?? 0} 项`);
check('routing.idle/peak 有值', Boolean(key(o1.routing?.idle)) && Boolean(key(o1.routing?.peak)),
  `idle=${key(o1.routing?.idle) || '-'} peak=${key(o1.routing?.peak) || '-'}`);
check('effective 有来源', Boolean(key(o1.effective)) && Boolean(o1.effective?.source), `${key(o1.effective)} @${o1.effective?.source}`);
check('options 里包含当前 idle/peak（否则面板回显会变成空白）', (() => {
  const opts = new Set((o1.options || []).map(key));
  return opts.has(key(o1.routing?.idle)) && opts.has(key(o1.routing?.peak));
})());
if (!OUT_JSON) console.log(`       catalog=${o1.catalog}  peakPause.enabled=${o1.peakPause?.enabled}`);

console.log(`[2] POST /api/model-routing（把当前值原样回写，等于面板点一次保存）`);
const cfgBefore = readCfg();
const payload = {
  idle: key(o1.routing?.idle),
  peak: key(o1.routing?.peak),
  fallback: (o1.routing?.fallback || []).map(key).filter(Boolean),
  disabled: (o1.routing?.disabled || []).map(key).filter(Boolean),
  peakPauseEnabled: Boolean(o1.peakPause?.enabled)
};
const p1 = await api('POST', '/api/model-routing', payload);
check('HTTP 200 + ok:true', p1.status === 200 && p1.json?.ok === true, p1.json?.error || `HTTP ${p1.status}`);
check('persisted:true / restartRequired:false',
  p1.json?.persisted === true && p1.json?.restartRequired === false,
  `persisted=${p1.json?.persisted} restartRequired=${p1.json?.restartRequired}`);
check('POST 响应回带 routing（面板可就地更新，不必依赖下一次 GET）', Boolean(p1.json?.routing));
check('回写后 idle/peak 与保存前一致',
  key(p1.json?.routing?.idle) === payload.idle && key(p1.json?.routing?.peak) === payload.peak,
  `idle=${key(p1.json?.routing?.idle)} peak=${key(p1.json?.routing?.peak)}`);

console.log(`[3] GET 再取一次（保存后下拉的核心回归）`);
const g2 = await api('GET', '/api/model-routing');
check('HTTP 200 + ok:true', g2.status === 200 && g2.json?.ok === true, `HTTP ${g2.status}`);
check('options 仍然非空（这就是「保存后下拉全空」的那一刀）',
  Array.isArray(g2.json?.options) && g2.json.options.length > 0, `${g2.json?.options?.length ?? 0} 项`);
check('选中值仍在 options 里', (() => {
  const opts = new Set((g2.json?.options || []).map(key));
  return opts.has(payload.idle) && opts.has(payload.peak);
})());
check('peakPause.enabled 未被写反', Boolean(g2.json?.peakPause?.enabled) === payload.peakPauseEnabled,
  `before=${payload.peakPauseEnabled} after=${g2.json?.peakPause?.enabled}`);

console.log(`[4] config.json 没被写坏（读盘再合并的回归）`);
const cfgAfter = readCfg();
check('顶层键集合没变', JSON.stringify(Object.keys(cfgBefore).sort()) === JSON.stringify(Object.keys(cfgAfter).sort()),
  `${Object.keys(cfgBefore).length} → ${Object.keys(cfgAfter).length}`);
const diffKeys = Object.keys(cfgBefore).filter((k) => JSON.stringify(cfgBefore[k]) !== JSON.stringify(cfgAfter[k]));
check('除 socialV2.modelRouting / socialV2.peakPause 外无字段变化',
  diffKeys.every((k) => k === 'socialV2'), `变化的顶层键：${diffKeys.join(',') || '（无）'}`);
check('modelRouting 内容与保存前一致',
  JSON.stringify(cfgBefore.socialV2?.modelRouting) === JSON.stringify(cfgAfter.socialV2?.modelRouting));
check('socialV2 其余字段未丢（allow/observe/stt 等仍在）', (() => {
  const lost = Object.keys(cfgBefore.socialV2 || {}).filter((k) => !(k in (cfgAfter.socialV2 || {})));
  return lost.length === 0;
})(), (() => {
  const lost = Object.keys(cfgBefore.socialV2 || {}).filter((k) => !(k in (cfgAfter.socialV2 || {})));
  return lost.length ? '丢了：' + lost.join(',') : '';
})());
check('allow.groups / observe.groups 未被清空', (() => {
  const a = cfgAfter.allow?.groups || []; const o = cfgAfter.observe?.groups || [];
  return a.length === (cfgBefore.allow?.groups || []).length && o.length === (cfgBefore.observe?.groups || []).length;
})());

if (OUT_JSON) console.log(JSON.stringify({ pass, fail, rows }, null, 2));
else console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
// 用 exitCode + 让事件循环自然收尾：直接 process.exit() 会在 Windows 的 libuv 里撞
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"（keep-alive socket 还没关完）。
process.exitCode = fail === 0 ? 0 : 1;
