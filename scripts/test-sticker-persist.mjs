// 表情图片「立刻落盘」单测（离线：假 fetch + 临时目录）。
//
// 事故背景：观察群采集的表情只存了 QQ 多媒体直链（带 rkey，几十分钟过期）——
// 面板显示「图片已失效」后无法补救（原链接 400）。修法：拿到 url 立刻下字节、算 md5、
// 写 state/sticker-files/<md5>.img 并回填条目；失败才退化为 missing。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  persistStickerThumb,
  dedupeStickerEntries,
  normalizeStickerEntry,
  formatStickerList,
  md5Hex
} from '../src/sticker-lib.js';
import { planStickerDedupe } from '../src/bridge/console/stickers-voices.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-persist-'));

console.log('[1] 有 url 立刻落盘');
await check('成功：写出 <md5>.img、条目带 md5、thumbStatus=ok', async () => {
  const buf = Buffer.from('fake-jpeg-bytes');
  const entry = normalizeStickerEntry({ id: 'c_1', url: 'https://multimedia.nt.qq.com.cn/x?rkey=SECRET' });
  const result = await persistStickerThumb(entry, {
    fetchImpl: async (url, maxBytes) => { assert.equal(maxBytes, 2 * 1024 * 1024); return buf; },
    cacheDir: dir
  });
  assert.equal(result.status, 'ok');
  assert.equal(entry.md5, md5Hex(buf));
  assert.equal(entry.thumbStatus, 'ok');
  assert.equal(entry.thumbError, '');
  assert.equal(fs.readFileSync(path.join(dir, `${md5Hex(buf)}.img`)).toString(), 'fake-jpeg-bytes');
  assert.match(entry.url, /rkey=SECRET/, '原 url 保留（面板还能显示来源）');
});

console.log('[2] 下载失败不抛、标 missing、保留 url');
await check('404：thumbStatus=missing + thumbError + url 不变', async () => {
  const entry = normalizeStickerEntry({ id: 'c_2', url: 'https://multimedia.nt.qq.com.cn/y?rkey=EXPIRED' });
  const result = await persistStickerThumb(entry, {
    fetchImpl: async () => { throw new Error('HTTP 400'); },
    cacheDir: dir
  });
  assert.equal(result.status, 'missing');
  assert.equal(entry.thumbStatus, 'missing');
  assert.match(entry.thumbError, /400/);
  assert.equal(entry.md5, '');
  assert.equal(entry.url, 'https://multimedia.nt.qq.com.cn/y?rkey=EXPIRED');
});
await check('没有 url：直接 missing，不调用 fetch', async () => {
  let called = 0;
  const entry = normalizeStickerEntry({ id: 'c_3', md5: 'A'.repeat(32) });
  const result = await persistStickerThumb(entry, { fetchImpl: async () => { called += 1; }, cacheDir: dir });
  assert.equal(result.status, 'missing');
  assert.equal(called, 0);
});

console.log('[3] 已缓存的不重复下载');
await check('md5 命中本地文件 → cached，fetch 0 次', async () => {
  const buf = Buffer.from('cached-bytes');
  fs.writeFileSync(path.join(dir, `${md5Hex(buf)}.img`), buf);
  let called = 0;
  const entry = normalizeStickerEntry({ id: 'c_4', md5: md5Hex(buf) });
  const result = await persistStickerThumb(entry, { fetchImpl: async () => { called += 1; }, cacheDir: dir });
  assert.equal(result.status, 'cached');
  assert.equal(called, 0);
  assert.equal(entry.thumbStatus, 'ok');
});

console.log('[4] 上限拒绝');
await check('超过 maxBytes → missing，不写盘', async () => {
  const entry = normalizeStickerEntry({ id: 'c_5', url: 'https://x.invalid/big.png' });
  const result = await persistStickerThumb(entry, {
    fetchImpl: async () => Buffer.alloc(128 * 1024, 1),
    cacheDir: dir,
    maxBytes: 64 * 1024
  });
  assert.equal(result.status, 'missing');
  assert.match(entry.thumbError, /上限/);
});

console.log('[5] 去重（md5 优先，保留人工注释）');
await check('同 md5 不同 id/url → 合成一条，注释不丢', () => {
  const md5 = 'B'.repeat(32);
  const list = [
    normalizeStickerEntry({ id: 'a', md5, url: 'https://1', desc: '' }),
    normalizeStickerEntry({ id: 'b', md5, url: 'https://2', localNote: '嘲讽用', tags: ['怼人'] })
  ];
  const out = dedupeStickerEntries(list);
  assert.equal(out.length, 1);
  assert.equal(out[0].md5, md5);
  assert.equal(out[0].localNote, '嘲讽用');
  assert.deepEqual(out[0].tags, ['怼人']);
});
await check('无 md5 时同 url（忽略查询参数）也去重', () => {
  const list = [
    normalizeStickerEntry({ id: 'x', url: 'https://p.qpic.cn/a.jpg?rkey=1' }),
    normalizeStickerEntry({ id: 'y', url: 'https://p.qpic.cn/a.jpg?rkey=2' })
  ];
  assert.equal(dedupeStickerEntries(list).length, 1);
});
await check('不同表情不误合并', () => {
  const list = [
    normalizeStickerEntry({ id: 'x', md5: 'C'.repeat(32) }),
    normalizeStickerEntry({ id: 'y', md5: 'D'.repeat(32) })
  ];
  assert.equal(dedupeStickerEntries(list).length, 2);
});

