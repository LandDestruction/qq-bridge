#!/usr/bin/env node
// 把 client/*.js 拼成 public/client.js（D4：前端按页拆文件）。
//
// 为什么用「拼回去」而不是多个 <script>：整份代码在一个 IIFE 作用域里，几百个函数
// 和状态变量互相引用（WRITE_ACTIONS / sessState / usageState …）。拆成多个 <script>
// 等于把同一个作用域劈开，跨文件调用全靠全局对象，很容易踩到加载顺序和重名。
// 拼成单文件对外行为完全不变，改动只看对应那一段，规模闸也按段来卡。
//
// 用法：
//   node scripts/build-client.mjs           # 生成 public/client.js
//   node scripts/build-client.mjs --check   # 只校验产物是否与片段一致（CI/门禁用）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'client');
const OUT = path.join(ROOT, 'public', 'client.js');

const HEADER = [
  '/* 这个文件由 scripts/build-client.mjs 从 client/*.js 拼出来，别直接改它。',
  ' * 要改哪一页就改 client/0X-*.js，然后跑 npm run build:client。 */',
  '',
].join('\n');

const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
if (!files.length) {
  console.error('client/ 里没有片段');
  process.exit(2);
}

const parts = files.map((name) => {
  const body = fs.readFileSync(path.join(SRC_DIR, name), 'utf8');
  return { name, body };
});

const merged = HEADER + parts.map((p) => p.body).join('');
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

if (process.argv.includes('--check')) {
  if (current === merged) {
    console.log('public/client.js 与 client/*.js 一致（' + parts.length + ' 段）');
    process.exit(0);
  }
  console.error('public/client.js 和 client/*.js 不一致：先跑 node scripts/build-client.mjs');
  process.exit(1);
}

fs.writeFileSync(OUT, merged, 'utf8');
console.log('已生成 public/client.js ← ' + parts.map((p) => p.name).join(' + '));
console.log('行数：' + merged.split('\n').length);
