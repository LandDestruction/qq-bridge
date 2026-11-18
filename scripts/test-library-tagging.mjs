// 名字标签纯规则单测：解压码 / RJ 号 / BOOTH 商品号 / 方括号标签。不碰磁盘、不碰网络。
//
// 为什么单独一套：这四个抽取规则是「用户一看就信」的元数据——密码错了会拿着去解压，
// RJ 号错了会找错作品。所以每条形态（全角冒号、日文句子、None 占位、裸 RJ、超长输入）
// 都要有断言钉住，且必须钉住「认不出就返回空、不猜」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TAGGING_MAX_TAGS, TAGGING_MAX_INPUT, TAGGING_MAX_PASSWORD,
  parseArchivePassword, parseRjCode, parseBoothSellerItemIds, parseNameTags, describeAssetTags
} from '../src/library-tagging.js';

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

// 真实素材名：前四条是用户库里实际出现过的形态（MioVRC 参考里也有同名例子）。
const REAL_NAMES = {
  mixture: '【SOPW】【RPG生肉】パラダイス・サキュバス [解压码: None]RJ0123456.zip',
  gameWithPw: '[解压密码: acg18] [RPG][RJ] 魔王を倒すゲーム.zip',
  tagsOnly: '[SOPW] [RPG生肉] パラダイス・サキュバス.zip',
  avatar: 'ShiroTensi 【19アバター対応】.zip'
};

console.log('## 常量');
check('标签上限 8、输入截断 200、密码上限 64', () => {
  assert.equal(TAGGING_MAX_TAGS, 8);
  assert.equal(TAGGING_MAX_INPUT, 200);
  assert.equal(TAGGING_MAX_PASSWORD, 64);
});

console.log('## parseArchivePassword：方括号形态');
check('[解压码: xxx]', () => {
  assert.deepEqual(parseArchivePassword('[解压码: abc123] x.zip'), { password: 'abc123', matched: '[解压码: abc123]' });
});
check('[解压密码: acg18]（真实名）', () => {
  assert.equal(parseArchivePassword(REAL_NAMES.gameWithPw).password, 'acg18');
});
check('[码: xyz]', () => {
  assert.equal(parseArchivePassword('[码: xyz] x.zip').password, 'xyz');
});
check('[パスワード: pass123]', () => {
  assert.equal(parseArchivePassword('[パスワード: pass123] x.zip').password, 'pass123');
});
check('[pw: abc]', () => {
  assert.equal(parseArchivePassword('[pw: abc] x.zip').password, 'abc');
});
check('【】 全角括号也认', () => {
  assert.equal(parseArchivePassword('【解压码: bracket1】x.zip').password, 'bracket1');
});
check('［］ 全角方括号 + 全角冒号', () => {
  assert.equal(parseArchivePassword('［解压码：ｐｗ１２３］全角.zip').password, 'pw123');
});
check('括号里的值带空格也能取（去掉首尾空格）', () => {
  assert.equal(parseArchivePassword('[解压码:  abc 123 ]x.zip').password, 'abc 123');
});

console.log('## parseArchivePassword：无括号 / 日文句子');
check('解压密码：xxx', () => {
  assert.equal(parseArchivePassword('解压密码：mima 说明.zip').password, 'mima');
});
check('パスワードは xxx です', () => {
  assert.equal(parseArchivePassword('パスワードは himitsu です.zip').password, 'himitsu');
});
check('パスワードは xxx でした', () => {
  assert.equal(parseArchivePassword('パスワードは oldpass でした.zip').password, 'oldpass');
});

console.log('## parseArchivePassword：不猜（宁可空）');
check('没有密码信息返回空串', () => {
  assert.equal(parseArchivePassword(REAL_NAMES.tagsOnly), '');
});
check('[解压码: None] 视为没有密码（真实名）', () => {
  assert.equal(parseArchivePassword(REAL_NAMES.mixture), '');
});
check('パスワード: なし / 无 / 空 都算没有密码', () => {
  for (const placeholder of ['なし', '无', '無し', '空', 'n/a', 'NONE']) {
    assert.equal(parseArchivePassword(`[パスワード: ${placeholder}] x.zip`), '', placeholder);
  }
});
check('只有「页码: 3」这种不带密码键名的冒号不误判', () => {
  assert.equal(parseArchivePassword('页码: 3 的说明书.zip'), '');
});
check('空 / null / undefined / 数字输入返回空串不抛', () => {
  for (const value of ['', '   ', null, undefined, 0, 12345]) {
    assert.equal(parseArchivePassword(value), '', String(value));
  }
});
check('多处占位后仍有真密码时取真密码', () => {
  assert.equal(parseArchivePassword('[解压码: None] [解压码: real123] x.zip').password, 'real123');
});
check('多个密码括号时取第一个', () => {
  assert.equal(parseArchivePassword('[解压码: first] [解压码: second] x.zip').password, 'first');
});
check('超长输入里后半段的密码不解析（截断到 200）', () => {
  const text = `${'あ'.repeat(250)} [解压码: hidden]`;
  assert.equal(parseArchivePassword(text), '');
});
check('CRLF 换行不影响解析', () => {
  assert.equal(parseArchivePassword('标题\r\n[解压码: crlfpass] x.zip').password, 'crlfpass');
});
check('返回值形状：命中带 password/matched，未命中是空串', () => {
  const hit = parseArchivePassword('[解压码: shaped] x.zip');
  assert.equal(typeof hit, 'object');
  assert.deepEqual(Object.keys(hit).sort(), ['matched', 'password']);
  assert.equal(typeof parseArchivePassword('x.zip'), 'string');
});

