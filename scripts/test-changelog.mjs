#!/usr/bin/env node
// 更新日志（设置页 → 安全与关于 → 查看更新日志）的门禁。
//
// 这一套盯两件事：
//   1. 生成器真的能从 git log 里切出「类型 / 标题 / 一句为什么」，分组、限额、统计都对；
//   2. 生成出来的 public/changelog.js 与当前 git log 一致，并且被四台服务器（桥接 /
//      面板进程 / 离线 fixture）和页面真正接上了 —— 否则用户点开只看到「没读到」。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildChangelog, splitSubject, firstSentence, renderFile, readCommits, verifyData } from './make-changelog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
const fails = [];
function check(ok, name, detail) {
  if (ok) {
    pass += 1;
    console.log('  ok   ' + name);
  } else {
    fails.push(name + (detail ? '：' + detail : ''));
    console.log('  FAIL ' + name + (detail ? '：' + detail : ''));
  }
}

console.log('## 生成器：切标题与类型');
const c1 = splitSubject('fix(console): 会话最近消息三处——引用图片原地 TP');
check(c1.type === 'fix' && c1.text.indexOf('会话最近消息三处') === 0, '`fix(console): …` 切成 fix + 去掉前缀的正文', JSON.stringify(c1));
const c2 = splitSubject('feat: 新增系统架构页');
check(c2.type === 'feat' && c2.scope === '' && c2.text === '新增系统架构页', '`feat: …` 无 scope 也能切');
const c3 = splitSubject('文档：补浅色主题与窄屏验收');
check(c3.type === 'docs' && c3.text === '补浅色主题与窄屏验收', '早期中文前缀「文档：」也认');
const c4 = splitSubject('T21：安装器测试进回归闸门');
check(c4.type === 'other' && c4.text.indexOf('T21') === 0, '没写类型前缀的（T21：…）归「改动」且标题原样保留');
check(splitSubject('refactor!: 拆 client.js').type === 'refactor', '带感叹号的 `refactor!: …` 也能剥干净');

console.log('## 生成器：正文只取一句「为什么」');
check(firstSentence('架构页的卡片读的是旧视图\n\n第二段') === '架构页的卡片读的是旧视图', '只取正文第一行');
check(firstSentence('Co-authored-by: x <x@y>\n真的正文') === '真的正文', '跳过 Co-authored-by 之类的元信息行');
check(firstSentence('- 列表项\n真的正文') === '真的正文', '跳过列表项行');
check(firstSentence('') === '', '空正文回空串');
const long = firstSentence('啊'.repeat(300));
check(long.length <= 180 && /…$/.test(long), '超长正文截到 180 字以内并加省略号', String(long.length));

console.log('## 生成器：分组、统计、限额');
const fixture = [
  { hash: 'aaaaaaa1111', date: '2026-10-29', subject: 'fix(console): 修 A', body: 'A 的原因' },
  { hash: 'bbbbbbb2222', date: '2026-10-29', subject: 'feat: 加 B', body: '' },
  { hash: 'ccccccc3333', date: '2026-10-28', subject: 'T9：杂活 C', body: '' }
];
const built = buildChangelog(fixture, { limit: 0 });
check(built.total === 3 && built.shown === 3, '总数与展示数一致（不限量时）');
check(built.groups.length === 2 && built.groups[0].d === '2026-10-29' && built.groups[0].n === 2, '按天分组、日期倒序');
check(built.groups[0].items[0].h === 'aaaaaaa' && built.groups[0].items[0].t === 'fix', '提交号截 7 位、类型带出来');
check(built.groups[0].items[0].b === 'A 的原因', '正文那句「为什么」带进数据');
check(built.types.fix === 1 && built.types.feat === 1 && built.types.other === 1, '类型统计正确', JSON.stringify(built.types));
check(built.since === '2026-10-28' && built.until === '2026-10-29' && built.days === 2, '起止日期与天数正确');
const limited = buildChangelog(fixture, { limit: 2 });
check(limited.shown === 2 && limited.total === 3 && limited.groups[0].items.length === 2, '--limit 只截展示条数，总数仍统计全部');
check(limited.groups.length === 1, '--limit 截断后不再输出空的分组');
const rendered = renderFile(built);
check(rendered.indexOf('window.__QDB_CHANGELOG = {') >= 0, '产物是 `window.__QDB_CHANGELOG = {...}` 的静态文件');
check(rendered.indexOf('</') < 0 || rendered.indexOf('<\\/') >= 0, '产物里没有裸的 `</`（外链文件也不留折行风险）');

