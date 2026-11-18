#!/usr/bin/env node
// 拉取/更新梗百科词库：github.com/thawline/dsh-memewiki 的 data/memes.db（MIT）。
// 用法：node scripts/fetch-memewiki.mjs [--url <raw-url>] [--out data/memewiki.db]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_URL = 'https://raw.githubusercontent.com/thawline/dsh-memewiki/main/data/memes.db';
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const url = argOf('--url', DEFAULT_URL);
const out = path.resolve(argOf('--out', path.join('data', 'memewiki.db')));

const res = await fetch(url, { redirect: 'follow' });
if (!res.ok) {
  console.error(`下载失败：HTTP ${res.status} ${res.statusText} ← ${url}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
if (buf.slice(0, 16).toString('latin1') !== 'SQLite format 3\u0000') {
  console.error('下载内容不是 SQLite 文件（可能被代理/登录页拦截）');
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
const tmp = out + '.tmp';
fs.writeFileSync(tmp, buf);
fs.renameSync(tmp, out);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
console.log(`已更新 ${out}`);
console.log(`  字节：${buf.length}  sha256：${sha}`);
console.log('  重启桥接后生效（词库只读打开，MCP 工具在 DSH 侧需重启 DSH 才会换新进程）');