console.log('## parseRjCode');
check('RJ0123456 原样返回', () => {
  assert.equal(parseRjCode('RJ0123456.zip'), 'RJ0123456');
});
check('小写 rj0123456 → 大写', () => {
  assert.equal(parseRjCode('rj0123456.zip'), 'RJ0123456');
});
check('带分隔符 RJ-0123456 / RJ 0123456 / RJ_0123456', () => {
  assert.equal(parseRjCode('RJ-0123456'), 'RJ0123456');
  assert.equal(parseRjCode('RJ 0123456'), 'RJ0123456');
  assert.equal(parseRjCode('RJ_0123456'), 'RJ0123456');
});
check('真实混合名里能抽到', () => {
  assert.equal(parseRjCode(REAL_NAMES.mixture), 'RJ0123456');
});
check('没有 RJ 号返回空串', () => {
  assert.equal(parseRjCode(REAL_NAMES.tagsOnly), '');
  assert.equal(parseRjCode(''), '');
});
check('太短的编号不算（RJ123 不是作品号）', () => {
  assert.equal(parseRjCode('RJ123.zip'), '');
});
check('全角字母数字也能认', () => {
  assert.equal(parseRjCode('ＲＪ０１２３４５６.zip'), 'RJ0123456');
});

console.log('## parseBoothSellerItemIds');
check('https://booth.pm/ja/items/9038753', () => {
  assert.deepEqual(parseBoothSellerItemIds('see https://booth.pm/ja/items/9038753'), ['9038753']);
});
check('店铺子域名 shop.booth.pm/items/123', () => {
  assert.deepEqual(parseBoothSellerItemIds('shop.booth.pm/items/123'), ['123']);
});
check('无路径前缀的 booth.pm/items/456 也认', () => {
  assert.deepEqual(parseBoothSellerItemIds('booth.pm/items/456'), ['456']);
});
check('多个链接去重保序', () => {
  assert.deepEqual(
    parseBoothSellerItemIds('booth.pm/items/2 与 https://booth.pm/ja/items/1 与 booth.pm/items/2'),
    ['2', '1']
  );
});
check('不是 BOOTH 链接返回空数组', () => {
  assert.deepEqual(parseBoothSellerItemIds('http://example.com/items/123'), []);
  assert.deepEqual(parseBoothSellerItemIds(''), []);
});

