// 控制台 handler 拆函数后的「自由变量」守卫。
//
// 为什么需要：D83 把 600 行的 if 守卫拆成「路由表 + 小函数」时，函数体里继续用外层局部名
// （典型是 `ctx`），但签名忘了带这个参数 —— 语法完全合法、静态检查全过、单测也照样绿，
// 只有真机发消息时才抛 `ReferenceError: ctx is not defined`。
// 线上表现就是「AI 说了一遍话又重复一遍」：发送工具报错 → 模型重试换工具 → 消息重复落地。
//
// 这个测试按「函数体里出现某个裸标识符、签名里没有、体里也没声明」来扫，只扫少数几个
// 拆分时最容易漏的名字（ctx 这类中间状态对象），不追求做完整的 JS 作用域分析。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src/bridge', 'src/bridge/console', 'src/bridge/boot'];
// 只在「拆分出来的中间状态对象」上扫：它们总是以对象字面量构造、参数传递，没有全局同名物。
const WATCHED = ['ctx'];

let pass = 0;
let fail = 0;
function check(ok, label, extra) {
  if (ok) {
    pass += 1;
    console.log('  ok   ' + label);
  } else {
    fail += 1;
    console.log('  FAIL ' + label + (extra ? ' — ' + extra : ''));
  }
}

function listFiles() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js')) out.push(path.join(ROOT, dir, name));
    }
  }
  return out;
}

/** 抓所有具名函数声明，返回 {name, params, body}；body 用花括号配平切出来。 */
function functions(src) {
  const found = [];
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const params = m[2];
    const start = re.lastIndex - 1;
    let depth = 0;
    let i = start;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { i += 1; break; }
      }
    }
    found.push({ name, params, body: src.slice(start, i) });
  }
  return found;
}

/** 去掉注释和字符串字面量，避免 `ctx-report.mjs` 这种注释里的词被当成变量引用。 */
function stripNoise(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, '``');
}

console.log('控制台 handler 自由变量守卫');
console.log('');

const offenders = [];
for (const file of listFiles()) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');
  for (const fn of functions(src)) {
    const body = stripNoise(fn.body);
    for (const name of WATCHED) {
      const used = new RegExp('\\b' + name + '\\b').test(body);
      if (!used) continue;
      const hasParam = new RegExp('\\b' + name + '\\b').test(fn.params);
      // 体里自己声明了同名变量 / 箭头函数参数里就叫这个名字，都不算自由变量。
      const declaredLocally = new RegExp('(?:const|let|var)\\s+(?:\\{[^}]*\\b' + name + '\\b[^}]*\\}|\\b' + name + '\\b)').test(body)
        || new RegExp('(?:\\([^)]*\\b' + name + '\\b[^)]*\\)|\\b' + name + '\\s*)=>').test(body);
      if (!hasParam && !declaredLocally) offenders.push(`${rel} :: ${fn.name}(${fn.params})`);
    }
  }
}

check(offenders.length === 0, `没有「用了 ${WATCHED.join('/')} 但签名里没接」的函数`, offenders.join(' ｜ '));

// 反向锚点：这几个函数是 D83 拆出来的、必须显式接 ctx（漏一个就会让发消息整条链路报错）。
const convSend = fs.readFileSync(path.join(ROOT, 'src/bridge/console/conversation-send.js'), 'utf8');
const mediaTools = fs.readFileSync(path.join(ROOT, 'src/bridge/console/media-tools.js'), 'utf8');
for (const name of ['sendMessageAutoVoice', 'sendMessageVoiceDirective', 'sendMessageQuota', 'sendMessageFinal', 'sendBurstSend', 'sendBurstVoiceParts', 'sendPokeSend']) {
  check(new RegExp('async function ' + name + '\\(deps, request, ctx\\)').test(convSend), `${name}(deps, request, ctx) 显式接 ctx`);
}
for (const name of ['voiceOperatorProbe', 'voiceOperatorSend', 'sendVoiceTtsBranch', 'sendVoiceAfterBudget', 'sendStickerDispatch']) {
  check(new RegExp('async function ' + name + '\\(deps, request, ctx\\)').test(mediaTools), `${name}(deps, request, ctx) 显式接 ctx`);
}

// 调用点也必须把 ctx 传进去（签名改了、调用没改同样是线上炸）。
const callSites = [
  [convSend, 'sendMessageAutoVoice(deps, request, ctx)'],
  [convSend, 'sendMessageVoiceDirective(deps, request, ctx)'],
  [convSend, 'sendMessageQuota(deps, request, ctx)'],
  [convSend, 'sendMessageFinal(deps, request, ctx)'],
  [mediaTools, 'voiceOperatorProbe(deps, request, { key, voice })'],
  [mediaTools, 'voiceOperatorSend(deps, request, { key, body, voice, resolved, preview })'],
  [mediaTools, 'sendStickerDispatch(deps, request, { key, stickerId, actualReplyToMessageId, quotedInfo, atUserId })']
];
for (const [src, needle] of callSites) {
  check(src.includes(needle), `调用点传了 ctx：${needle}`);
}

console.log('');
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
