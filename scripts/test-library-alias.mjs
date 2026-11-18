// 素材库识别规则表（别名表）：纯规则 + 路由（GET/PUT /api/library/alias-rules）与 assets 字段。
// 为什么要有这一套：日文原名/圈内写法（プラム、R-18、ノーマル）认不出，用户自己维护
// `显示名=别名|别名` 才能让找号搜到 BOOTH 上的真实写法。规则解析放纯函数，路由只做校验+落盘。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const alias = await import(pathToFileURL(path.join(ROOT, 'src/library-alias.js')).href);
const { createLibraryView } = await import(pathToFileURL(path.join(ROOT, 'src/bridge/console/library-view.js')).href);
const {
  parseAliasLine, normalizeAliasTable, resolveAlias, expandSearchPhrases, applyAliasToAsset,
  ALIAS_RULES_VERSION, ALIAS_LINE_MAX, ALIAS_TERMS_MAX, ALIAS_ENTRIES_MAX
} = alias;

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${error?.message ?? error}`);
  }
}
function eq(name, actual, expected) {
  check(name, () => assert.deepEqual(actual, expected));
}

console.log('## 解析一行规则');
eq('基本形状', parseAliasLine('プラム=梅|plum'), { display: 'プラム', aliases: ['梅', 'plum'] });
eq('全角 ＝ 与 ｜ 也认', parseAliasLine('ノーマル＝通常｜normal'), { display: 'ノーマル', aliases: ['通常', 'normal'] });
eq('两侧空格会被 trim', parseAliasLine('  R-18 = 成人向 | 18禁 '), { display: 'R-18', aliases: ['成人向', '18禁'] });
eq('空行 → null', parseAliasLine('   '), null);
eq('# 注释 → null', parseAliasLine('# 这行是注释'), null);
eq('没有等号 → null', parseAliasLine('没有等号'), null);
eq('缺显示名 → null', parseAliasLine('=只有别名'), null);
eq('缺别名 → null', parseAliasLine('只有显示名='), null);
eq('别名去重（大小写/全半角不敏感）', parseAliasLine('X=A|a|Ａ'), { display: 'X', aliases: ['A'] });
eq('超长 → null', parseAliasLine(`${'长'.repeat(ALIAS_LINE_MAX)}=x`), null);
check('刚好 200 字符可以', () => {
  const display = '长'.repeat(ALIAS_LINE_MAX - 2);
  const parsed = parseAliasLine(`${display}=x`);
  assert.ok(parsed && parsed.display === display);
});
eq('别名条数封顶', parseAliasLine(`Y=${Array.from({ length: 40 }, (_, i) => `a${i}`).join('|')}`).aliases.length, ALIAS_TERMS_MAX);

console.log('## 整表归一化');
eq('接受数组', normalizeAliasTable([{ display: 'A', aliases: ['a1'] }]).entries, [{ display: 'A', aliases: ['a1'] }]);
eq('接受 {rules}', normalizeAliasTable({ rules: [{ display: 'B', aliases: ['b1'] }] }).entries, [{ display: 'B', aliases: ['b1'] }]);
eq('接受 {entries} 与字符串行', normalizeAliasTable({ entries: ['C=c1|c2'] }).entries, [{ display: 'C', aliases: ['c1', 'c2'] }]);
check('版本号固定', () => assert.equal(normalizeAliasTable(null).version, ALIAS_RULES_VERSION));
eq('坏输入当空表', normalizeAliasTable('nope').entries, []);
eq('同显示名合并别名（大小写/全半角）', normalizeAliasTable([
  { display: 'Booth', aliases: ['b1'] },
  { display: 'ＢＯＯＴＨ', aliases: ['b2', 'b1'] }
]).entries, [{ display: 'Booth', aliases: ['b1', 'b2'] }]);
check('空别名条目丢掉', () => {
  assert.deepEqual(normalizeAliasTable([{ display: 'D', aliases: [] }, { display: '', aliases: ['x'] }, 'E=e1']).entries, [{ display: 'E', aliases: ['e1'] }]);
});
check(`条数封顶 ${ALIAS_ENTRIES_MAX}`, () => {
  const rows = Array.from({ length: ALIAS_ENTRIES_MAX + 30 }, (_, i) => ({ display: `D${i}`, aliases: [`a${i}`] }));
  assert.equal(normalizeAliasTable(rows).entries.length, ALIAS_ENTRIES_MAX);
});

console.log('## 命中与扩展');
const table = normalizeAliasTable([
  { display: 'プラム', aliases: ['梅', 'plum'] },
  { display: 'ノーマル', aliases: ['通常'] }
]);
eq('精确命中', resolveAlias('プラム', table), 'プラム');
eq('包含命中（标题里带原名）', resolveAlias('【プラム】衣装セット', table), 'プラム');
eq('大小写不敏感', resolveAlias('PLUM セット', table), '');
eq('别名本身不反向命中（只认显示名）', resolveAlias('梅セット', table), '');
eq('没命中 → 空串', resolveAlias('无关标题', table), '');
eq('空表/坏表 → 空串', [resolveAlias('プラム', null), resolveAlias('プラム', { entries: null })], ['', '']);
eq('最长显示名优先', resolveAlias('ノーマル衣装', normalizeAliasTable([
  { display: 'ノー', aliases: ['a'] },
  { display: 'ノーマル', aliases: ['b'] }
])), 'ノーマル');
eq('扩展：原词在前 + 显示名 + 别名', expandSearchPhrases('プラム衣装', table), ['プラム衣装', 'プラム', '梅', 'plum']);
eq('扩展最多 4 条', expandSearchPhrases('プラム衣装', table).length, 4);
eq('没命中只有原词', expandSearchPhrases('别的标题', table), ['别的标题']);
eq('原词为空 → 空数组', expandSearchPhrases('', table), []);
check('扩展词去重', () => {
  const phrases = expandSearchPhrases('プラム', normalizeAliasTable([{ display: 'プラム', aliases: ['プラム', 'プラム'] }]));
  assert.deepEqual(phrases, ['プラム']);
});

console.log('## 素材卡字段');
check('命中给 aliasTitle/aliasTerms，不改 title', () => {
  const asset = { key: 'k', title: '【プラム】衣装', dir: 'g/c' };
  const out = applyAliasToAsset(asset, table);
  assert.equal(out.aliasTitle, 'プラム');
  assert.deepEqual(out.aliasTerms, ['梅', 'plum']);
  assert.equal(out.title, '【プラム】衣装');
  assert.equal(asset.aliasTitle, undefined);
});
check('没命中给空字段（前端不用判 undefined）', () => {
  const out = applyAliasToAsset({ key: 'k', title: '别的' }, table);
  assert.equal(out.aliasTitle, '');
  assert.deepEqual(out.aliasTerms, []);
});
eq('坏输入原样返回', applyAliasToAsset(null, table), null);

console.log('## 路由：GET / PUT /api/library/alias-rules');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'library-alias-'));
const libDir = path.join(tmp, 'lib');
fs.mkdirSync(libDir, { recursive: true });
const logs = [];
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  ROOT,
  log: (m) => logs.push(String(m)),
  atomicWriteJson: (file, value) => {
    const tmpFile = `${file}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(value, null, 2));
    fs.renameSync(tmpFile, file);
  },
  fileArchiveRootDir: () => libDir,
  boothCacheDir: () => path.join(tmp, 'cache'),
  fileArchiveDb: () => ({}),
  listArchive: () => [],
  buildLibrarySnapshot: () => ({
    ok: true,
    root: libDir,
    count: 2,
    bytes: 20,
    withBooth: 0,
    withThumb: 0,
    assets: [
      { key: 'g/c/plum', title: '【プラム】衣装セット', dir: 'g/c', file: 'plum.zip', boothId: '', boothSource: '', thumbRel: '' },
      { key: 'g/c/other', title: '别的素材', dir: 'g/c', file: 'other.zip', boothId: '', boothSource: '', thumbRel: '' }
    ]
  }),
  getBoothCoverPath: () => '',
  safeResolveInside: (root, rel) => path.join(root, rel),
  mimeFromBuffer: () => 'image/png',
  spawn: () => ({ unref() {} }),
  libraryNotes: {},
  getBoothCover: async () => ({ ok: false }),
  fetchBoothMeta: async () => null
};
const view = createLibraryView(deps);