console.log('## parseNameTags');
check('真实混合名：抽 SOPW / RPG生肉', () => {
  assert.deepEqual(parseNameTags(REAL_NAMES.mixture), ['SOPW', 'RPG生肉']);
});
check('[解压密码: acg18] [RPG][RJ] → 只留 RPG', () => {
  assert.deepEqual(parseNameTags(REAL_NAMES.gameWithPw), ['RPG']);
});
check('[SOPW] [RPG生肉] パラダイス・サキュバス', () => {
  assert.deepEqual(parseNameTags(REAL_NAMES.tagsOnly), ['SOPW', 'RPG生肉']);
});
check('ShiroTensi 【19アバター対応】 → 保留模型数标签', () => {
  assert.deepEqual(parseNameTags(REAL_NAMES.avatar), ['19アバター対応']);
});
check('【PB】【VRChat向け】MH_Witch【7アバター対応】', () => {
  assert.deepEqual(
    parseNameTags('【PB】【VRChat向け】MH_Witch【7アバター対応】.zip'),
    ['PB', 'VRChat向け', '7アバター対応']
  );
});
check('去重（大小写不敏感，保留首次写法）', () => {
  assert.deepEqual(parseNameTags('[SOPW][sopw][RPG]'), ['SOPW', 'RPG']);
});
check('纯数字 / 裸 RJ / 带冒号的解压码标签都丢掉', () => {
  assert.deepEqual(parseNameTags('[123][RJ][解压码: x][aw]'), ['aw']);
});
check('标签数量上限 8', () => {
  const tags = parseNameTags('[a][b][c][d][e][f][g][h][i][j]');
  assert.equal(tags.length, 8);
  assert.deepEqual(tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
});
check('超过 12 个字符的方括号内容不算标签', () => {
  assert.deepEqual(parseNameTags(`[${'あ'.repeat(13)}][短い]`), ['短い']);
  assert.deepEqual(parseNameTags(`[${'あ'.repeat(12)}]`), ['あ'.repeat(12)]);
});
check('空输入 / 无括号返回空数组', () => {
  assert.deepEqual(parseNameTags(''), []);
  assert.deepEqual(parseNameTags('普通の名前.zip'), []);
});

console.log('## describeAssetTags');
check('三处文本合并：password / rj / tags', () => {
  const info = describeAssetTags({
    title: 'パラダイス・サキュバス',
    dir: '【SOPW】【RPG生肉】',
    mainName: '[解压码: acg18] RJ0123456.zip'
  });
  assert.deepEqual(info, {
    archivePassword: 'acg18',
    rjCode: 'RJ0123456',
    tags: ['SOPW', 'RPG生肉'],
    sellerItemIds: []
  });
});
check('title 优先：title 里的密码先命中', () => {
  const info = describeAssetTags({ title: '[解压码: fromTitle]', mainName: '[解压码: fromMain]' });
  assert.equal(info.archivePassword, 'fromTitle');
});
check('title 里没有时才用 mainName / dir（顺序 title→mainName→dir）', () => {
  const info = describeAssetTags({ dir: '[解压码: fromDir]', mainName: 'x.zip' });
  assert.equal(info.archivePassword, 'fromDir');
});
check('标签跨字段合并去重，title 的排在前面', () => {
  const info = describeAssetTags({ title: '【SOPW】', mainName: '[RPG][SOPW].zip', dir: '【VRChat向け】' });
  assert.deepEqual(info.tags, ['SOPW', 'RPG', 'VRChat向け']);
});
check('BOOTH 链接跨字段合并去重', () => {
  const info = describeAssetTags({
    title: 'https://booth.pm/ja/items/9038753',
    dir: 'booth.pm/items/9038753',
    mainName: 'booth.pm/items/123'
  });
  assert.deepEqual(info.sellerItemIds, ['9038753', '123']);
});
check('真实名整套解析（None 不给假密码）', () => {
  const info = describeAssetTags({ mainName: REAL_NAMES.mixture });
  assert.equal(info.archivePassword, '');
  assert.equal(info.rjCode, 'RJ0123456');
  assert.deepEqual(info.tags, ['SOPW', 'RPG生肉']);
});
check('空对象 / 全空字段返回四个空值', () => {
  assert.deepEqual(describeAssetTags({}), { archivePassword: '', rjCode: '', tags: [], sellerItemIds: [] });
  assert.deepEqual(describeAssetTags(), { archivePassword: '', rjCode: '', tags: [], sellerItemIds: [] });
});
check('null 字段不抛', () => {
  const info = describeAssetTags({ title: null, dir: undefined, mainName: 123 });
  assert.deepEqual(info, { archivePassword: '', rjCode: '', tags: [], sellerItemIds: [] });
});
check('超长名字截断到 200 字符后再解析', () => {
  const info = describeAssetTags({ mainName: `${'a'.repeat(250)}[解压码: nope]` });
  assert.equal(info.archivePassword, '');
  assert.deepEqual(info.tags, []);
});
check('返回字段形状固定（前端可直接展开）', () => {
  const info = describeAssetTags({ title: 'x' });
  assert.deepEqual(Object.keys(info).sort(), ['archivePassword', 'rjCode', 'sellerItemIds', 'tags']);
  assert.equal(typeof info.archivePassword, 'string');
  assert.equal(typeof info.rjCode, 'string');
  assert.ok(Array.isArray(info.tags) && Array.isArray(info.sellerItemIds));
});

console.log('## 纯函数护栏');
check('模块源码不引 fs / net / fetch（纯规则，可安全 import）', () => {
  const source = readFileSync(new URL('../src/library-tagging.js', import.meta.url), 'utf8');
  assert.equal(/from\s+['"]node:(fs|net|http|https|child_process)/.test(source), false);
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/require\s*\(/.test(source), false);
});
check('模块不含手写随机/时间依赖（同一输入永远同一输出）', () => {
  const source = readFileSync(new URL('../src/library-tagging.js', import.meta.url), 'utf8');
  assert.equal(/Math\.random|Date\.now/.test(source), false);
  assert.equal(describeAssetTags({ mainName: REAL_NAMES.mixture }).rjCode, parseRjCode(REAL_NAMES.mixture));
});

if (failures.length) {
  console.log(`\n❌ test-library-tagging：${failures.length} 条失败`);
  for (const name of failures) console.log(`   - ${name}`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ test-library-tagging：${pass}/${pass} ok`);
}
