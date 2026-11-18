import { readBridgeSource } from './bridge-source.mjs';
// 配置写入保护 + 并发合并回归（msg-c13）。
//
// 复现 2026-10-26 17:51 事故的根因：两个写入者用「内存里的整份快照」覆盖 config.json，
// 后写者把先写者的修改抹掉。本测试断言新的 updateConfigFile（读盘再合并）不会丢更新，
// 并断言脚本写真实 config.json 默认被拒绝。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigObject, updateConfigFile, assertScriptConfigWriteAllowed, isRealConfigPath } from '../src/config-write.js';
import { assertSafeConfigWrite } from './config-write-guard.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function atomicWrite(file, obj) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

console.log('[1] 并发写入：读盘再合并，不丢更新');
check('A 写 routing、B 写 allow，交替后两份修改都在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-write-'));
  const file = path.join(dir, 'config.json');
  atomicWrite(file, { dsh: { provider: 'p', model: 'm' }, allow: { groups: [] } });
  try {
    // A 先读了一份快照（旧），B 随后改了 allow（真实写入）。
    atomicWrite(file, { ...readConfigObject(file), allow: { groups: ['456'] } });
    // A 现在提交 routing：实现必须重新读盘，而不是写自己手里的旧快照。
    updateConfigFile(file, (disk) => {
      disk.socialV2 = disk.socialV2 || {};
      disk.socialV2.modelRouting = { idle: { provider: 'p', model: 'i' }, peak: null, fallback: [], disabled: [] };
    }, { atomicWrite });
    const now = readConfigObject(file);
    assert.deepEqual(now.allow.groups, ['456'], 'B 写的 allow 不能被 A 抹掉');
    assert.equal(now.socialV2.modelRouting.idle.model, 'i', 'A 写的 routing 也要在');
    assert.equal(now.dsh.model, 'm', '未参与写入的字段保持原值');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
check('反面：旧实现写整份快照会丢更新（证明这条测试有区分力）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-stale-'));
  const file = path.join(dir, 'config.json');
  atomicWrite(file, { allow: { groups: [] } });
  const stale = readConfigObject(file);            // A 的旧快照
  atomicWrite(file, { allow: { groups: ['456'] } }); // B 写入
  stale.socialV2 = { modelRouting: { idle: null } }; // A 在旧快照上改
  atomicWrite(file, stale);                          // 旧实现：整份覆盖
  const now = readConfigObject(file);
  assert.deepEqual(now.allow.groups, [], '旧实现会丢 B 的修改（这就是 17:51 的形态）');
  fs.rmSync(dir, { recursive: true, force: true });
});
check('两个并发 updateConfigFile 都只改自己的键', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-both-'));
  const file = path.join(dir, 'config.json');
  atomicWrite(file, {});
  try {
    updateConfigFile(file, (d) => { d.allow = { groups: ['1'] }; }, { atomicWrite });
    updateConfigFile(file, (d) => { d.dsh = { model: 'x' }; }, { atomicWrite });
    const now = readConfigObject(file);
    assert.deepEqual(now.allow.groups, ['1']);
    assert.equal(now.dsh.model, 'x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log('[2] 脚本写保护：真实 config.json 默认拒绝');
check('临时目录/其它文件名不需要环境变量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-guard-'));
  try {
    const tmpCfg = path.join(dir, 'config.json');
    assert.equal(assertScriptConfigWriteAllowed(tmpCfg, { root: ROOT }), true);
    assert.equal(assertSafeConfigWrite(tmpCfg), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
check('无 QQ_BRIDGE_ALLOW_CONFIG_WRITE 时拒绝写真实 config.json', () => {
  const real = path.join(ROOT, 'config.json');
  assert.equal(isRealConfigPath(real, ROOT), true);
  assert.throws(() => assertScriptConfigWriteAllowed(real, { root: ROOT, env: {} }), /拒绝写真实 config\.json/);
  assert.throws(() => assertSafeConfigWrite(real, { env: {} }), /QQ_BRIDGE_ALLOW_CONFIG_WRITE=1/);
});
check('显式 QQ_BRIDGE_ALLOW_CONFIG_WRITE=1 才放行真实路径', () => {
  const real = path.join(ROOT, 'config.json');
  assert.equal(assertScriptConfigWriteAllowed(real, { root: ROOT, env: { QQ_BRIDGE_ALLOW_CONFIG_WRITE: '1' } }), true);
});
check('相对路径/不同前缀也识别为真实 config', () => {
  assert.equal(isRealConfigPath(path.join(ROOT, 'sub', '..', 'config.json'), ROOT), true);
  assert.equal(isRealConfigPath(path.join(ROOT, 'config.example.json'), ROOT), false);
});

console.log('[3] 桥接接线静态断言');
const bridgeSrc = readBridgeSource();
check('不再用内存整份快照覆盖 config.json', () => {
  assert.equal(/atomicWriteJson\(path\.join\(ROOT, 'config\.json'\), cfg\)/.test(bridgeSrc), false, '旧写法必须消失');
});
check('/api/model-routing、/api/model、/api/peak/toggle 都走 updateConfigFile', () => {
  const uses = (bridgeSrc.match(/updateConfigFile\(path\.join\(ROOT, 'config\.json'\)/g) || []).length;
  assert.ok(uses >= 4, `至少 4 处读盘合并（实际 ${uses}）`);
});
check('import 了 config-write 且 handler 写失败会报错（不再静默吞）', () => {
  assert.match(bridgeSrc, /import \{ updateConfigFile \} from '\.\/config-write\.js'/);
  assert.match(bridgeSrc, /写入 config\.json 失败/);
});

console.log('[4] 交接文档');
check('docs/handoff-config-writers.md 记录写入者/真凶/保护机制', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/handoff-config-writers.md'), 'utf8');
  assert.match(doc, /17:51/);
  assert.match(doc, /model-routing/);
  assert.match(doc, /updateConfigFile/);
  assert.match(doc, /QQ_BRIDGE_ALLOW_CONFIG_WRITE/);
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
