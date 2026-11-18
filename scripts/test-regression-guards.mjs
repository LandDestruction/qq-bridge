import { readBridgeSource } from './bridge-source.mjs';
// 反向断言（静态）：今天修过的几条 bug 不许重新出现。
//
// 这些检查读源码而不是跑行为 —— 它们拦的是「有人把修复删掉/改回去」这类回归，
// 成本低、信号明确；行为覆盖由各模块自己的 test-*.mjs 负责。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const bridge = readBridgeSource();
// D59 把账本拆成了 src/token-ledger/ 下的模块（barrel 只做 re-export）。
// 静态断言必须覆盖「barrel + 全部子模块」，否则代码一搬家，断言就变成在空文件上找字符串：
// 正向断言会假红（本次回归就是这样红的），反向断言（!includes）会假绿 —— 后者更危险。
const ledgerDir = path.join(ROOT, 'src', 'token-ledger');
const ledger = [
  fs.readFileSync(path.join(ROOT, 'src', 'token-ledger.js'), 'utf8'),
  ...(fs.existsSync(ledgerDir)
    ? fs.readdirSync(ledgerDir).filter((f) => f.endsWith('.js')).sort()
      .map((f) => fs.readFileSync(path.join(ledgerDir, f), 'utf8'))
    : [])
].join('\n');
const imageHash = fs.readFileSync(path.join(ROOT, 'src', 'image-hash.js'), 'utf8');

let failed = 0;
function must(name, cond, hint = '') {
  if (cond) { console.log(`✅ ${name}`); return; }
  failed += 1;
  console.error(`❌ ${name}${hint ? ` — ${hint}` : ''}`);
}

// ① 媒体哈希必须走异步版（同步版会把事件循环按住最多 15s）
must('bridge 调用 dhashFromBufferAsync 且不再调用同步版',
  bridge.includes('dhashFromBufferAsync(') && !/\bdhashFromBuffer\(/.test(bridge));

// ② 取图必须走缓存（同一文件不重复抓）
must('bridge 的 tryGetImage 走 getImageCached',
  bridge.includes('getImageCached(') && bridge.includes('const info = await getImageCached('));

// ③ 已知坏模型不再当首选
must('ensureChatModel 里有 bad(use) 跳过逻辑',
  bridge.includes('if (bad(use))') && bridge.includes('knownUnavailableModels'));

// ④ 视觉守卫必须读「本轮生效模型」
must('视觉守卫用 resolveTurnModel(applied…)',
  bridge.includes('resolveTurnModel(') && bridge.includes('appliedModelBySession'));

// ⑤ 本地保活只发一次（模块级到期时间，不是拿配置常量判断）
must('保活判据是 localKeepAliveUntil',
  bridge.includes('localKeepAliveUntil') && !bridge.includes("String(c.keepAlive || '') !== '30m'"));

// ⑥ series.totals 必须复用 ledgerCost（别再单算一条）
// 逐条采样里仍然会累加 totals.cost（用于窗口内统计），但**最终必须被 ledgerCost 覆盖**，
// 且不能再出现「offChart = ledgerCost - totals.cost」这种第二条算法。
must('series totals 最终复用 ledgerCost（且无 offChart 差值算法）',
  ledger.includes('totals.cost = ledgerCost;') && !ledger.includes('offChartCost: Math.max(0, ledgerCost - totals.cost)'));

// ⑦ 淘汰累计必须按 atoms 精确剔除（不能退回全有全无）
// D59 拆模块后调用点变成 store.goneParts(e)：断言只认「有没有用 goneParts(e)」，
// 不认它挂在谁身上 —— 否则单纯搬家就会假红。
must('series 的淘汰累计走 goneParts',
  ledger.includes('goneParts(e)'));

// ⑧ 观察群必须在未授权闸门之前
must('observe 学习调用早于「忽略未授权会话」',
  bridge.indexOf('observeLearnFromGroupMessage(event)') < bridge.indexOf('忽略未授权会话 ${key}'));

// ⑨ 观察群禁止出图
must('draw 路由内有观察群 403 守卫', bridge.includes('这是观察学习群：只收集词汇/表情，不发图不发言'));

// ⑩ 图片类型按魔数判定
must('image-hash/safe-fetch 有魔数判定', /imageContentType/.test(bridge) || /imageContentType/.test(fs.readFileSync(path.join(ROOT, 'src', 'imagegen.js'), 'utf8')));

// ⑪ 翻译降级顺序：本地优先，主模型只作回落（不许把顺序反过来）
{
  // 只在翻译回调那一段里比顺序：先 localClientNow()，出错后才 ensureSlangLearnerSession()。
  const segStart = bridge.indexOf('callModel: async ({ system, user');
  const segEnd = bridge.indexOf('drawPrompt = tr.text;', segStart);
  const seg = segStart >= 0 && segEnd > segStart ? bridge.slice(segStart, segEnd) : '';
  must('翻译先走本地、失败才回落主模型专用会话',
    seg.includes('本地翻译不可用') && seg.includes('ensureSlangLearnerSession()') &&
    seg.indexOf('localClientNow()') >= 0 && seg.indexOf('localClientNow()') < seg.indexOf('ensureSlangLearnerSession()'));
}

if (failed) { console.error(`\n❌ 反向断言失败（${failed} 条）`); process.exit(1); }
console.log('\n🎉 反向断言全部通过（10 条）');