console.log('[6] 列表接口带 thumbStatus（面板显示「失效」用）');
await check('formatStickerList 透出 thumbStatus/thumbError', () => {
  const list = normalizeStickerEntriesForTest();
  const out = formatStickerList(list, '', 10);
  assert.equal(out.stickers[0].thumbStatus, 'missing');
  assert.match(out.stickers[0].thumbError, /400/);
});
function normalizeStickerEntriesForTest() {
  return [normalizeStickerEntry({ id: 'm', url: 'https://x/y', thumbStatus: 'missing', thumbError: 'HTTP 400' })];
}

// [7] 分页：offset/hasMore 的口径锁在这里（CORE 套件，进 regression-all 闸门）。
console.log('[7] 列表分页 offset/hasMore（先 query 过滤，再切片；count 上限仍 500）');
const pageFixture = Array.from({ length: 5 }, (_, i) => normalizeStickerEntry({
  id: `s${i + 1}`,
  url: `https://public.invalid/s${i + 1}`,
  desc: i % 2 === 0 ? `分页${i + 1}` : `别的${i + 1}`
}));
await check('offset=0 返回第一页且 hasMore=true', () => {
  const out = formatStickerList(pageFixture, '', 2, 0);
  assert.equal(out.offset, 0);
  assert.equal(out.total, 5, 'total 仍是全库条数（前端分页依赖）');
  assert.equal(out.matched, 5);
  assert.deepEqual(out.stickers.map((s) => s.id), ['s1', 's2']);
  assert.equal(out.hasMore, true);
  assert.equal(out.truncated, true);
});
await check('offset=count 返回第二页且与第一页无交集', () => {
  const first = formatStickerList(pageFixture, '', 2, 0);
  const second = formatStickerList(pageFixture, '', 2, 2);
  assert.equal(second.offset, 2);
  assert.deepEqual(second.stickers.map((s) => s.id), ['s3', 's4']);
  assert.equal(second.hasMore, true);
  const seen = new Set(first.stickers.map((s) => s.id));
  assert.equal(second.stickers.every((s) => !seen.has(s.id)), true);
});
await check('最后一页 hasMore=false', () => {
  const last = formatStickerList(pageFixture, '', 2, 4);
  assert.deepEqual(last.stickers.map((s) => s.id), ['s5']);
  assert.equal(last.hasMore, false);
  assert.equal(last.truncated, false);
});
await check('offset 超过总数返回空数组 + hasMore=false（不抛错）', () => {
  const out = formatStickerList(pageFixture, '', 2, 99);
  assert.deepEqual(out.stickers, []);
  assert.equal(out.offset, 99);
  assert.equal(out.hasMore, false);
  assert.equal(out.truncated, false);
  assert.equal(out.matched, 5, '越界不清空 matched');
});
await check('query + offset 组合：先过滤再切片', () => {
  const out = formatStickerList(pageFixture, '分页', 2, 2);
  assert.equal(out.total, 5, 'total 不受 query 影响');
  assert.equal(out.matched, 3, 'matched 是过滤后总数');
  assert.deepEqual(out.stickers.map((s) => s.id), ['s5'], '跳过前两条命中项');
  assert.equal(out.hasMore, false);
});
await check('非法 offset（负数/非数字/小数/空/Infinity）按 0 处理', () => {
  for (const bad of [-1, -0.5, 1.5, 'abc', '', null, undefined, NaN, Infinity]) {
    const out = formatStickerList(pageFixture, '', 2, bad);
    assert.equal(out.offset, 0, `offset=${String(bad)} 应退回 0`);
    assert.deepEqual(out.stickers.map((s) => s.id), ['s1', 's2']);
  }
});
// [7b] 排序：控制台表情库要能按时间 / 可用性 / 使用次数排（用户 2026-10-28 要求）。
const sortFixture = [
  normalizeStickerEntry({ id: 'old1', url: 'https://public.invalid/1', policy: 'understand-only', useCount: 1, createdAt: '2026-10-01T00:00:00.000Z' }),
  normalizeStickerEntry({ id: 'new1', url: 'https://public.invalid/2', policy: 'usable', useCount: 9, createdAt: '2026-10-25T00:00:00.000Z' }),
  normalizeStickerEntry({ id: 'mid1', url: 'https://public.invalid/3', policy: 'understand-only', useCount: 5, createdAt: '2026-10-10T00:00:00.000Z' })
];
await check('sort=new 默认按加入时间倒序', () => {
  const out = formatStickerList(sortFixture, '', 10, 0);
  assert.equal(out.sort, 'new', '默认口径回传 new');
  assert.deepEqual(out.stickers.map((s) => s.id), ['new1', 'mid1', 'old1']);
});
await check('sort=old 按加入时间正序', () => {
  const out = formatStickerList(sortFixture, '', 10, 0, 'old');
  assert.deepEqual(out.stickers.map((s) => s.id), ['old1', 'mid1', 'new1']);
});
await check('sort=usable 可用优先、同组内新→旧', () => {
  const out = formatStickerList(sortFixture, '', 10, 0, 'usable');
  assert.equal(out.stickers[0].id, 'new1');
  assert.deepEqual(out.stickers.map((s) => s.policy)[0], 'usable');
});
await check('sort=understand 只解读优先', () => {
  const out = formatStickerList(sortFixture, '', 10, 0, 'understand');
  assert.deepEqual(out.stickers.slice(0, 2).map((s) => s.policy), ['understand-only', 'understand-only']);
});
await check('sort=used 按使用次数倒序', () => {
  const out = formatStickerList(sortFixture, '', 10, 0, 'used');
  assert.deepEqual(out.stickers.map((s) => s.id), ['new1', 'mid1', 'old1']);
});
await check('未知 sort 退回 new（不报错）', () => {
  const out = formatStickerList(sortFixture, '', 10, 0, 'bogus');
  assert.equal(out.sort, 'new');
  assert.deepEqual(out.stickers.map((s) => s.id), ['new1', 'mid1', 'old1']);
});
await check('排序 + 分页不重复不丢：两页拼起来等于整库', () => {
  const ids = [];
  for (let off = 0; off < sortFixture.length; off += 1) {
    const page = formatStickerList(sortFixture, '', 1, off);
    ids.push(...page.stickers.map((s) => s.id));
  }
  assert.deepEqual(ids, ['new1', 'mid1', 'old1']);
});
await check('列表条目透出 createdAt（面板排序要用）', () => {
  const out = formatStickerList(sortFixture, '', 10, 0);
  assert.equal(out.stickers[0].createdAt, '2026-10-25T00:00:00.000Z');
});

