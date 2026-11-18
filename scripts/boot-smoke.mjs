#!/usr/bin/env node
// boot-smoke.mjs —— 「装配阶段」沙箱启动冒烟：不开 QQ、不连网关，只把 main() 的装配真跑一遍。
//
// 为什么要有：真机 `node src/bridge.js` 启动失败过好几次，而 regression / node --check 全绿——
// 因为回归套件走 harness 注入，从不真正执行装配（缺一个符号注入就 ReferenceError，套件照样全过）。
// 这个脚本把 src/ 拷到临时目录，config 里的 SnowLuma/DSH 地址换成本机没人监听的死端口，
// consolePort 换成 3199，allow 列表清空，然后真的 `node src/bridge.js` 跑一遍：
//   · 装配（各 boot 阶段、符号解析、TDZ、同步初始化）全部走真实代码
//   · 连不上网关 → 后面只是重连，不会发任何 QQ 消息
//   · 退出前自动清理临时目录
//
// 用法：
//   node scripts/boot-smoke.mjs                 # 默认 20 秒
//   node scripts/boot-smoke.mjs --seconds 30
//   node scripts/boot-smoke.mjs --keep          # 保留沙箱目录便于看日志
//   node scripts/boot-smoke.mjs --config config.test.json
// 判据：出现「桥接模式已确定 / 控制台 / DSH 已就绪 / 已向管理员」= 装配跑通；
//       出现「启动失败 / ReferenceError / is not defined / Cannot access … before initialization」= 失败。
// 退出码：0 通过 / 1 装配崩溃 / 2 环境问题。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flagVal = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const hasFlag = (name) => argv.includes('--' + name);
const seconds = Number(flagVal('seconds') || 20);
const keep = hasFlag('keep');
const asJson = hasFlag('json');

const say = (line) => { if (!asJson) console.log(line); };
const die = (msg, code = 2) => { if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2)); else console.error(msg); process.exit(code); };

const configPath = path.resolve(ROOT, flagVal('config')
  || process.env.QQ_BRIDGE_TEST_CONFIG
  || (fs.existsSync(path.join(ROOT, 'config.json')) ? 'config.json' : 'config.test.json'));
if (!fs.existsSync(configPath)) die(`找不到配置：${configPath}\n  先 cp config.template.json config.json 并填好，或用 --config 指定。`);
if (!fs.existsSync(path.join(ROOT, 'src/bridge.js'))) die(`找不到 ${ROOT}/src/bridge.js（脚本要放在仓库的 scripts/ 下）`);
const modules = path.join(ROOT, 'node_modules');
if (!fs.existsSync(modules)) die(`找不到 ${modules}\n  先 npm install（交付包里没有 node_modules）。`);

const tmp = path.join(os.tmpdir(), 'qq-boot-smoke');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

// 1) 拷真实源码（+ 控制台静态目录，避免 404 噪声）
fs.cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));
if (fs.existsSync(path.join(ROOT, 'public'))) fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
if (fs.existsSync(path.join(ROOT, 'roles'))) fs.cpSync(path.join(ROOT, 'roles'), path.join(tmp, 'roles'), { recursive: true });

// 2) 造一份「指向死端口」的配置
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
cfg.snowluma = { ...(cfg.snowluma || {}), wsUrl: 'ws://127.0.0.1:39999', httpUrl: 'http://127.0.0.1:39998', followDiscoveredEndpoint: false };
cfg.dsh = { ...(cfg.dsh || {}), baseUrl: 'http://127.0.0.1:39996', allowRemote: false };
cfg.consolePort = 3199;
cfg.consoleToken = 'boot-smoke-token';
cfg.ownerQQ = '';
cfg.allow = { ...(cfg.allow || {}), private: [], groups: [] };
cfg.allowAllWhenEmpty = false;
if (cfg.sessionCwd) cfg.sessionCwd = path.join(tmp, 'session-cwd');
if (cfg.fileArchive && cfg.fileArchive.dir) cfg.fileArchive.dir = path.join(tmp, 'state', 'archive');
if (cfg.socialV2?.stt?.enabled) cfg.socialV2.stt.enabled = false;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });

// 3) node_modules 用 junction/symlink（只读共享，绝不复制）
try { fs.symlinkSync(modules, path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); }
catch (error) { die(`node_modules 链接建不起来：${error.message}`); }

// 4) 真跑
const logFile = path.join(tmp, 'smoke.log');
const fd = fs.openSync(logFile, 'w');
const child = spawn(process.execPath, ['src/bridge.js'], { cwd: tmp, stdio: ['ignore', fd, fd], env: { ...process.env, QQ_BRIDGE_BOOT_SMOKE: '1' } });
const started = Date.now();
const finishedBy = await new Promise((resolve) => {
  let done = false;
  const finish = (why) => { if (!done) { done = true; resolve(why); } };
  const timer = setTimeout(() => finish('timeout'), seconds * 1000);
  child.on('exit', (code) => { clearTimeout(timer); finish(`exit:${code}`); });
  child.on('error', (error) => { clearTimeout(timer); finish(`error:${error.message}`); });
});
try { child.kill('SIGKILL'); } catch {}
try { fs.closeSync(fd); } catch {}

const text = fs.readFileSync(logFile, 'utf8');
const lines = text.split(/\r?\n/).filter(Boolean);
const booted = /桥接模式已确定|控制台已启动|控制台监听|DSH 已就绪|已向管理员/.test(text);
const crashed = /启动失败|ReferenceError|is not defined|Cannot access .* before initialization|SyntaxError/.test(text);
const errLines = lines.filter((l) => /启动失败|ReferenceError|is not defined|Cannot access .* before initialization|SyntaxError|at boot[A-Z]/.test(l)).slice(0, 12);
const verdict = crashed ? 'CRASH' : booted ? 'OK' : 'UNKNOWN';
const report = { ok: verdict === 'OK', verdict, config: configPath, sandbox: tmp, finishedBy, elapsedMs: Date.now() - started, errLines, tail: lines.slice(-12) };

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  say(`\n=== boot smoke: ${verdict} ===`);
  say(`配置  : ${configPath}`);
  say(`沙箱  : ${tmp}（${finishedBy}，${(report.elapsedMs / 1000).toFixed(1)}s）`);
  if (errLines.length) { say('--- 错误行 ---'); for (const l of errLines) say('  ' + l); }
  say('--- 末尾 12 行 ---'); for (const l of lines.slice(-12)) say('  ' + l);
  if (verdict === 'OK') say('\n✅ 装配跑通：可以 node src/bridge.js 起正式服务了。');
  if (verdict === 'CRASH') say('\n❌ 装配就崩了：先把上面错误行修掉，别急着重启正式服务。');
  if (verdict === 'UNKNOWN') say('\n⚠️ 没抓到成功标记也没抓到崩溃：多半是卡在更早的位置，看末尾日志。');
}
if (!keep) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
process.exit(report.ok ? 0 : 1);