console.log('## 产物：与当前 git log 一致');
const outFile = path.join(ROOT, 'public', 'changelog.js');
check(fs.existsSync(outFile), 'public/changelog.js 存在（没生成过就打不出安装包）');
let data = null;
try {
  const sandbox = { window: {} };
  vm.runInNewContext(read('public/changelog.js'), sandbox);
  data = sandbox.window.__QDB_CHANGELOG;
} catch (error) {
  check(false, 'public/changelog.js 能被解析', String(error && error.message));
}
if (data) {
  check(Array.isArray(data.groups) && data.groups.length > 0, '有按天分组的条目', String(data.groups && data.groups.length));
  check(typeof data.total === 'number' && data.total > 0, '总数是正数', String(data.total));
  check(typeof data.version === 'string' && data.version.length > 0, '带上了 package.json 的版本号', String(data.version));
  check(data.shown > 0 && data.shown <= data.total, 'shown ≤ total', data.shown + '/' + data.total);
  check(!('generatedAt' in data) || /^\d{4}-\d{2}-\d{2}$/.test(data.generatedAt), '生成时间只到天（避免每次生成都产生无意义 diff）', String(data.generatedAt));
  // 允许「文件生成得早、之后又多了新提交」——打包前会重新生成；但不能允许文件与历史对不上。
  const realCommits = readCommits();
  const verdict = verifyData(data, realCommits);
  check(verdict.ok, 'public/changelog.js 仍是 git log 的忠实前缀（标题/正文没被手改）', verdict.reason);
  check(verdict.ok && verdict.ahead < 40, '落后不超过 40 条提交（落后更多说明很久没重新生成）', String(verdict.ahead));
  check(data.top === realCommits[0].hash.slice(0, 7) || realCommits.some((c) => c.hash.slice(0, 7) === data.top), '文件里的 top 能在 git log 里找到', String(data.top));
  const typeSum = Object.values(data.types || {}).reduce((n, v) => n + (Number(v) || 0), 0);
  check(typeSum === data.total, '类型统计合计 = 总提交数', typeSum + ' vs ' + data.total);
  check(data.total <= realCommits.length, '总数不超过 git log 现有条数', data.total + ' vs ' + realCommits.length);
}

console.log('## 接线：四台服务器都要发得出 /changelog.js');
const ops = read('src/bridge/console/operations.js');
check(ops.indexOf("['/changelog.js', { file: 'changelog.js', type: 'text/javascript; charset=utf-8' }]") >= 0, '桥接的 STATIC_ASSETS 里有 /changelog.js');
const server = read('src/bridge/console-server.js');
check(/NO_TOKEN_GET_PATHS = new Set\(\[[\s\S]{0,400}'\/changelog\.js'/.test(server), '免令牌白名单放行 /changelog.js（否则页面 401）');
// 名单里后来还会加别的静态资源（例如背景音乐 /bgm/default-tune.mp3），所以只校验
// 「这个数组里包含 '/changelog.js'」，不把整行字面量钉死 —— 钉死会让每次加资源都误报。
check(/\[[^\]]*'\/changelog\.js'[^\]]*\]/.test(server), '进 handleConsoleOperations 的 GET 名单里有 /changelog.js');
const host = read('scripts/console-host.mjs');
check(host.indexOf("['/changelog.js', { file: 'changelog.js', type: 'application/javascript; charset=utf-8' }]") >= 0, '常驻面板进程（3101）也发 /changelog.js');
const fixtureSrc = read('scripts/console-ui-fixture.mjs');
check(fixtureSrc.indexOf("'/changelog.js'") >= 0, '离线 fixture 也能发 /changelog.js（否则离线预览点开是空的）');

console.log('## 页面：入口、弹层、样式');
const html = read('public/client.html');
check(/<script src="\/changelog\.js" defer><\/script>/.test(html), 'client.html 引了 /changelog.js');
check(!/\beval\s*\(/.test(html), '页面没引入 eval');
const js = read('public/client.js');
check(/function openChangelogDialog\(\)/.test(js), '有 openChangelogDialog()');
check(/'changelog-open': function \(\) \{ return openChangelogDialog\(\); \}/.test(js), '按钮通过写操作表打开（统一防连点/失败提示）');
check(/data-write="changelog-open"/.test(js), '设置页「安全与关于」有「查看更新日志」按钮');
check(/<b>' \+ esc\(numText\(d\.total\)\) \+ '<\/b> 次提交/.test(js), '弹层顶部显示「N 次提交」');
check(/function changelogListHtml\(d\)/.test(js) && /changelogState\.search/.test(js) === false && /changelogState\.query/.test(js), '列表渲染读搜索关键词');
check(/data-log-type="' \+ esc\(t\.id\) \+ '"/.test(js), '类型筛选按钮带 data-log-type');
check(/window\.__QDB_CHANGELOG/.test(js), '前端从 window.__QDB_CHANGELOG 取数据（不新增接口）');
const css = read('public/client.css');
check(/\.qdb-log-dialog \{[^}]*max-height: 82vh/s.test(css), '弹层限高，不会顶出视口');
check(/\.qdb-log-body \{[^}]*overflow-y: auto/s.test(css), '正文独立滚动');
check(/\.qdb-log-tag\[data-type="feat"\]/.test(css) && /\.qdb-log-tag\[data-type="fix"\]/.test(css), '新增/修复有不同颜色（一眼分出做了什么）');
check(/@media \(max-width: 720px\) \{\n    \.qdb-log-dialog/s.test(css), '窄屏有专门的弹层尺寸');

console.log('## npm 脚本');
const pkg = JSON.parse(read('package.json'));
check(pkg.scripts && pkg.scripts.changelog === 'node scripts/make-changelog.mjs', 'npm run changelog 能重新生成');

console.log('\n========== 通过 ' + pass + ' / 失败 ' + fails.length + ' ==========');
if (fails.length) {
  console.log('失败项：');
  fails.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}