function makeReq({ method = 'GET', pathname = '/api/library/alias-rules', headers = {}, body = null } = {}) {
  let sent = null;
  return {
    req: { method, headers },
    url: { pathname, searchParams: new URLSearchParams() },
    readBody: async () => body,
    sendJson: (payload, code) => { sent = { payload, code: code || 200 }; },
    getSent: () => sent
  };
}
const aliasFile = path.join(tmp, 'library-alias-rules.json');

await checkAsync('GET 空表：ok + table/count/text/examples', async () => {
  const req = makeReq();
  await view.handleLibraryAssetsRoute(req);
  const sent = req.getSent();
  assert.equal(sent.code, 200);
  assert.equal(sent.payload.ok, true);
  assert.equal(sent.payload.count, 0);
  assert.deepEqual(sent.payload.table.entries, []);
  assert.equal(sent.payload.text, '');
  assert.ok(sent.payload.examples.length >= 2);
});

await checkAsync('PUT 多行文本：注释/空行忽略，落盘两条，幂等', async () => {
  const body = { text: '# 注释\nプラム=梅|plum\n\nノーマル＝通常｜normal\n' };
  const first = makeReq({ method: 'PUT', body });
  await view.handleLibraryAssetsRoute(first);
  assert.equal(first.getSent().payload.ok, true);
  assert.equal(first.getSent().payload.count, 2);
  const onDisk = JSON.parse(fs.readFileSync(aliasFile, 'utf8'));
  assert.deepEqual(onDisk.entries.map((e) => e.display), ['プラム', 'ノーマル']);
  const second = makeReq({ method: 'PUT', body });
  await view.handleLibraryAssetsRoute(second);
  assert.equal(second.getSent().payload.count, 2);
  assert.equal(JSON.parse(fs.readFileSync(aliasFile, 'utf8')).entries.length, 2);
});

