// 表情去重：面板侧合并逻辑（纯函数）+ 数据侧「合并重复」按钮的调用约定。
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const html = fs.readFileSync('public/ops.html', 'utf8');
const start = html.indexOf('function stickerDedupeKey');
const end = html.indexOf('async function loadStickers()');
assert.ok(start > 0 && end > start, '无法从 ops.html 抽出去重函数');
const code = html.slice(start, end);

function makeUi(base) {
  const els = new Map();
  const mk = () => ({
    textContent: '', className: '', disabled: false, style: {}, dataset: {}, children: [],
    appendChild(c) { this.children.push(c); return c; }, setAttribute() {}, addEventListener() {},
  });
  const document = { getElementById(id) { if (!els.has(id)) { const e = mk(); e.id = id; els.set(id, e); } return els.get(id); } };
  const msgs = [];
  const sandbox = {
    document,
    token: 'fixture-token',
    fetch: (url, opts) => fetch(String(url).startsWith('http') ? url : base + url, opts),
    setStickerMsg: (text) => { msgs.push(text); document.getElementById('sticker-msg').textContent = text; },
    loadStickers: async () => { msgs.push('(reload)'); },
    Date, Number, Math, JSON, String, Array, Set,
    console: { log() {}, warn() {}, error() {} },
  };
  const api = new Function(...Object.keys(sandbox), code + '\nreturn { dedupeStickerEntries, mergeStickerEntries, dedupeStickers, stickerDedupeKey };')(...Object.values(sandbox));
  return { ...api, msgs, els };
}

const results = [];
const check = (label, fn) => {
  try { fn(); results.push('OK   ' + label); } catch (e) { results.push('FAIL ' + label + ' — ' + e.message); process.exitCode = 1; }
};

// 构造用户现场：92 条，4 组重复（多出 8 条）
const base = [];
// 92 = 80 条单例 + 4 组重复共 12 条（多出 8 条）
for (let i = 0; i < 80; i += 1) {
  base.push({ id: 'u' + i, md5: 'M' + i, localNote: '', desc: 'desc' + i, tags: [], policy: i % 2 ? 'usable' : 'understand-only', updatedAt: '2026-10-01T00:00:00Z' });
}
const dupGroups = [
  { md5: 'ICSZQU', n: 4, note: '表示自己楚楚可怜', policy: 'usable' },
  { md5: 'P1SUB', n: 4, note: '收到/好的', policy: 'understand-only' },
  { md5: 'VVHDLO', n: 2, note: '', policy: 'usable' },
  { md5: 'H2TCVR', n: 2, note: '笑死', policy: 'understand-only' },
];
for (const g of dupGroups) {
  for (let k = 0; k < g.n; k += 1) {
    base.push({ id: 'c_' + g.md5 + '_' + k, md5: g.md5, localNote: k === 1 ? g.note : '', desc: 'd', tags: k === 0 ? ['tagA'] : [], policy: k === 2 ? g.policy : 'understand-only', updatedAt: '2026-10-0' + (k + 1) + 'T00:00:00Z' });
  }
}

const fixture = await startConsoleFixture({ port: 0 });
const ui = makeUi(fixture.url);

const out = ui.dedupeStickerEntries(base);
console.log(`[去重] before=${out.before} after=${out.after} merged=${out.merged}`);
check('92 条 → 去重后 84 条、合并掉 8 条', () => {
  assert.equal(out.before, 92);
  assert.equal(out.after, 84);
  assert.equal(out.merged, 8);
});
const mergedTheme = out.unique.find((e) => e.md5 === 'ICSZQU');
console.log(`[合并] note="${mergedTheme.localNote}" policy=${mergedTheme.policy} tags=${JSON.stringify(mergedTheme.tags)} merged=${mergedTheme.__mergedCount}`);
check('人工备注不丢（「表示自己楚楚可怜」）', () => assert.equal(mergedTheme.localNote, '表示自己楚楚可怜'));
check('标签取并集（tagA 保留）', () => assert.ok(mergedTheme.tags.includes('tagA')));
check('可发/不可发冲突时保留可发（不丢人工设置）', () => assert.equal(mergedTheme.policy, 'usable'));
check('重复分组记录合并条数', () => assert.equal(mergedTheme.__mergedCount, 4));

const again = ui.dedupeStickerEntries(out.unique);
check('幂等：再去重一次 merged=0', () => {
  assert.equal(again.merged, 0);
  assert.equal(again.after, 84);
});