await check('count 上限仍是 500（不放大）', () => {
  const many = Array.from({ length: 501 }, (_, i) => normalizeStickerEntry({ id: `b${i}`, url: `https://public.invalid/b${i}` }));
  const out = formatStickerList(many, '', 1000, 0);
  assert.equal(out.stickers.length, 500);
  assert.equal(out.hasMore, true);
  assert.equal(out.truncated, true);
});

// [7] POST /api/stickers/dedupe —— 保守去重（真路由 + 隔离 state）
//
// 为什么走 bridgeHarness 而不是直接调 handler：这个接口的价值有一半在「入口闸」上
// （x-agent-token 403、路由挂对、只读 503），只有真起一次控制台才验得到。
// harness 在临时目录里造 state/stickers.json，仓库里的真实 state/ 一个字节都不会动。
const DUP_MD5 = 'D'.repeat(32);
const SOLO_MD5 = 'E'.repeat(32);
const dedupeHarness = await bridgeHarness({
  // 关掉同步：GET 会触发 syncStickerLibrary，真实同步会拿网关 fixture 覆盖预置表情。
  config: { socialV2: { sticker: { enabled: false } } },
  files: {
    'state/stickers.json': [
      { id: 'dup-b', md5: DUP_MD5, useCount: 5, policy: 'usable', desc: '重复B' },
      { id: 'dup-a', md5: DUP_MD5, useCount: 2, policy: 'usable', desc: '重复A' },
      { id: 'dup-c', md5: DUP_MD5, useCount: 5, policy: 'usable', desc: '重复C' },
      { id: 'solo-1', md5: SOLO_MD5, useCount: 7, policy: 'usable', desc: '独一份' }
    ]
  }
});
const dedupeServer = dedupeHarness.startConsoleServer();
if (!dedupeServer.listening) await new Promise((resolve) => dedupeServer.once('listening', resolve));
const dedupePort = dedupeServer.address().port;
const storeFile = path.join(dedupeHarness.temp, 'state/stickers.json');
const backups = () => fs.readdirSync(path.dirname(storeFile)).filter((f) => f.includes('.bak-'));
const readStore = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));
function postDedupe(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: dedupePort, path: '/api/stickers/dedupe', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, raw: text }); });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('超时')));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
try {
  const before = fs.readFileSync(storeFile, 'utf8');
  const preview = await postDedupe({});
  await check('去重预览：200 + scanned/duplicates 按构造的重复算（4 条里 2 条多余）', () => {
    assert.equal(preview.status, 200, preview.raw);
    assert.equal(preview.json.ok, true);
    assert.equal(preview.json.apply, false);
    assert.equal(preview.json.scanned, 4);
    assert.equal(preview.json.duplicates, 2);
    assert.equal(preview.json.groups.length, 1);
  });
  await check('去重预览：keep 取 useCount 最大的（并列取 id 字典序最小），drop 列其余', () => {
    const group = preview.json.groups[0];
    assert.match(group.key, /^md5:d+$/);
    assert.equal(group.keep, 'dup-b', 'dup-b/dup-c 都是 5 次，取 id 小的');
    assert.deepEqual([...group.drop].sort(), ['dup-a', 'dup-c']);
    // files 里的 md5 统一小写（与 dedupeStickerEntries 的比较口径一致）。
    assert.deepEqual(group.files, [DUP_MD5.toLowerCase()]);
  });
  await check('去重预览不改盘：文件字节不变、也没有生成备份', () => {
    assert.equal(fs.readFileSync(storeFile, 'utf8'), before);
    assert.deepEqual(backups(), []);
  });
  const applied = await postDedupe({ apply: true });
  await check('去重 apply：removed/kept 对得上，回 backup 路径且备份文件真存在（4 条）', () => {
    assert.equal(applied.status, 200, applied.raw);
    assert.equal(applied.json.apply, true);
    assert.equal(applied.json.removed, 2);
    assert.equal(applied.json.kept, 2);
    assert.match(applied.json.backup, /^state\/stickers\.json\.bak-\d{8}-\d{6}(-\d+)?$/);
    const backupFile = path.join(dedupeHarness.temp, applied.json.backup);
    assert.equal(fs.existsSync(backupFile), true);
    assert.equal(JSON.parse(fs.readFileSync(backupFile, 'utf8')).length, 4, '备份必须是去重前的原文');
  });
  await check('去重 apply 后只剩一条重复内容，且留下的是用得多的那条', () => {
    const disk = readStore();
    assert.equal(disk.length, 2);
    assert.deepEqual(disk.map((e) => e.id).sort(), ['dup-b', 'solo-1']);
    assert.equal(disk.find((e) => e.id === 'dup-b').useCount, 12, '组内 useCount 求和 5+5+2');
  });
  const again = await postDedupe({});
  await check('去重幂等：再跑一次 duplicates=0 / scanned=已保留条数，且不再写盘', () => {
    assert.equal(again.status, 200);
    assert.equal(again.json.duplicates, 0);
    assert.equal(again.json.scanned, 2);
    assert.deepEqual(again.json.groups, []);
    assert.equal(backups().length, 1);
  });
  const agent = await postDedupe({ apply: true }, { 'x-agent-token': 'fixture-agent' });
  await check('去重带 x-agent-token 403（表情库管理接口仅控制台可用），且未落盘', () => {
    assert.equal(agent.status, 403);
    assert.equal(agent.json.ok, false);
    assert.equal(readStore().length, 2);
  });
} finally {
  await new Promise((resolve) => dedupeServer.close(resolve));
  await dedupeHarness.close();
}