await checkAsync('PUT 非法行：400 + 原文报错 + 不写盘', async () => {
  const before = fs.readFileSync(aliasFile, 'utf8');
  const req = makeReq({ method: 'PUT', body: { text: '好规则=ok\n这一行没有等号\n' } });
  await view.handleLibraryAssetsRoute(req);
  const sent = req.getSent();
  assert.equal(sent.code, 400);
  assert.equal(sent.payload.ok, false);
  assert.ok(sent.payload.errors[0].includes('这一行没有等号'), JSON.stringify(sent.payload.errors));
  assert.equal(fs.readFileSync(aliasFile, 'utf8'), before);
});

await checkAsync('agent 令牌一律 403', async () => {
  const get = makeReq({ headers: { 'x-agent-token': 'x' } });
  await view.handleLibraryAssetsRoute(get);
  assert.equal(get.getSent().code, 403);
  const put = makeReq({ method: 'PUT', headers: { 'x-agent-call': '1' }, body: { rules: [] } });
  await view.handleLibraryAssetsRoute(put);
  assert.equal(put.getSent().code, 403);
});

await checkAsync('非 GET/PUT → 405', async () => {
  const req = makeReq({ method: 'POST', body: {} });
  await view.handleLibraryAssetsRoute(req);
  assert.equal(req.getSent().code, 405);
});

await checkAsync('assets 快照带 aliasTitle/aliasTerms（title 不变）', async () => {
  const req = makeReq({ method: 'GET', pathname: '/api/library/assets' });
  await view.handleLibraryAssetsRoute(req);
  const payload = req.getSent().payload;
  const hit = payload.assets.find((a) => a.key === 'g/c/plum');
  assert.equal(hit.aliasTitle, 'プラム');
  assert.deepEqual(hit.aliasTerms, ['梅', 'plum']);
  assert.equal(hit.title, '【プラム】衣装セット');
  assert.equal(payload.aliasCount, 2);
  assert.equal(payload.aliasHits, 1);
  const miss = payload.assets.find((a) => a.key === 'g/c/other');
  assert.equal(miss.aliasTitle, '');
});

await checkAsync('rules 数组入口也认（对象形式）', async () => {
  const req = makeReq({ method: 'PUT', body: { rules: [{ display: 'アイテム', aliases: ['item'] }] } });
  await view.handleLibraryAssetsRoute(req);
  assert.equal(req.getSent().payload.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(aliasFile, 'utf8')).entries[0].display, 'アイテム');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (failures.length) {
  console.error(`❌ test-library-alias：${pass} 通过 / ${failures.length} 失败`);
  console.error('   失败项：' + failures.join('；'));
  process.exit(1);
}
console.log(`🎉 test-library-alias 全部通过（${pass} 项）`);
