#!/usr/bin/env node
// 生成更新源清单 latest.json（D2：本地目录更新源）。
//
// 用法：
//   node scripts/make-update-manifest.mjs --exe dist/installer/QQDeepSeekBot-Setup-0.1.1.exe \
//        --version 0.1.1 --base http://127.0.0.1:7899 --out E:/qq-updates/latest.json
//
// 产出字段与 desktop/UpdateVersion.cs 的 TryParse 完全对应：{version, url, sha256, notes?}。
// url 必须是 http(s)——壳里的 FetchUpdate 只接受这两种协议（file:// 会被拒绝）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const out = path.resolve(arg('out', path.join(process.cwd(), 'latest.json')));
const exe = arg('exe');
const version = arg('version');
const base = arg('base', '');
let url = arg('url', '');
const notes = arg('notes', '');

if (!exe || !version) {
  console.error('用法：node scripts/make-update-manifest.mjs --exe <安装包.exe> --version <x.y.z> [--base http://127.0.0.1:7899] [--url <完整下载地址>] [--out latest.json] [--notes 说明]');
  process.exit(2);
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(version)) {
  console.error('版本号得像 0.1.1 这样（desktop/UpdateVersion.cs 只认数字段）：' + version);
  process.exit(2);
}
if (!url) {
  if (!base) {
    console.error('要么给 --url（安装包完整下载地址），要么给 --base（更新源根地址，脚本会把文件名接上去）');
    process.exit(2);
  }
  url = base.replace(/\/+$/, '') + '/' + encodeURIComponent(path.basename(exe));
}
if (!/^https?:\/\//i.test(url)) {
  console.error('下载地址必须是 http(s)：壳里的 FetchUpdate 不接受 file:// —— 本地目录更新源请用 scripts/update-server.mjs 起一个本地 HTTP 服务');
  process.exit(2);
}

const bytes = fs.readFileSync(path.resolve(exe));
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

const manifest = { version, url, sha256 };
if (notes) manifest.notes = notes;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('已写入 ' + out);
console.log(JSON.stringify(manifest, null, 2));
console.log('安装包大小：' + (bytes.length / 1024 / 1024).toFixed(2) + ' MB');