// [8] 去重判据必须是「真身份」：QQ 图链 path 全一样、query 是过期签名，
// 按 url 分组会把不同图片误判成同一张（线上实测 4 张不同收藏共用 /download 路径）。
// 直接测纯函数，绕开 HTTP 与隔离 state，判据本身就是这里要锁的东西。
await check('不同图片共用 /download 路径不会被误合并', () => {
  const plan = planStickerDedupe([
    { id: 'u1', url: 'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=aaa', useCount: 1 },
    { id: 'u2', url: 'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=bbb', useCount: 2 }
  ]);
  assert.equal(plan.groups.length, 0, '没有 md5/emojiId 时不许按 url 合并');
  assert.equal(plan.duplicates, 0);
  assert.equal(plan.scanned, 2);
});
await check('同 md5 才合并，且保留 useCount 大的那条', () => {
  const plan = planStickerDedupe([
    { id: 'm1', md5: 'ABCD', url: 'https://x/1', useCount: 1 },
    { id: 'm2', md5: 'abcd', url: 'https://x/2', useCount: 7 }
  ]);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.groups[0].keep, 'm2', '保留 useCount 大的');
  assert.deepEqual(plan.groups[0].drop, ['m1']);
});
await check('同 emojiId 也算真身份', () => {
  const plan = planStickerDedupe([
    { id: 'e1', emojiId: 'AAA', useCount: 1 },
    { id: 'e2', emojiId: 'AAA', useCount: 3 }
  ]);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.groups[0].keep, 'e2');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
