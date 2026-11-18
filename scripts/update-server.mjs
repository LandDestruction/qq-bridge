#!/usr/bin/env node
// 本地更新源（D2）：把目录里的安装包 + latest.json 用 HTTP 伺服出来。
//
// 为什么必须走 HTTP：desktop/UpdateVersion.cs 的 TryParse 只接受 http(s) 下载地址，
// 壳里的 FetchUpdate 用 HttpWebRequest（不会读 file://）。所以「本地目录更新源」
// = 一个指向该目录的小静态服务，壳那边配 http://127.0.0.1:7899/latest.json。
//
// 用法：
//   node scripts/update-server.mjs --dir E:/qq-updates --port 7899
//   node scripts/update-server.mjs --dir E:/qq-updates --port 7899 --host 0.0.0.0  # 局域网给别的机器用

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};

// 只读、只服务这个目录下的文件；用 path.resolve + 前缀判断把 .. 挡掉，
// 别让它变成一个能读全盘的服务器。
export function createUpdateServer({ dir, port = 7899, host = '127.0.0.1' }) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('更新目录不存在：' + root);
  }
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? '/latest.json' : urlPath;
    const full = path.resolve(root, '.' + rel);
    if (full !== root && !full.startsWith(root + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 只服务更新目录里的文件\n');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('405 只支持 GET/HEAD\n');
      return;
    }
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 没有这个文件\n');
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 不是文件\n');
      return;
    }
    const type = TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(stat.size),
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res);
  });
  return {
    server,
    root,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address()));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const dir = path.resolve(arg('dir', path.join(process.cwd(), 'dist', 'updates')));
  const port = Number(arg('port', '7899'));
  const host = arg('host', '127.0.0.1');
  let app;
  try {
    app = createUpdateServer({ dir, port, host });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  try {
    await app.listen();
  } catch (err) {
    console.error('启动失败：' + err.message);
    process.exit(1);
  }
  console.log('更新源已启动：http://' + host + ':' + port + '/latest.json');
  console.log('目录：' + app.root);
  console.log('把 config.json 的 desktop.updateUrl 指向上面这个地址即可；Ctrl+C 停止。');
}