// 数据侧按钮：接口未就绪（404）时给出精确文案，不假成功
ui.msgs.length = 0;
await ui.dedupeStickers({ disabled: false, textContent: '合并重复' });
console.log(`[dedupe 404] ${ui.msgs.join(' | ')}`);
check('合并接口 404 → 文案含接口与状态，不出现成功字样', () => {
  const text = ui.msgs.join(' ');
  assert.match(text, /POST \/api\/stickers\/dedupe 404/);
  assert.ok(!/已合并/.test(text), text);
});

// 接口就绪：fixture 返回 { merged, before, after }
await fetch(fixture.url + '/__fixture/stickers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'dedupeok' }) });
ui.msgs.length = 0;
await ui.dedupeStickers({ disabled: false, textContent: '合并重复' });
console.log(`[dedupe ok] ${ui.msgs.join(' | ')}`);
check('合并成功 → 显示 merged 与 before→after', () => {
  const text = ui.msgs.join(' ');
  assert.match(text, /已合并 8 条重复（92 → 84）/);
});

await fixture.close();

// ── 数据侧：src/sticker-lib.js 的 dedupe / save 护栏（这批修的根因就在这）────────
{
  const lib = await import('../src/sticker-lib.js');
  const os = await import('node:os');
  const path = await import('node:path');

  const mk = (over) => ({
    id: over.id, resId: over.id, url: over.url || '', md5: over.md5 || '', desc: over.desc || '',
    localNote: over.localNote || '', tags: over.tags || [], policy: over.policy || 'understand-only',
    dhash: over.dhash || '', useCount: over.useCount || 0, source: over.source || 'observe',
    ...over,
  });

  // 同 md5 两条：保留有 cache 的那条、localNote/tags 不丢
  {
    const list = [
      mk({ id: 'a1', md5: 'AAAA', localNote: '', tags: ['打招呼'], desc: '' }),
      mk({ id: 'a2', md5: 'AAAA', localNote: '表示开心', tags: ['开心'], useCount: 3 }),
    ];
    const out = lib.dedupeStickerEntries(list);
    console.log(`[同 md5] ${list.length} → ${out.length}`);
    check('同 md5 两条 → 合并为一条，localNote/tags 保留', () => {
      assert.equal(out.length, 1);
      assert.equal(out[0].localNote, '表示开心');
      assert.deepEqual([...out[0].tags].sort(), ['开心', '打招呼']);
      assert.equal(out[0].useCount, 3);
    });
    check('幂等：再跑一次条数不变', () => assert.equal(lib.dedupeStickerEntries(out).length, 1));
  }

  // 同 emojiId、无 md5：按 emojiId 合并
  {
    const list = [mk({ id: 'e1', emojiId: 'EMOJI-1' }), mk({ id: 'e2', emojiId: 'EMOJI-1' })];
    const out = lib.dedupeStickerEntries(list);
    console.log(`[同 emojiId] ${list.length} → ${out.length}`);
    check('同 emojiId 无 md5 → 合并为一条', () => assert.equal(out.length, 1));
  }

  // 同图不同 md5（重编码）用 dhash 兜底合并
  {
    const list = [
      mk({ id: 'd1', md5: '1111', dhash: '589c96589c98e0e0', localNote: '围观' }),
      mk({ id: 'd2', md5: '2222', dhash: '589c96589c98e0e0' }),
    ];
    const out = lib.dedupeStickerEntries(list);
    console.log(`[同 dhash 不同 md5] ${list.length} → ${out.length}`);
    check('dhash 相同、md5 不同 → 合并（重编码变体不再两张卡）', () => {
      assert.equal(out.length, 1);
      assert.equal(out[0].localNote, '围观');
    });
  }

  // dhash 太短不合并（避免误并相似图）
  {
    const list = [mk({ id: 's1', md5: '31', dhash: 'abc' }), mk({ id: 's2', md5: '32', dhash: 'abc' })];
    check('dhash 短于 8 位不合并', () => assert.equal(lib.dedupeStickerEntries(list).length, 2));
  }

  // 写入口也去重：saveStickerStore 落盘的必须是合并后的
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-save-'));
    const file = path.join(dir, 'stickers.json');
    lib.saveStickerStore(file, [mk({ id: 'w1', md5: 'FFFF' }), mk({ id: 'w2', md5: 'FFFF', localNote: '备注' })]);
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`[save 去重] 落盘 ${back.length} 条`);
    check('saveStickerStore 写盘前也去重（不只读时）', () => {
      assert.equal(back.length, 1);
      assert.equal(back[0].localNote, '备注');
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 不可恢复条目（thumbStatus=missing）不能被静默删掉
  {
    const list = [
      mk({ id: 'm1', md5: 'AAAA', thumbStatus: 'missing', thumbError: '源链接已过期' }),
      mk({ id: 'h1', md5: 'BBBB' }),
    ];
    const out = lib.dedupeStickerEntries(list);
    console.log(`[missing 保留] ${list.length} → ${out.length}`);
    check('thumbStatus=missing 的唯一条目不会被去重删掉', () => {
      assert.equal(out.length, 2);
      assert.ok(out.some((e) => e.id === 'm1' && e.thumbStatus === 'missing'));
    });
  }

  // 没有 md5 时 url 去 query 后同一张图合并（QQ 链接带过期签名）
  {
    const list = [
      mk({ id: 'u1', url: 'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=X' }),
      mk({ id: 'u2', url: 'https://multimedia.nt.qq.com.cn/download?appid=2&fileid=X' }),
    ];
    const out = lib.dedupeStickerEntries(list);
    console.log(`[同 url path] ${list.length} → ${out.length}`);
    check('无 md5 时 url 去掉 query 后同一张图合并', () => assert.equal(out.length, 1));
  }
}

// ── dHash 视觉去重 + QQ URL 身份键（2026-10-26 线上「同一张图两张卡」回归）────────
// 现象：面板里有 11 对视觉同一张、md5 不同的表情各自成卡。
// 根因三条：① 重编码后 md5 变了，只有 dHash 认得出；② collectSticker 从不写 dhash，
// 196 条里只有 53 条有，兜底比对基本失效；③ dedupe 的 dhash 分支要求完全相等，差 1 bit 就漏。
{
  const lib = await import('../src/sticker-lib.js');
  const mkc = (over) => ({ id: 'x', desc: '', localNote: '', tags: [], ...over });

  // 线上同图不同 md5 的真实一对（「粉色小动物」，dhash 完全一致）
  const PAIR_A = mkc({
    id: '100000007_0_0_0_18502EFD5D28C35D2A3091E6F4E763B0_0_0_0',
    md5: '18502EFD5D28C35D2A3091E6F4E763B0',
    dhash: '589c96589c98e0e0',
    source: 'qq', localNote: '一般用在围观、旁观', policy: 'usable', useCount: 3
  });
  const PAIR_B = mkc({
    id: '100000007_0_0_0_2E997EFEB6AB15A6B46F518C6C1DCA60_0_0',
    md5: '2E997EFEB6AB15A6B46F518C6C1DCA60',
    dhash: '589c96589c98e0e0',
    source: 'qq', policy: 'understand-only'
  });

  console.log('\n[dHash 去重]');
  check('dhashDistance：相同 0 / 差 1 bit 为 1 / 非法值 64', () => {
    assert.equal(lib.dhashDistance('589c96589c98e0e0', '589c96589c98e0e0'), 0);
    assert.equal(lib.dhashDistance('303c96879686230f', '303896879686230f'), 1);
    assert.equal(lib.dhashDistance('', '589c96589c98e0e0'), 64);
  });
  check('dhash 差 1 bit 的同一张图（「晚安咪」小猫）→ 合并成 1 条', () => {
    const a = mkc({ id: 'c_912b', md5: '912B2831425FE10BEBFA889CD636F5EA', dhash: '303c96879686230f' });
    const b = mkc({ id: 'c_a72b', md5: 'A72BAFBD6A098038FE62AB8F68B09474', dhash: '303896879686230f' });
    assert.equal(lib.dedupeStickerEntries([a, b]).length, 1);
  });
  check('dhash 相同 + md5 不同 → 合并，人工备注/使用次数/可发都保留', () => {
    const out = lib.dedupeStickerEntries([PAIR_A, PAIR_B]);
    assert.equal(out.length, 1);
    assert.equal(out[0].localNote, '一般用在围观、旁观');
    assert.equal(out[0].useCount, 3);
    assert.equal(out[0].policy, 'usable');
  });
  check('误合并防护：dhash 差 4 的两张白底文字截图 → 必须保持 2 条', () => {
    // 实测：880x768 / 880x1372 两张 VRchat 查询图，留白让 dHash 只差 4，肉眼看完全不同
    const a = mkc({ id: 'c_v1', md5: '6D36178285154BD64DA79F28054EFD4A', dhash: '80808880888080a0' });
    const b = mkc({ id: 'c_v2', md5: 'FEE40650D133E781C9D214DDB5692D4D', dhash: '8080c08080808080' });
    assert.equal(lib.dedupeStickerEntries([a, b]).length, 2);
  });
  check('drop 掉的那条若是「可发」，主条也要变成可发（人工设置不能丢）', () => {
    const rich = mkc({ id: 'r1', md5: 'AAAA0000AAAA0000AAAA0000AAAA0000', dhash: '589c96589c98e0e0', localNote: '有备注' });
    const usable = mkc({ id: 'r2', md5: 'BBBB0000BBBB0000BBBB0000BBBB0000', dhash: '589c96589c98e0e0', policy: 'usable' });
    const out = lib.dedupeStickerEntries([rich, usable]);
    assert.equal(out.length, 1);
    assert.equal(out[0].policy, 'usable');
  });

  console.log('\n[QQ URL 身份键]');
  check('fileid 不同 → 两个键（122 条共用 host+path 的陷阱）', () => {
    const u1 = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=AAA&spec=0&rkey=deadbeef';
    const u2 = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=BBB&spec=0&rkey=deadbeef';
    assert.notEqual(lib.stickerUrlKey(u1), lib.stickerUrlKey(u2));
  });
  check('fileid 相同、rkey 轮换 → 同一个键（签名不能当身份）', () => {
    const u1 = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=AAA&spec=0&rkey=OLD';
    const u2 = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=AAA&spec=0&rkey=NEW';
    assert.equal(lib.stickerUrlKey(u1), lib.stickerUrlKey(u2));
  });
  check('三张只有 fileid 不同的链接（都无 md5）→ 不能被并成一条', () => {
    const list = ['AAA', 'BBB', 'CCC'].map((fid) => mkc({
      id: `c_${fid}`, url: `https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=${fid}&spec=0&rkey=zz`
    }));
    assert.equal(lib.dedupeStickerEntries(list).length, 3);
  });

  console.log('\n[混合输入：QQ 同步项 + 本地收集项]');
  check('两条同图来源不同（QQ 同步 / 观察群收集）→ 输出无重复', () => {
    const fromQq = mkc({
      id: '100000007_0_0_0_2E997EFEB6AB15A6B46F518C6C1DCA60_0_0',
      emojiId: '100000007_0_0_0_2E997EFEB6AB15A6B46F518C6C1DCA60_0_0',
      md5: '2E997EFEB6AB15A6B46F518C6C1DCA60', dhash: '589c96589c98e0e0',
      url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=QQ_SYNC&spec=0&rkey=a',
      source: 'qq', desc: 'QQ 自带备注'
    });
    const fromCollect = mkc({
      id: 'c_18502efd5d28c35d2a3091e6', md5: '18502EFD5D28C35D2A3091E6F4E763B0', dhash: '589c96589c98e0e0',
      url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=COLLECT&spec=0&rkey=b',
      source: '观察群 100000005', localNote: '表示围观'
    });
    const out = lib.dedupeStickerEntries([fromQq, fromCollect]);
    assert.equal(out.length, 1, '同图必须只剩一条');
  });
  check('formatStickerList（下发给面板/AI 的读取路径）也去重', () => {
    const r = lib.formatStickerList([PAIR_A, PAIR_B], '', 48);
    assert.equal(r.total, 1);
    assert.equal(r.stickers.length, 1);
  });
  check('幂等：dedupe(dedupe(x)) 条数与 id 集合不变', () => {
    const input = [PAIR_A, PAIR_B, mkc({ id: 'c_other', md5: 'ABCDEF0123456789ABCDEF0123456789', dhash: '0f0f0f0f0f0f0f0f' })];
    const once = lib.dedupeStickerEntries(input);
    const twice = lib.dedupeStickerEntries(once);
    assert.equal(twice.length, once.length);
    assert.deepEqual(twice.map((e) => e.id).sort(), once.map((e) => e.id).sort());
  });
}

console.log('\n' + results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(failed ? `\n${failed} 项失败` : `\n${results.length} 项全过（92→84 / 备注与标签不丢 / 可发优先 / 幂等 / 接口 404 与成功两态 / lib 去重与写盘护栏 / dHash 视觉去重 / QQ URL 身份键）`);
