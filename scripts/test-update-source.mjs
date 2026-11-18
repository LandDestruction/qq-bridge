#!/usr/bin/env node
// D2：本地更新源的三件事一起测——
//   ① scripts/make-update-manifest.mjs 生成的清单形状能被 desktop/UpdateVersion.cs 解析；
//   ② scripts/update-server.mjs 真的能把清单和安装包用 HTTP 服务出来（壳里的 FetchUpdate 只认 http/https）；
//   ③ desktop/Host.cs 的 --check-update 与 config.desktop.updateUrl 的契约没漂。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log('  ok   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra ? '  ← ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qdb-update-'));
const fakeExe = path.join(tmp, 'QQDeepSeekBot-Setup-9.9.9.exe');
fs.writeFileSync(fakeExe, Buffer.alloc(2048, 7));
const manifestPath = path.join(tmp, 'latest.json');

console.log('[1] 清单生成脚本');
const gen = spawnSync(process.execPath, [
  path.join(ROOT, 'scripts/make-update-manifest.mjs'),
  '--exe', fakeExe, '--version', '9.9.9', '--base', 'http://127.0.0.1:7901/', '--out', manifestPath,
  '--notes', '测试清单',
], { encoding: 'utf8' });
ok('生成成功', gen.status === 0, gen.stderr);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
ok('version 写入', manifest.version === '9.9.9');
ok('url 是 base + 文件名（去掉多余斜杠）', manifest.url === 'http://127.0.0.1:7901/QQDeepSeekBot-Setup-9.9.9.exe', manifest.url);
ok('sha256 与文件一致', manifest.sha256 === crypto.createHash('sha256').update(fs.readFileSync(fakeExe)).digest('hex'));
ok('notes 带进来', manifest.notes === '测试清单');

const badVer = spawnSync(process.execPath, [path.join(ROOT, 'scripts/make-update-manifest.mjs'),
  '--exe', fakeExe, '--version', 'v1', '--out', path.join(tmp, 'bad.json')], { encoding: 'utf8' });
ok('版本号不像 x.y.z 就拒绝', badVer.status === 2, String(badVer.status));
const badUrl = spawnSync(process.execPath, [path.join(ROOT, 'scripts/make-update-manifest.mjs'),
  '--exe', fakeExe, '--version', '1.2.3', '--url', 'file:///E:/x.exe', '--out', path.join(tmp, 'bad2.json')], { encoding: 'utf8' });
ok('file:// 下载地址被拒绝（壳只认 http(s)）', badUrl.status === 2, String(badUrl.status));

console.log('[2] 本地更新源服务');
const { createUpdateServer } = await import(new URL('../scripts/update-server.mjs', import.meta.url).href);
const app = createUpdateServer({ dir: tmp, port: 0 });
const addr = await app.listen();
const port = addr.port;
ok('服务起了', port > 0, String(port));
try {
  const manifestResp = await fetch('http://127.0.0.1:' + port + '/latest.json');
  const body = await manifestResp.text();
  ok('GET /latest.json 200', manifestResp.status === 200, String(manifestResp.status));
  ok('返回内容就是清单', JSON.parse(body).version === '9.9.9');
  const exeResp = await fetch('http://127.0.0.1:' + port + '/QQDeepSeekBot-Setup-9.9.9.exe');
  const bytes = Buffer.from(await exeResp.arrayBuffer());
  ok('安装包按原字节返回', bytes.length === 2048 && bytes[0] === 7, String(bytes.length));
  // 用编码过的 ../（裸 ../ 会被客户端先规范化成 /latest.json，测不到服务端的判断）
  const escaped = await fetch('http://127.0.0.1:' + port + '/%2e%2e%2fsecret.txt');
  ok('目录外路径被拒', escaped.status === 403, String(escaped.status));
  const missing = await fetch('http://127.0.0.1:' + port + '/nope.json');
  ok('缺文件 404', missing.status === 404, String(missing.status));
} finally {
  await app.close();
}

console.log('[3] 壳与配置的契约');
const host = read('desktop/Host.cs');
ok('支持 --check-update 参数', /else if \(a == "--check-update"\) \{ o\.CheckUpdate = true; \}/.test(host));
ok('Main 里在开窗之前就处理', /if \(opt\.CheckUpdate\) \{ Environment\.Exit\(HostForm\.RunUpdateCheck\(opt\)\); return; \}/.test(host));
ok('复用了托盘的 FetchUpdate / UpdateVersion.Compare', /try \{ info = FetchUpdate\(url\); \}/.test(host)
  && /int\? cmp = UpdateVersion\.Compare\(info\.Version, current\)/.test(host)
  && /BridgeLog\.Write\(paths\.UpdateLogPath, "update-check: remote=/.test(host));
ok('退出码约定 0/1/2 写在注释里', /0 = 已是最新，1 = 有更新，2 = 读不到更新源/.test(host));
ok('未配置 updateUrl 时记日志并返回 2', /未配置 desktop\.updateUrl（更新检查关闭）/.test(host));
const version = read('desktop/UpdateVersion.cs');
ok('清单只认 http(s)', /url\.StartsWith\("https:\/\/"/.test(version) && /url\.StartsWith\("http:\/\/"/.test(version));
const mgr = read('scripts/make-update-manifest.mjs');
ok('清单脚本产出的字段与 TryParse 对齐', /const manifest = \{ version, url, sha256 \};/.test(mgr));
const srv = read('scripts/update-server.mjs');
ok('服务脚本明确解释了为什么必须 HTTP', /只接受 http\(s\)/.test(srv));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exitCode = fail === 0 ? 0 : 1;
