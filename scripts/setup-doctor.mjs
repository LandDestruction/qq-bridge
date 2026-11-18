#!/usr/bin/env node
// 环境自检 / setup doctor：干净机器上解压后先跑这个，逐项告诉你能不能跑、缺什么、怎么补。
// 用法：node scripts/setup-doctor.mjs [--json]
// 退出码：0=可以启动（可能有警告）；1=有阻断项
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const JSON_OUT = process.argv.includes('--json');
const checks = [];
function add(level, name, detail, fix = '') {
  checks.push({ level, name, detail, fix });
}

// 1) Node 版本
const needMajor = 22, needMinor = 13;
const [maj, min] = process.versions.node.split('.').map(Number);
const nodeOk = maj > needMajor || (maj === needMajor && min >= needMinor);
add(nodeOk ? 'ok' : 'block', 'Node.js 版本', `v${process.versions.node}（需要 >=22.13）`, nodeOk ? '' : '安装 Node.js 22 LTS 或更新版本：https://nodejs.org/');

// 2) 依赖
let depsOk = true;
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies || {})) {
    if (!fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json'))) { depsOk = false; add('block', `依赖缺失：${name}`, 'node_modules 里没有这个包', '在项目根目录执行：npm ci'); }
  }
} catch (e) { depsOk = false; add('block', 'package.json', `读取失败：${e.message}`, '确认压缩包完整解压'); }
if (depsOk) add('ok', 'node_modules', 'package.json 里的依赖都在');

// 3) 配置文件
const cfgPath = path.join(ROOT, 'config.json');
let cfg = null;
if (!fs.existsSync(cfgPath)) {
  add('block', 'config.json', '不存在（包内只有 config.example.json）', '复制 config.example.json 为 config.json，然后填 snowluma.accessToken / dsh.baseUrl / allow.groups / ownerQQ');
} else {
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    add('ok', 'config.json', '存在且 JSON 合法');
  } catch (e) { add('block', 'config.json', `JSON 解析失败：${e.message}`, '检查逗号/引号；可用 config.example.json 对照'); }
}

// 4) 必填项
if (cfg) {
  if (!Array.isArray(cfg.allow?.groups) || cfg.allow.groups.length === 0) add('warn', 'allow.groups', '为空：任何群都不会被回复', '在 config.json 的 allow.groups 填上要服务的群号');
  else add('ok', 'allow.groups', `${cfg.allow.groups.length} 个群`);
  if (!cfg.ownerQQ) add('warn', 'ownerQQ', '为空：管理员通知/控制台识别会退化', '填你自己的 QQ 号');
  else add('ok', 'ownerQQ', String(cfg.ownerQQ));
  if (!cfg.dsh?.baseUrl) add('warn', 'dsh.baseUrl', '为空：桥接会尝试自动发现本机 DSH', '一般可留空；连不上时填 http://127.0.0.1:<DSH端口>');
}

// 5) 端口 / 服务连通性（TCP 探测）
function tcp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
const snowUrl = cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000';
const snowHostPort = (() => { try { const u = new URL(snowUrl); return { host: u.hostname, port: Number(u.port || 80) }; } catch { return { host: '127.0.0.1', port: 3000 }; } })();
const wsUrl = cfg?.snowluma?.wsUrl || 'ws://127.0.0.1:3001';
const wsHostPort = (() => { try { const u = new URL(wsUrl); return { host: u.hostname, port: Number(u.port || 80) }; } catch { return { host: '127.0.0.1', port: 3001 }; } })();

const dshUrl = cfg?.dsh?.baseUrl || 'http://127.0.0.1:14043';
const dshHostPort = (() => { try { const u = new URL(dshUrl); return { host: u.hostname, port: Number(u.port || 80) }; } catch { return { host: '127.0.0.1', port: 14043 }; } })();
const dshPort = dshHostPort.port;

if (await tcp(wsHostPort.host, wsHostPort.port)) add('ok', 'SnowLuma WS', `${wsHostPort.host}:${wsHostPort.port} 可连`);
else add('block', 'SnowLuma WS', `${wsHostPort.host}:${wsHostPort.port} 连不上`, '先启动 SnowLuma 并登录 QQ，确认 OneBot WebSocket 端口与 config.snowluma.wsUrl 一致');
if (await tcp(snowHostPort.host, snowHostPort.port)) add('ok', 'SnowLuma HTTP', `${snowHostPort.host}:${snowHostPort.port} 可连`);
else add('warn', 'SnowLuma HTTP', `${snowHostPort.host}:${snowHostPort.port} 连不上`, '部分网关只开 WS；HTTP 用于取直链/成员信息，建议一并开启');
if (await tcp(dshHostPort.host, dshPort)) add('ok', 'DSH', `${dshHostPort.host}:${dshPort} 可连`);
else add('block', 'DSH', `${dshHostPort.host}:${dshPort} 连不上`, '安装并启动 DeepSeek Harness，或用 config.dsh.baseUrl 指向它实际端口');
if (await tcp('127.0.0.1', 3100)) add('warn', '控制台端口 3100', '已被占用（可能已有桥接在跑）', '先停掉旧实例，或改 config.consolePort');
else add('ok', '控制台端口 3100', '空闲');

// 6) 可选组件
const ff = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 });
if (ff.status === 0) add('ok', 'ffmpeg', String(ff.stdout).split('\n')[0].slice(0, 60));
else add('warn', 'ffmpeg', '未找到（视频抽帧/转码/缩略图/HEIC 会不可用）', '安装 ffmpeg 并加入 PATH，或把 config.socialV2.voice.ffmpegPath 指向 ffmpeg.exe');

const py = spawnSync(cfg?.socialV2?.stt?.python || 'python', ['-c', 'import faster_whisper, sys; print(faster_whisper.__version__)'], { encoding: 'utf8', timeout: 8000 });
if (py.status === 0) add('ok', 'faster-whisper', `v${String(py.stdout).trim()}`);
else add('warn', 'faster-whisper', '未安装（视频语音转写不可用）', 'pip install faster-whisper（首次运行会自动下载模型）');

if (cfg?.socialV2?.localFallback?.enabled) {
  if (await tcp('127.0.0.1', 11434)) add('ok', 'ollama', '127.0.0.1:11434 可连');
  else add('warn', 'ollama', '未运行（本地兜底不可用）', '启动 ollama，或把 socialV2.localFallback.enabled 设为 false');
}

// 7) 输出
const blocks = checks.filter((c) => c.level === 'block');
const warns = checks.filter((c) => c.level === 'warn');
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: blocks.length === 0, blocks: blocks.length, warns: warns.length, checks }, null, 2));
} else {
  const icon = { ok: '✅', warn: '⚠️', block: '❌' };
  console.log(`\n=== QQ Bridge 环境自检（${path.basename(ROOT)}）===\n`);
  for (const c of checks) {
    console.log(`${icon[c.level]} ${c.name}：${c.detail}`);
    if (c.fix && c.level !== 'ok') console.log(`   → ${c.fix}`);
  }
  console.log(`\n结论：阻断 ${blocks.length} 项，警告 ${warns.length} 项。`);
  if (blocks.length === 0) {
    console.log('可以启动：node src/bridge.js（或 start.bat）。控制台 http://127.0.0.1:3100 ，token 在 state/console-token。');
  } else {
    console.log('先按上面的「→」修掉阻断项，再跑一次本脚本。');
  }
}
process.exit(blocks.length ? 1 : 0);
