// 配置热加载的纯逻辑测试（不启动桥接）。
import assert from 'node:assert/strict';
import { planConfigReload, pinRestartOnlyFields, getPath, setPath, RESTART_REQUIRED_PATHS } from '../src/config-reload.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('✅ ' + name); } catch (e) { failed += 1; console.error('❌ ' + name + ' — ' + (e?.message ?? e)); }
}

const base = () => ({
  consolePort: 3100,
  allow: { groups: ['1'] },
  socialV2: { paused: false, peakPause: { enabled: true } },
  snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'a' },
  dsh: { baseUrl: 'http://127.0.0.1:1' }
});

check('getPath/setPath：点路径读写', () => {
  const o = { a: { b: { c: 1 } } };
  assert.equal(getPath(o, 'a.b.c'), 1);
  setPath(o, 'a.b.d', 2);
  assert.equal(o.a.b.d, 2);
  assert.equal(getPath(o, 'x.y'), undefined);
});

check('可热更字段：白名单/社交配置变化会被识别为 changed', () => {
  const oldCfg = base();
  const newCfg = base();
  newCfg.allow.groups = ['2'];
  newCfg.socialV2.peakPause.enabled = false;
  const plan = planConfigReload(oldCfg, newCfg);
  assert.equal(plan.ok, true);
  assert.ok(plan.changed.includes('allow'));
  assert.ok(plan.changed.includes('socialV2'));
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.unchanged, false);
});

check('必须重启的字段：端口/连接变化进 skipped，且被钉回旧值', () => {
  const oldCfg = base();
  const newCfg = base();
  newCfg.consolePort = 9999;
  newCfg.dsh.baseUrl = 'http://127.0.0.1:2';
  newCfg.snowluma.accessToken = 'b';
  const plan = planConfigReload(oldCfg, newCfg);
  const paths = plan.skipped.map((s) => s.path).sort();
  assert.deepEqual(paths, ['consolePort', 'dsh.baseUrl', 'snowluma.accessToken'].sort());
  pinRestartOnlyFields(oldCfg, newCfg, plan.skipped);
  assert.equal(newCfg.consolePort, 3100);
  assert.equal(newCfg.dsh.baseUrl, 'http://127.0.0.1:1');
  assert.equal(newCfg.snowluma.accessToken, 'a');
});

check('完全没变：unchanged=true', () => {
  const plan = planConfigReload(base(), base());
  assert.equal(plan.unchanged, true);
  assert.deepEqual(plan.changed, []);
});

check('RESTART_REQUIRED_PATHS 至少包含端口与两个连接', () => {
  assert.ok(RESTART_REQUIRED_PATHS.includes('consolePort'));
  assert.ok(RESTART_REQUIRED_PATHS.includes('snowluma.wsUrl'));
  assert.ok(RESTART_REQUIRED_PATHS.includes('dsh.baseUrl'));
});

console.log(failed ? `\n❌ ${failed} 项失败` : '\n🎉 test-config-hot-reload 全部通过（5 项）');
process.exit(failed ? 1 : 0);
