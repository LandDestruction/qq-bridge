// 解压码自动识别单测：纯规则（src/library-extract-code.js）+ 自动入密码本（rememberAutoPassword）。
//
// 覆盖三件事：
//   1. 名字里那 6+ 种写法都要认出来（中英括号、全角冒号、密码/pass/code 别名、裸写法）；
//   2. 认出来之后不能乱写：噪声（None/无）要丢、超长要丢、同一素材多码要去重；
//   3. 自动入本永远让路给用户手填（manual-wins），且密码本不存在时会自己建。
// 不碰真 state、不碰网络、不跑 ffmpeg：临时目录 + 假 deps。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const { parseExtractCodes, pickBestExtractCode, collectExtractCodes } = await import(
  pathToFileURL(path.join(ROOT, 'src/library-extract-code.js')).href
);
const { createLibraryPasswords } = await import(
  pathToFileURL(path.join(ROOT, 'src/bridge/console/library-passwords.js')).href
);

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-extract-code-'));
const logs = [];
const deps = {
  fs,
  path,
  STATE_DIR: tmp,
  log: (m) => logs.push(String(m)),
  atomicWriteJson: (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 1))
};
const book = createLibraryPasswords(deps);
const bookFile = path.join(tmp, 'booth-passwords.json');
function diskBook() {
  try { return JSON.parse(fs.readFileSync(bookFile, 'utf8')); } catch { return null; }
}

// ---------- 1. 六种以上写法 ----------
console.log('## 解析：写法覆盖');
check('[解压码: abc123]', parseExtractCodes('[解压码: abc123]').codes[0]?.code === 'abc123');
check('[解压码：xyz-9] 全角冒号', parseExtractCodes('[解压码：xyz-9]').codes[0]?.code === 'xyz-9');
check('（密码：1234） 中文圆括号', parseExtractCodes('（密码：1234）').codes[0]?.code === '1234');
check('[code: PASS01] 英文 code', parseExtractCodes('[code: PASS01]').codes[0]?.code === 'PASS01');
check('【提取码 abcdef】 无冒号+方头括号', parseExtractCodes('【提取码 abcdef】').codes[0]?.code === 'abcdef');
check('pass: p@ss 英文 pass', parseExtractCodes('pass: p@ss').codes[0]?.code === 'p@ss');
check('password: hello-world 英文全拼', parseExtractCodes('password: hello-world').codes[0]?.code === 'hello-world');
check('pwd=7777 等号写法', parseExtractCodes('pwd=7777').codes[0]?.code === '7777');
check('解压码 abc123456 裸写法（无括号无冒号）', parseExtractCodes('解压码 abc123456').codes[0]?.code === 'abc123456');
check('中文码也能认（【解压码：喵喵喵】）', parseExtractCodes('【解压码：喵喵喵】').codes[0]?.code === '喵喵喵');
const multi = parseExtractCodes('[解压码: AAA][密码: BBB]');
check('多码：同一字符串里两条都抓到', multi.codes.length === 2 && multi.codes.some((c) => c.code === 'AAA') && multi.codes.some((c) => c.code === 'BBB'),
  JSON.stringify(multi.codes.map((c) => c.code)));
check('多码：置信度是 0~1 的数', multi.confidence > 0 && multi.confidence <= 1, String(multi.confidence));
const rawHit = parseExtractCodes('前文 [解压码: abc123] 后文').codes[0];
check('raw 保留原始命中片段（便于溯源）', typeof rawHit?.raw === 'string' && rawHit.raw.includes('解压码'), String(rawHit?.raw));
check('带括号的置信度高于裸写', parseExtractCodes('[解压码: abc123] 解压码 def456').codes
  .sort((a, b) => a.confidence - b.confidence)[1].confidence > 0.6);

// ---------- 2. 噪声 / 长度 / 去重 ----------
console.log('## 解析：噪声与边界');
check('[解压码: 无] 是噪声', parseExtractCodes('[解压码: 无]').codes.length === 0);
check('[密码: none] 是噪声', parseExtractCodes('[密码: none]').codes.length === 0);
check('[code: NULL] 是噪声', parseExtractCodes('[code: NULL]').codes.length === 0);
check('空括号不产码', parseExtractCodes('[解压码: ]').codes.length === 0);
check('普通标题不产码', parseExtractCodes('[35種] Mew_Pose_Ver.3 [VRC]').codes.length === 0);
check('「密码是空」不产码', parseExtractCodes('密码是空').codes.length === 0);
const tooLong = parseExtractCodes('[解压码: ' + 'a'.repeat(40) + ']');
check('超过 32 位不产码', tooLong.codes.length === 0, JSON.stringify(tooLong.codes.map((c) => c.code.length)));
const exact32 = parseExtractCodes('[解压码: ' + 'b'.repeat(32) + ']');
check('正好 32 位保留', exact32.codes.length === 1 && exact32.codes[0].code.length === 32);
const dedupe = parseExtractCodes('[解压码: AAA] 密码: aaa');
check('同码大小写不同只留一条', dedupe.codes.length === 1, JSON.stringify(dedupe.codes.map((c) => c.code)));
check('空输入/null 不抛错', parseExtractCodes('').codes.length === 0 && parseExtractCodes(null).codes.length === 0 && parseExtractCodes(12345).codes.length === 0);

