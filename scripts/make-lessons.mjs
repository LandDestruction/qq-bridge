// 把 client/07b-lessons.js 里的教训数据导出成 docs/LESSONS.md（给后来接手的人看）。
// 数据源只有一个，别手改生成的 md：改 client/07b-lessons.js，再跑这个脚本。
//
// 用法：node scripts/make-lessons.mjs
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'client', '07b-lessons.js');
const OUT = path.join(ROOT, 'docs', 'LESSONS.md');

const code = fs.readFileSync(SRC, 'utf8');
const start = code.indexOf('var DEV_LESSONS =');
if (start < 0) throw new Error('client/07b-lessons.js 里找不到 var DEV_LESSONS');
const end = code.lastIndexOf('];');
if (end < start) throw new Error('DEV_LESSONS 数组没闭合');
const literal = code.slice(start + 'var DEV_LESSONS ='.length, end + 1);
// 这份数据是我们自己写的纯 JSON-ish 字面量，没有函数和模板串，直接求值即可。
const lessons = new Function('return ' + literal)();
if (!Array.isArray(lessons) || !lessons.length) throw new Error('DEV_LESSONS 解析出来不是数组');

const lines = [
  '# 开发教训日志',
  '',
  '> 这份文档由 `scripts/make-lessons.mjs` 从 `client/07b-lessons.js` 生成，**不要手改**（改了下次生成会被覆盖）。',
  '> 控制台里也能看：设置 → 教训。新条目加在 `client/07b-lessons.js`，然后重跑脚本。',
  ''
];
for (const group of lessons) {
  lines.push('## ' + group.title, '');
  for (const item of group.items) lines.push('- ' + item);
  lines.push('');
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(JSON.stringify({ out: path.relative(ROOT, OUT), groups: lessons.length, items: lessons.reduce((n, g) => n + g.items.length, 0) }));
