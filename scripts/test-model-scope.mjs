import assert from "node:assert/strict";
import { MODEL_SCOPES, applyModelScope, readModelScopes } from "../src/model-scope.js";
let failed = 0;
function check(n, f) { try { f(); console.log("✅ " + n); } catch (e) { failed++; console.error("❌ " + n + " — " + (e?.message ?? e)); } }
check("六个 scope 常量", () => assert.deepEqual(MODEL_SCOPES, ['main','peak','media','group','private','override']));
check("各 scope 写入路径正确", () => {
  assert.deepEqual(applyModelScope({}, { scope: 'main', provider: 'p', model: 'm' }).path, ['dsh']);
  assert.deepEqual(applyModelScope({}, { scope: 'peak', provider: 'p', model: 'm' }).path, ['socialV2','peakPause','agent']);
  assert.deepEqual(applyModelScope({}, { scope: 'media', provider: 'p', model: 'm' }).path, ['socialV2','modelForMedia']);
  assert.deepEqual(applyModelScope({}, { scope: 'group', provider: 'p', model: 'm' }).path, ['socialV2','modelByKind','group']);
  assert.deepEqual(applyModelScope({}, { scope: 'private', provider: 'p', model: 'm' }).path, ['socialV2','modelByKind','private']);
});
check("空 model = 清除（main 除外）", () => {
  assert.equal(applyModelScope({}, { scope: 'media', model: '' }).clear, true);
  assert.equal(applyModelScope({}, { scope: 'main', model: '' }).ok, false);
});
check("非法 scope / 缺 provider 拒绝", () => {
  assert.equal(applyModelScope({}, { scope: 'nope', provider: 'p', model: 'm' }).ok, false);
  assert.equal(applyModelScope({}, { scope: 'media', model: 'm' }).ok, false);
});
check("override 不落盘（path 为空）", () => {
  const r = applyModelScope({}, { scope: 'override', provider: 'p', model: 'm' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.path, []);
});
check("readModelScopes 读取六项（override 来自运行期）", () => {
  const cfg = { dsh: { provider: 'wb', model: 'main-m' }, socialV2: { peakPause: { agent: { provider: 'x', model: 'peak-m' } }, modelForMedia: { provider: 'd', model: 'media-m' }, modelByKind: { group: { provider: 'g', model: 'g-m' } } } };
  const s = readModelScopes(cfg, { provider: 'o', model: 'ov' });
  assert.deepEqual(s.main, { provider: 'wb', model: 'main-m' });
  assert.deepEqual(s.peak, { provider: 'x', model: 'peak-m' });
  assert.deepEqual(s.media, { provider: 'd', model: 'media-m' });
  assert.deepEqual(s.group, { provider: 'g', model: 'g-m' });
  assert.equal(s.private, null);
  assert.deepEqual(s.override, { provider: 'o', model: 'ov' });
});
if (failed) process.exit(1);
console.log("\n🎉 模型 scope 测试通过");