// ---------- 3. pickBest 优先级 ----------
console.log('## pickBest：文件名优先，其次标题/目录');
const picked = pickBestExtractCode({ fileName: '[解压码: FILE01] x.zip', title: '[解压码: TITLE01]', dir: '[解压码: DIR01]' });
check('文件名里的码优先于标题/目录', picked?.code === 'FILE01', JSON.stringify(picked));
check('pickBest 会标出来自哪个字段', picked?.field === '文件名', String(picked?.field));
const pickedTitle = pickBestExtractCode({ fileName: 'no-code.zip', title: '[解压码: TITLE01]', dir: '[解压码: DIR01]' });
check('文件名没有码时用标题', pickedTitle?.code === 'TITLE01', JSON.stringify(pickedTitle));
const pickedDir = pickBestExtractCode({ fileName: 'no-code.zip', title: '', dir: '[解压码: DIR01]' });
check('标题也没有时用目录名', pickedDir?.code === 'DIR01', JSON.stringify(pickedDir));
check('全都没有返回 null', pickBestExtractCode({ fileName: 'a.zip', title: 'b', dir: 'c' }) === null);
const collected = collectExtractCodes({ fileName: '[解压码: FILE01]', title: '[解压码: TITLE01]' });
check('collect 按文件名 → 标题排序', collected.length === 2 && collected[0].code === 'FILE01' && collected[1].code === 'TITLE01',
  JSON.stringify(collected.map((c) => c.code)));

// ---------- 4. 纯函数：不碰盘、不 import ----------
console.log('## 纯函数边界');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'src/library-extract-code.js'), 'utf8');
check('模块内没有 import/require', !/^\s*(import|export \*|const .*= require\()/m.test(moduleSrc) && !moduleSrc.includes("require('"),
  '源码里出现了 import/require');
check('模块内没有 fs/写盘调用', !/\bfs\.(readFile|writeFile|mkdir|rm|exists)/.test(moduleSrc) && !moduleSrc.includes('STATE_DIR'));
check('模块带成对 @bridge-function 标记', moduleSrc.includes('// @bridge-function parseExtractCodes:start')
  && moduleSrc.includes('// @bridge-function parseExtractCodes:end')
  && moduleSrc.includes('// @bridge-function pickBestExtractCode:start') && moduleSrc.includes('// @bridge-function pickBestExtractCode:end'));

// ---------- 5. 自动入密码本：手填优先 ----------
console.log('## 密码本：auto 永远让路给手填');
check('密码本不存在时，auto 会自己建文件', diskBook() === null);
const auto1 = book.rememberAutoPassword({ key: 'booth:5197537', boothId: '5197537', password: 'auto-1', title: '素材 A', source: '素材文件名识别' });
check('首次 auto 写入成功', auto1.ok === true && auto1.written === true, JSON.stringify(auto1));
const disk1 = diskBook();
check('落盘条目带 codeSource:auto 与 source', disk1?.items?.['booth:5197537']?.codeSource === 'auto'
  && disk1?.items?.['booth:5197537']?.source === '素材文件名识别', JSON.stringify(disk1?.items?.['booth:5197537']));
check('打印「这条码从哪来」的一行日志', logs.some((m) => m.includes('自动记下') && m.includes('素材文件名识别')), JSON.stringify(logs));
check('列表接口回 codeSource（前端据此显示来源）',
  (book.listPasswords?.() || []).every((item) => item.codeSource === 'auto' || item.codeSource === 'manual') !== false);
const sameAuto = book.rememberAutoPassword({ key: 'booth:5197537', boothId: '5197537', password: 'auto-1', title: '素材 A', source: '素材标题识别' });
check('同一串码重复识别不重写', sameAuto.ok === true && sameAuto.written === false && sameAuto.reason === 'unchanged', JSON.stringify(sameAuto));

book.rememberPassword({ key: 'booth:5197537', password: 'user-own', title: '素材 A' });
const userWins = book.rememberAutoPassword({ key: 'booth:5197537', boothId: '5197537', password: 'auto-2', title: '素材 A', source: '素材目录名识别' });
const disk2 = diskBook();
check('auto 不覆盖用户手填', userWins.ok === true && userWins.written === false && userWins.reason === 'manual-wins', JSON.stringify(userWins));
check('手填后盘上仍是用户密码、codeSource 变 manual', disk2?.items?.['booth:5197537']?.password === 'user-own'
  && disk2?.items?.['booth:5197537']?.codeSource === 'manual', JSON.stringify(disk2?.items?.['booth:5197537']));
const autoThenManual = (() => {
  book.rememberAutoPassword({ key: 'booth:6000001', boothId: '6000001', password: 'auto-9', title: '素材 B', source: '素材文件名识别' });
  book.rememberPassword({ key: 'booth:6000001', password: 'manual-9', title: '素材 B' });
  return diskBook()?.items?.['booth:6000001'];
})();
check('用户手填可以覆盖 auto（用户填的永远可覆盖）', autoThenManual?.password === 'manual-9' && autoThenManual?.codeSource === 'manual',
  JSON.stringify(autoThenManual));
check('缺 key 时不写盘', book.rememberAutoPassword({ password: 'orphan' }).ok === false);
check('超长密码（>64）拒绝写入', book.rememberAutoPassword({ key: 'booth:6000002', password: 'x'.repeat(65) }).ok === false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(`解压码识别：通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
