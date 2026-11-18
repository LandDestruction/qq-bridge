// 重启后的一键验收（只读，不改任何东西）。
//
// 用法：node scripts/verify-after-restart.mjs [群号]
//   默认群号 100000005（观察群）。
//
// 检查三件事：
//   ① GET /api/observe/config 返回 enabled:true 且 groups 含该群，description 非空
//   ② bridge.log 最近窗口里不再出现「忽略未授权会话 group:<群号>」，且出现观察群日志
//   ③ bridge.log 不再每轮出现「设置会话模型失败」（§8）
//
// 全部只读：读日志、发一个 GET。需要控制台 token（环境变量 CONSOLE_TOKEN 或 config.json）。
import fs from 'node:fs';
import path from 'node:path';

const LIVE = process.env.QQ_BRIDGE_LIVE || 'C:/Users/PC/Documents/deepseek-harness/qq-bridge-src';
const groupId = String(process.argv[2] || '100000005');
const cfgPath = path.join(LIVE, 'config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
const port = Number(process.env.CONSOLE_PORT || cfg.consolePort || 3100);
const token = process.env.CONSOLE_TOKEN || cfg.consoleToken || (() => {
  // config.json 里常常没有 consoleToken（首次启动会自动生成并写入 state/console-token），
  // 只读 config 会一直 401 —— 这个脚本必须自己去找那份文件。
  try { return fs.readFileSync(path.join(LIVE, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
})();

function readLog() {
  for (const name of ['bridge.log']) {
    const f = path.join(LIVE, 'state', name);
    try { return fs.readFileSync(f, 'utf8'); } catch {}
  }
  return '';
}
const logText = readLog();
const tail = logText.split('\n').slice(-4000).join('\n');  // 只看最近约 4000 行

let ok = 0, bad = 0;
function report(name, pass, detail = '') {
  if (pass) { ok += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { bad += 1; console.error(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ① 接口自查
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/observe/config`, { headers: token ? { 'x-console-token': token } : {} });
  const json = await res.json().catch(() => null);
  report('GET /api/observe/config 可用', res.status === 200, `HTTP ${res.status}`);
  report('observe.enabled = true', json?.enabled === true, JSON.stringify(json?.enabled));
  report(`observe.groups 含 ${groupId}`, Array.isArray(json?.groups) && json.groups.map(String).includes(groupId), JSON.stringify(json?.groups));
  report('description 非空', typeof json?.description === 'string' && json.description.length > 0, String(json?.description ?? '').slice(0, 60));
} catch (error) {
  report('GET /api/observe/config 可用', false, `请求失败：${error?.message ?? error}（桥接是否已重启？）`);
}

// ② 观察群不再被当未授权丢弃
// 只看**本次启动之后**的日志：历史行里的「忽略未授权会话」是启用观察白名单之前留下的，
// 拿它当失败判据会永远红。日志行没有日期前缀，只有 HH:MM:SS，所以从最后一条「桥接已启动」取时刻。
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const cleanLines = logText.split(NL).map((l) => l.split(CR).join(''));
const bootLine = cleanLines.filter((l) => l.includes('桥接已启动')).pop() || '';
const hmOf = (line) => {
  const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (!m) return null;
  const d = new Date(); d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  return d.getTime();
};
const startMs = hmOf(bootLine) ?? 0;
const sinceBoot = cleanLines.filter((line) => {
  const t = hmOf(line);
  return t !== null && t >= startMs;
}).join(NL);
const unauthorized = (sinceBoot.match(new RegExp(`忽略未授权会话 group:${groupId}`, 'g')) || []).length;
report('不再出现「忽略未授权会话」', unauthorized === 0, `本次启动后命中 ${unauthorized} 次`);
const observeLines = (tail.match(/观察群 .*只学习不发言/g) || []).length;
report('出现观察群学习日志（需用户已在该群发过消息）', observeLines > 0, `命中 ${observeLines} 次`);

// ③ §8 模型失败日志
const modelFail = (tail.match(/设置会话模型失败/g) || []).length;
report('「设置会话模型失败」不再每轮出现', modelFail <= 2, `命中 ${modelFail} 次（>2 说明仍在每轮踩坏 id）`);

console.log(`\n${bad ? '❌' : '✅'} ${ok}/${ok + bad} 项通过`);
process.exit(bad ? 1 : 0);
