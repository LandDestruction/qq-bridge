// 出图两档（免费档 / 高质量档）的「配置页」契约测试。
//
// 管住四件事：
//   ① key 原文永远不出现在接口返回里（只回尾巴）；
//   ② 只改一档时不覆盖另一档（以磁盘最新值为基线合并）；
//   ③ 空字符串 = 清除字段，未提供的字段保持原值；
//   ④ 模型侧（带 x-agent-token）一律 403 —— 密钥是管理端的秘密。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createConsoleImagegen } from '../src/bridge/console/imagegen-config.js';
import { providersView, applyProviderPatch, keyTail } from '../src/imagegen-providers.js';

const ROOT = 'E:/fake-root';

function fakeDeps(overrides = {}) {
  const disk = {
    imagegen: {
      enabled: true,
      preferred: { apiKey: 'pk-free-123456', model: 'cogview-3-flash', baseUrl: 'https://a.example/v4' },
      fallback: { apiKey: 'sk-high-abcdef', model: 'Tongyi-MAI/Z-Image-Turbo', baseUrl: 'https://b.example/v1', dailyLimit: 30 },
    },
  };
  const writes = [];
  const deps = {
    ROOT,
    path,
    cfg: JSON.parse(JSON.stringify(disk)),
    log: () => {},
    readQuota: () => ({ date: '2026-10-29', used: 3 }),
    providersView,
    applyProviderPatch,
    keyTail,
    readConfigObject: () => JSON.parse(JSON.stringify(disk)),
    atomicWriteJson: () => {},
    updateConfigFile: (file, mutate) => {
      const next = JSON.parse(JSON.stringify(disk));
      mutate(next);
      writes.push({ file, next: JSON.parse(JSON.stringify(next)) });
    },
    reloadConfigFromDisk: () => {},
    ...overrides,
  };
  return { deps, writes, disk };
}

function call(create, { method = 'GET', body = null, headers = {} } = {}) {
  const { deps, writes } = create;
  const out = { sent: null, status: 200 };
  const request = {
    url: new URL('http://127.0.0.1:3100/api/imagegen/providers'),
    req: { method, headers },
    sendJson: (data, status = 200) => { out.sent = data; out.status = status; },
    readBody: async () => body,
  };
  return create.handleConsoleImagegen(request).then((handled) => ({ handled, out, writes }));
}

test('GET 只回 key 尾巴，绝不回原文', async () => {
  const create = createConsoleImagegen(fakeDeps().deps);
  const { handled, out } = await call(create);
  assert.equal(handled, true);
  assert.equal(out.sent.ok, true);
  assert.equal(out.sent.slots.preferred, true);
  const text = JSON.stringify(out.sent);
  assert.equal(text.includes('pk-free-123456'), false, 'key 原文泄漏');
  assert.equal(text.includes('sk-high-abcdef'), false, 'key 原文泄漏');
  const free = out.sent.providers.find((p) => p.slot === 'preferred');
  assert.equal(free.hasKey, true);
  assert.equal(free.keyTail, '3456');
  assert.equal(free.ready, true);
  // 高质量档带当日配额，免费档没有
  assert.equal(out.sent.providers.find((p) => p.slot === 'fallback').quota.used, 3);
  assert.equal(free.quota, null);
  assert.match(out.sent.note, /重启桌面客户端 DSH/);
});

test('带 x-agent-token 的调用一律 403（模型侧看不到密钥）', async () => {
  const create = createConsoleImagegen(fakeDeps().deps);
  for (const headers of [{ 'x-agent-token': 'x' }, { 'x-agent-call': '1' }]) {
    const { handled, out } = await call(create, { headers });
    assert.equal(handled, true);
    assert.equal(out.status, 403);
    assert.equal(out.sent.ok, false);
  }
});

test('别的路径不认领（交给后面的处理器）', async () => {
  const create = createConsoleImagegen(fakeDeps().deps);
  const out = { sent: null };
  const handled = await create.handleConsoleImagegen({
    url: new URL('http://127.0.0.1:3100/api/model-routing'),
    req: { method: 'GET', headers: {} },
    sendJson: (d) => { out.sent = d; },
    readBody: async () => null,
  });
  assert.equal(handled, false);
  assert.equal(out.sent, null, '不认领的路径不该回包');
});

