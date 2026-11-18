// 开发消耗统计：把本机 DSH 会话日志里每一步的 usage 加总，写进控制台「致谢 / 教训」里。
//
// 为什么单独一个脚本：会话日志在 ~/.dsh/sessions 下，一条会话是几百个 zstd 帧拼起来的
// （每个事件一个帧），Node 自带的 zstd 解压一次只吃一个帧，所以要先按魔数切帧再逐帧解。
// 产物 client/07a-dev-tokens.js 随客户端一起打包，控制台不需要访问用户的 home 目录。
//
// 用法：node scripts/dev-token-report.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'client', '07a-dev-tokens.js');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions');
// 只算「这个项目的开发会话」：qq-bridge-src 本体、桥接/前后端 worktree、default-workspace。
// state-agents 是机器人自己在跑时的会话（那是线上用量，不是开发用量），排除。
const PREFIXES = ['--C-Users-PC-Documents-deepseek-harness', '--E-qq-project-'];
const SKIP = /state-agents/;
const USAGE = /"usage":\{"inputTokens":(\d+),"outputTokens":(\d+),"cacheReadTokens":(\d+),"cacheWriteTokens":(\d+),"totalTokens":(\d+)\}/g;

function collectFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (e.isFile() && /session\.v4\.jsonl\.zstd$/.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

function frames(raw) {
  const offs = [];
  let i = 0;
  while (i < raw.length - 4) {
    const hit = raw.indexOf(MAGIC, i);
    if (hit < 0) break;
    offs.push(hit);
    i = hit + 4;
  }
  return offs;
}

const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0 };
const byDay = new Map();
let sessions = 0;
let files = 0;
if (fs.existsSync(SESSIONS)) {
  for (const dir of fs.readdirSync(SESSIONS)) {
    if (!PREFIXES.some((p) => dir.startsWith(p)) || SKIP.test(dir)) continue;
    for (const file of collectFiles(path.join(SESSIONS, dir))) {
      let raw;
      try { raw = fs.readFileSync(file); } catch { continue; }
      files += 1;
      const offs = frames(raw);
      let used = false;
      for (let k = 0; k < offs.length; k += 1) {
        let out;
        try { out = zlib.zstdDecompressSync(raw.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : raw.length)); } catch { continue; }
        const text = out.toString('utf8');
        if (!text.includes('"usage":')) continue;
        USAGE.lastIndex = 0;
        let m;
        while ((m = USAGE.exec(text)) !== null) {
          used = true;
          totals.input += Number(m[1]);
          totals.output += Number(m[2]);
          totals.cacheRead += Number(m[3]);
          totals.cacheWrite += Number(m[4]);
          totals.total += Number(m[5]);
          totals.calls += 1;
          const at = text.lastIndexOf('"time":', m.index);
          if (at >= 0) {
            const ms = /"time":(\d+)/.exec(text.slice(at, at + 40));
            if (ms) {
              const day = new Date(Number(ms[1])).toISOString().slice(0, 10);
              byDay.set(day, (byDay.get(day) || 0) + Number(m[5]));
            }
          }
        }
      }
      if (used) sessions += 1;
    }
  }
}

const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const snapshot = {
  generatedAt: new Date().toISOString(),
  scope: '本机 DSH 会话（qq-bridge-src / 桥接与前端 worktree / default-workspace；不含机器人运行时 agent 会话）',
  sessions,
  files,
  ...totals,
  firstDay: days.length ? days[0][0] : '',
  lastDay: days.length ? days[days.length - 1][0] : '',
  days
};

const body = '// 由 scripts/dev-token-report.mjs 生成，别手改。数字来源：~/.dsh/sessions 的 DSH 会话日志。\n'
  + 'var DEV_TOKEN_SNAPSHOT = ' + JSON.stringify(snapshot, null, 2).replace(/\n/g, '\n') + ';\n';
fs.writeFileSync(OUT, body, 'utf8');
console.log(JSON.stringify({ out: path.relative(ROOT, OUT), sessions, files, total: totals.total, calls: totals.calls, firstDay: snapshot.firstDay, lastDay: snapshot.lastDay }, null, 1));