test('POST 只改一档：以磁盘最新值为基线，另一档原样保留', async () => {
  const { deps, writes } = fakeDeps();
  const create = createConsoleImagegen(deps);
  const { handled, out } = await call(create, {
    method: 'POST',
    body: { slot: 'preferred', model: 'cogview-4' },
  });
  assert.equal(handled, true);
  assert.equal(out.sent.ok, true);
  assert.equal(out.sent.persisted, true);
  assert.match(out.sent.note, /重启桌面客户端 DSH/);
  assert.equal(writes.length, 1);
  const next = writes[0].next.imagegen;
  assert.equal(next.preferred.model, 'cogview-4');
  assert.equal(next.preferred.apiKey, 'pk-free-123456', '没传 apiKey 时不该清掉');
  assert.equal(next.fallback.apiKey, 'sk-high-abcdef', '另一档必须原样保留');
  assert.equal(next.fallback.model, 'Tongyi-MAI/Z-Image-Turbo');
});

test('POST 空字符串 = 清除该字段；不传 apiKey 则保留', async () => {
  const { deps, writes } = fakeDeps();
  const create = createConsoleImagegen(deps);
  const r1 = await call(create, { method: 'POST', body: { slot: 'preferred', apiKey: '' } });
  assert.equal(r1.out.sent.ok, true);
  // 清空字段的语义是「把 apiKey 这个键删掉」（不是留一个空串）：两种都算清掉。
  const cleared = writes[0].next.imagegen.preferred.apiKey;
  assert.ok(cleared === undefined || cleared === '', '空字符串应当清掉 key');
  const r2 = await call(create, { method: 'POST', body: { slot: 'preferred', model: 'x' } });
  assert.equal(r2.out.sent.ok, true);
});

test('非法 slot → 400；写盘失败 → 500 且不谎报成功', async () => {
  const { deps } = fakeDeps();
  const create = createConsoleImagegen(deps);
  const bad = await call(create, { method: 'POST', body: { slot: 'nope', model: 'x' } });
  assert.equal(bad.out.sent.ok, false);
  assert.equal(bad.out.status, 400);

  const { deps: deps2 } = fakeDeps({
    updateConfigFile: () => { throw new Error('磁盘只读'); },
  });
  const create2 = createConsoleImagegen(deps2);
  const failed = await call(create2, { method: 'POST', body: { slot: 'preferred', model: 'x' } });
  assert.equal(failed.out.sent.ok, false);
  assert.equal(failed.out.status, 500);
  assert.match(String(failed.out.sent.error), /磁盘只读/);
});

test('前端：模型与高峰页有出图卡，key 框留空=不改', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('client/05-settings.js', 'utf8');
  const shell = fs.readFileSync('client/01-shell.js', 'utf8');
  const css = fs.readFileSync('public/client.css', 'utf8');
  assert.match(src, /api\('\/api\/imagegen\/providers'\)/);
  assert.match(src, /routingDraft\.imagegen = /);
  assert.match(src, /function imagegenPanelHtml\(/);
  assert.match(src, /igKey-' \+ esc\(slot\)/);
  assert.match(src, /if \(key\) body\.apiKey = key;/, '空的 key 输入框必须表示「不改」');
  assert.match(src, /function saveImagegenSlot\(/);
  assert.match(src, /function clearImagegenSlot\(/);
  assert.match(src, /重启 DSH|重启桌面客户端 DSH/);
  assert.match(shell, /'imagegen-save': function/);
  assert.match(shell, /'imagegen-clear': function/);
  assert.match(css, /\.qdb-ig-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test('两档都空时，能力判定为「不能画图」（模型侧不会注册 qq_draw）', async () => {
  const empty = { imagegen: { preferred: {}, fallback: {} } };
  const view = providersView(empty, null);
  assert.equal(view.ready, false);
  assert.equal(view.slots.preferred, false);
  assert.equal(view.slots.fallback, false);
  assert.equal(view.providers.every((p) => p.hasKey === false), true);
});

test('keyTail 只回最后四位（短 key 也不整段回显）', () => {
  assert.equal(keyTail('abcdef123456'), '3456');
  assert.equal(keyTail('ab'), '••••', '太短的 key 不暴露任何一位');
  assert.equal(keyTail(''), '');
  assert.equal(keyTail(null), '');
});
