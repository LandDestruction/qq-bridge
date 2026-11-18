// 静态页面结构契约：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构。
//
// 历史：这个文件原本 ~90% 的断言都在读 public/console.html（旧控制台页，8391 行）。
// 旧页已下线删除，页内的 DOM/内联脚本断言（ID 唯一、data-view↔data-page、语音面板、
// 轮询滚动、白名单解析、用量/账本/体检卡/出图/存储/上下文效率/错误兜底/黑话批量/配置 diff、
// 窄屏、状态条、toast…）随页面一起淘汰 —— 留着只会对着不存在的文件报错。
// 仍然在线的三页（ops.html 运维面板、library.html 文件库、独立发语音工具的 voice.html）
// 的断言原样保留在这里，文件名也保持不变（scripts/test-audit.mjs 与
// scripts/test-voice-system.mjs 都按这个名字登记它）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ops = fs.readFileSync(path.join(ROOT, 'public', 'ops.html'), 'utf8');
const library = fs.readFileSync(path.join(ROOT, 'public', 'library.html'), 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 元素 ID 唯一');
for (const [name, src] of [['ops.html', ops], ['library.html', library]]) {
  const ids = [...src.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  ok(dups.length === 0, `${name} ID 唯一`, dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
}

console.log('## JS 语法');
for (const [name, src] of [['ops.html', ops], ['library.html', library]]) {
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { new Function(scripts[0]); ok(true, `${name} 脚本语法可解析`, `${scripts[0].length} 字符`); }
  catch (e) { ok(false, `${name} 脚本语法`, e.message); }
}

console.log('## ops.html：转义与高峰期轮询');
ok(/function esc\(s\)/.test(ops), 'ops.html 定义了 esc() 转义函数');
ok(/wordEl\.textContent = String\(e\.content \|\| ''\)/.test(ops), '黑话词条改用 textContent 写入');
ok(/meaningEl\.textContent = String\(e\.meaning \|\| ''\)\.slice\(0, 70\)/.test(ops), '黑话释义改用 textContent 写入');
ok(!/\+\s*String\(e\.content \|\| ''\)\s*\+/.test(ops), '词条不再拼进 innerHTML（存储型 XSS）');
ok(/esc\(s\.name\)/.test(ops) && /esc\(s\.detail \|\| ''\)/.test(ops) && /esc\(s\.supervision \|\| ''\)/.test(ops), 'renderServices 的 name/detail/supervision 已转义');
const peakTimers = (ops.match(/loadRouting\(\)\.catch\(\(\) => \{\}\)/g) ?? []).length;
ok(/function ensurePeakPolling\(\)[\s\S]{0,300}?setInterval\(/.test(ops) && peakTimers >= 1, '高峰期轮询只建一次（模块级，且不覆盖未保存草稿）', `${peakTimers} 处`);

console.log('## ops.html：接口失败必须可见');
const opsLoaders = (ops.match(/if \(!res\.ok \|\| !data\.ok\) throw new Error/g) ?? []).length;
ok(opsLoaders >= 2, 'ops.html 的 services / stickers loader 判 res.ok+data.ok 并抛出', `${opsLoaders} 处`);
// GET /api/slang 的成功响应是 {entries, config, writable}（没有 ok 字段），
// 所以它必须判 entries 是不是数组，不能盲抄 data.ok —— 否则正常响应也会被当成失败。
ok(/const list = data\.entries \|\| data\.items;\s*\n\s*if \(!res\.ok \|\| !Array\.isArray\(list\)\) throw new Error/.test(ops), 'loadSlang 按 entries 数组判定（该接口没有 ok 字段）');
ok(/opsMsgError\('svc-msg'/.test(ops) && /opsMsgError\('slang-msg'/.test(ops) && /opsGridError\('sticker-grid'/.test(ops), '失败写进 svc-msg / slang-msg / sticker-grid');
ok(!/note\.addEventListener\('blur'/.test(ops), '表情注释不再 change + blur 双绑');
ok(/noteEl\.dataset\.orig/.test(ops) && /if \(note === origNote && tags\.slice\(\)\.sort\(\)\.join/.test(ops), '注释保存前比对上次值，无变化跳过请求');

console.log('## ops.html：轮询治理（页面不可见时暂停）');
ok(/document\.addEventListener\('visibilitychange'/.test(ops), 'ops.html 监听 visibilitychange');
ok(/function opsStartPolling\(\)[\s\S]{0,260}?if \(opsPollTimers\.length\) return;/.test(ops) && /function opsStopPolling\(\)/.test(ops), 'ops.html 有 opsStart/StopPolling');
ok(/peakPollTimer = null;/.test(ops), 'ops.html 停止时一并清掉暂停开关的 30 秒定时器');
ok(/if \(document\.hidden\) \{ opsStopPolling\(\); return; \}/.test(ops), 'ops.html 隐藏时停掉定时器');
ok(/tick\(\); tickServices\(\); loadRouting\(\);/.test(ops) && /opsStartPolling\(\);\n<\/script>/.test(ops), 'ops.html 回前台补刷一次再恢复');
ok((ops.match(/setInterval\(/g) ?? []).length === 3, 'ops.html 的周期定时器只在 opsStartPolling/ensurePeakPolling 里', `${(ops.match(/setInterval\(/g) ?? []).length} 处`);

console.log('## ops.html：异步操作防重复提交');
const opsBusyCalls = (ops.match(/opsBusy\(/g) ?? []).length - 1; // 减去函数声明
ok(/async function opsBusy\(btn, fn\)/.test(ops) && opsBusyCalls >= 2, 'ops.html 的 POST 按钮也包了 opsBusy', `${opsBusyCalls} 处`);

console.log('## ops.html：破坏性操作二次确认');
ok(/pendingConfirm !== service \+ ':' \+ action/.test(ops), 'ops.html 重启/停止服务走两步确认（先变「确认重启？」再执行）');

console.log('## ops.html：表情失效标记（后端就绪后）');
ok(/thumbStatus === 'missing'/.test(ops), '识别后端 thumbStatus=missing');
ok(/缩略图不可用 · 源链接已过期/.test(ops), '失效条目占位文案写「源链接已过期」');
ok(/删除该条/.test(ops) && /\/api\/stickers\/remove/.test(ops), '失效条目有「删除该条」并调 POST /api/stickers/remove');
ok(/可重新采集：群内发「\/收藏」或让 AI 再偷一次/.test(ops), '提示如何重新采集');
ok(/其中失效 ' \+ brokenCount \+ ' 条/.test(ops), '顶部计数补「其中失效 N 条」');
ok(/stickerTotal = Number\(data\.total\) > 0/.test(ops) && /'共 ' \+ \(stickerTotal \|\| stickerCache\.length\)/.test(ops), '共 N 用接口 total，不本地算');
ok(/\/api\/stickers\/thumbnail\?id=' \+ encodeURIComponent\(e\.id\) \+ q/.test(ops) && /const q = token \? '&token='/.test(ops), '缩略图 URL 带 console token');
ok(/if \(e && e\.thumbStatus === 'missing'\) \{[\s\S]{0,80}showPlaceholder\(STICKER_EXPIRED_TEXT\)/.test(ops), 'thumbStatus=missing 时不再发网络请求，直接占位');

console.log('## ops.html：表情去重 + 本地缩略图');
ok(/function dedupeStickerEntries\(list\)/.test(ops), '有面板侧去重函数 dedupeStickerEntries');
ok(/function mergeStickerEntries\(group\)/.test(ops), '有合并函数 mergeStickerEntries');
ok(/notes\.sort\(\(a, b\) => b\.length - a\.length\)/.test(ops), '合并时保留最长备注（人工 note 不丢）');
ok(/base\.policy = group\.some\(\(e\) => e\.policy === 'usable'\)/.test(ops), '可发/不可发冲突时保留可发');
ok(/stickerMergedCount/.test(ops) && /合并掉 ' \+ stickerMergedCount \+ ' 条重复/.test(ops), '计数注明「合并掉 M 条重复」');
ok(/id="sticker-dedupe"/.test(ops) && /async function dedupeStickers\(btn\)/.test(ops), '有「合并重复」按钮与处理函数');
ok(/POST \/api\/stickers\/dedupe/.test(ops), '合并调 POST /api/stickers/dedupe');
ok(/function stickerThumbChain\(e\)/.test(ops), '有来源链函数 stickerThumbChain');
ok(/\/api\/stickers\/thumbnail\?id=/.test(ops), '第一级走桥接缓存路由 /api/stickers/thumbnail?id=');
ok(!/\/api\/stickers\/thumb\?md5=/.test(ops), '不再保留已被服务端删掉的旧路由 /api/stickers/thumb?md5=（那只会多一条 404）');
ok((() => {
  const a = ops.indexOf("'/api/stickers/thumbnail?id='");
  const b = ops.indexOf('chain.push(String(e.url))');
  return a > -1 && b > a;
})(), '来源链顺序：thumbnail(id)（内部先读缓存） → QQ CDN');
ok(!/p\.qpic\.cn/.test(ops), 'ops.html 里没有写死 p.qpic.cn（CDN 只作最后兜底）');
ok(/只看失效（缩略图不可用）/.test(ops) && /function isStickerBroken\(e\)/.test(ops), '有「只看失效」筛选（thumbStatus=missing 或加载失败）');
ok(/缩略图不可用（本地缓存缺失\/损坏，可用「重新拉取」）/.test(ops), '占位文案说明「本地缓存缺失/损坏」并给出操作');

console.log('## ops.html：表情缩略图兜底');
ok(/function buildStickerThumb\(e\)/.test(ops), '存在缩略图兜底构造函数 buildStickerThumb');
ok(/stickerThumbUrl/.test(ops) && /\/api\/stickers\/thumbnail\?id=/.test(ops), '优先走桥接本地缓存路由 /api/stickers/thumbnail');
ok(/const chain = stickerThumbChain\(e\);/.test(ops) && /if \(stage < chain\.length\)/.test(ops), '按来源链逐级回落（CDN 只作最后一级）');
ok(/缩略图不可用（可用「重新拉取」）/.test(ops), '三级都失败时给占位文案，而不是「图片已失效」');
ok(!/图片已失效/.test(ops), '旧的「图片已失效」文案已移除');
ok(/img\.onerror = \(\) => \{/.test(ops) && /showPlaceholder\(\)/.test(ops), '有 onerror 兜底链，不会出现浏览器默认碎图标');
ok(/img\.alt = stickerAlt\(e\)/.test(ops) && /function stickerAlt\(e\)/.test(ops), '缩略图有 alt（用 desc/localNote）');
ok(/重新拉取/.test(ops) && /async function repairStickers\(btn\)/.test(ops), '每卡有「重新拉取」入口');
ok(/async function repairAllStickers\(btn\)/.test(ops) && /id="sticker-repair-all"/.test(ops), '有批量重新拉取按钮');
ok(/POST \/api\/stickers\/repair/.test(ops), '重新拉取调 POST /api/stickers/repair');
ok(/已重新拉取：修复 ' \+ repaired/.test(ops), '成功文案用服务端返回的计数');
ok(/不出现任何成功字样|批量重新拉取失败/.test(ops) || /重新拉取失败：POST \/api\/stickers\/repair '/.test(ops), '失败文案含接口与状态（无假成功）');
ok(/GET ' \+ listPath \+ ' ' \+ res\.status \+ ' — ' \+ detail/.test(ops), '列表失败文案含「接口 + 状态 + 原文」');

console.log('## ops.html：高峰期与模型（合并卡片）');
ok(ops.includes('id="routing-card"'), 'ops 有合并卡片 #routing-card');
ok(ops.includes('高峰期与模型'), '卡片标题「高峰期与模型」');
ok(ops.includes("fetch('/api/model-routing'"), '调用 GET /api/model-routing');
ok(ops.includes("method: 'POST'") && ops.includes("'/api/model-routing' + (token"), '保存走 POST /api/model-routing');
for (const id of ['routing-peak-enabled', 'routing-idle', 'routing-peak', 'routing-fallback', 'routing-disabled', 'routing-save', 'routing-effective', 'routing-msg']) {
  ok(ops.includes('id="' + id + '"'), `卡片有 #${id}`);
}
ok(ops.includes('空闲期模型') && ops.includes('高峰期模型'), '有「空闲期模型 / 高峰期模型」两块');
ok(ops.includes('降级候选（有序，最多 5 个）'), '有降级候选区（最多 5 个）');
ok(ops.includes('禁用项（选择 / 降级时跳过）'), '有禁用项区');
ok(ops.includes('下一轮生效，无需重启'), '有「下一轮生效，无需重启」提示');
ok(ops.includes('已保存（下一轮生效）'), '保存成功文案「已保存（下一轮生效）」');
ok(ops.includes('当前实际使用：'), '底部有「当前实际使用」');
ok(ops.includes('ROUTING_SOURCE') && ops.includes("peak: '高峰'") && ops.includes("fallback: '降级'"), '来源文案（高峰/空闲/视觉/降级/默认）');
ok(ops.includes('routingDraft') && ops.includes('一次性提交'), '改动先暂存、点保存一次性提交');
ok(ops.includes('保存失败：'), '失败显示后端 error 原文');
ok(ops.includes('DSH 清单不可用，可稍后刷新'), 'options 为空时提示清单不可用');
ok(ops.includes('读取失败：GET /api/model-routing'), '读取失败文案带接口名与状态');
ok(ops.includes('routing-fb-up') && ops.includes('routing-fb-down'), '降级候选可上移/下移');
ok(ops.includes('ROUTING_MAX_FALLBACK = 5'), '降级候选上限 5');
ok(ops.includes('routingDirty()'), '有未保存修改提示逻辑');
ok(ops.includes('opsBusy(btn') && ops.includes('1000 - (Date.now() - started)'), '保存走 opsBusy + 1 秒防连点');
ok(!ops.includes("fetch('/api/models'"), '不再调用旧的 /api/models 单下拉接口');
ok(!ops.includes('loadPeakLocal'), '旧的只读高峰块已并入合并卡片');

console.log('## library.html（BOOTH 商品卡片）');
for (const id of ['q', 'filterToggle', 'sort', 'refresh', 'filters', 'filterCategories', 'filterShop', 'pager', 'drawer', 'drawerMask', 'viewBody']) {
  ok(library.includes('id="' + id + '"'), `library.html 有 #${id}`);
}
for (const nav of ['Home', 'Lists', 'Notify', 'Library', '未分类', 'Settings']) {
  ok(library.includes('>' + nav + '<') || library.includes('>' + nav), `左侧栏有 ${nav}`);
}
ok(library.includes("api('/api/library/items')"), '商品列表调 GET /api/library/items');
ok(library.includes("'/api/library/item-thumb?boothId='"), '卡片封面调 GET /api/library/item-thumb');
ok(library.includes("api('/api/library/item/'"), '详情调 GET /api/library/item/:id');
ok(library.includes("api('/api/library/unclassified')"), '未分类调 GET /api/library/unclassified');
ok(!library.includes('/api/files?limit=') && !library.includes("api('/api/files')"), '库页不再回退到 /api/files 平铺列表');
ok(!library.includes("'/api/files/thumb"), '不把 /api/files/thumb 直接当卡片封面');
ok(!library.includes('/api/files/export'), '库页没有文件级导出按钮（商品卡片没有这个概念）');
ok(library.includes('封面缺失'), '封面加载失败显示「封面缺失」占位');
ok(library.includes('onerror=') && library.includes('this.parentNode.innerHTML'), '封面 onerror 换占位，不出碎图标');
ok(library.includes("' 个文件'") || library.includes(' 个文件'), '卡片显示「N 个文件」');
ok(library.includes('totalBytes'), '卡片显示占用（totalBytes）');
ok(library.includes('loading="lazy"'), '缩略图 loading="lazy"');
ok(library.includes('aspect-ratio:1/1'), '商品缩略图方形');
ok(library.includes('在 BOOTH 打开'), '抽屉里有「在 BOOTH 打开」');
ok(library.includes('同号图片') || library.includes('素材'), '详情列同号图片（素材，不是卡片）');
ok(library.includes('Array.isArray(d.images)') && library.includes('d.meta'), '同号图片/meta 按契约从顶层取（不在 item 里）');
ok(library.includes("api('/api/files/category', 'POST'"), '未分类人工归类调 POST /api/files/category');
ok(library.includes('归类失败：POST /api/files/category'), '归类失败文案带接口名');
ok(library.includes('还没有归档的压缩包'), '商品空态文案存在');
ok(library.includes('没有待分类的压缩包') && library.includes('没有待分类的图片'), '未分类两栏空态文案存在');
ok(library.includes('读取失败：GET /api/library/items —'), '商品列表失败文案带接口名');
ok(library.includes('读取失败：GET /api/library/unclassified —'), '未分类失败文案带接口名');
ok(library.includes("get('token')") && library.includes('x-console-token'), '沿用 console 的 token 传递方式');

console.log('## 语音图形界面的音量控件');
if (!hasVoiceTool()) {
  // 这一整段查的是独立工具自己的页面（voice.html），仓库里没有它。
  skipVoiceTool('voice.html 的音量控件断言（volRange/volLabel/volReset/normBox/loudnessSel/previewBtn、滑块范围、事件绑定、前端 JS 可解析）');
} else {
  const voice = fs.readFileSync(voiceToolPath('public', 'voice.html'), 'utf8');
  const ids = [...voice.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  ok(dups.length === 0, 'voice.html ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
  for (const id of ['volRange', 'volLabel', 'volReset', 'normBox', 'loudnessSel', 'previewBtn']) {
    ok(ids.includes(id), `音量控件 ${id}`);
  }
  ok(/id="volRange"[^>]*min="10"[^>]*max="400"/.test(voice), '滑块范围 10%~400%');
  ok(/volRange'\)\.addEventListener\('input'/.test(voice), '滑块 input 事件已绑定');
  ok(/previewBtn'\)\.addEventListener/.test(voice), '试听按钮已绑定');
  ok(/api\/preview/.test(voice), '试听调 /api/preview（听处理后的效果）');
  ok(/body\.normalize = true/.test(voice) && /body\.volume = volValue\(\)/.test(voice), '发送时带上音量设置');
  const scripts = [...voice.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { new Function(scripts[0]); ok(true, 'voice.html 前端 JS 可解析'); }
  catch (e) { ok(false, 'voice.html 前端 JS 可解析', e.message); }
}

console.log('## 未转义数据拼进 innerHTML 的护栏');
// 规则：任何 innerHTML = / += 语句里出现「已知用户可控字段」（群友 / AI 可控）却没有
// esc( 或 textContent，就判失败并打印行号。确需豁免时，在该语句上 3 行内写
// `// innerHTML-ok: <为什么安全>`（豁免必须自带理由，不允许空豁免）。
const USER_FIELDS = ['content', 'meaning', 'sender', 'nickname', 'name', 'detail', 'usage', 'text', 'label',
  'question', 'reason', 'error', 'desc', 'note', 'tags', 'hint', 'title', 'sessionId', 'key', 'value'];
const BACKSLASH = String.fromCharCode(92);
// 从 innerHTML 处往后取一条语句（配平括号，跳过字符串/模板，遇语句结束的 ; 或外层 } 停止）。
function readStatement(src, start) {
  let i = start, depth = 0, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === BACKSLASH) { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ';' && depth === 0) break;
  }
  return src.slice(start, i);
}
function innerHtmlRisks(src) {
  const risks = [];
  const re = /innerHTML\s*(\+?=)/g;
  const fieldRe = new RegExp('\\b[A-Za-z_$][\\w$]*\\.(' + USER_FIELDS.join('|') + ')\\b');
  let m;
  while ((m = re.exec(src))) {
    const stmt = readStatement(src, m.index);
    if (/esc\(/.test(stmt) || /textContent/.test(stmt)) continue;
    if (!fieldRe.test(stmt)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const around = src.split('\n').slice(Math.max(0, line - 4), line).join('\n');
    if (/innerHTML-ok:/.test(around)) continue;
    risks.push({ line, stmt: stmt.replace(/\s+/g, ' ').slice(0, 110) });
  }
  return risks;
}
for (const [file, src] of [['public/ops.html', ops], ['public/library.html', library]]) {
  const risks = innerHtmlRisks(src);
  ok(risks.length === 0, `${file} 没有未转义的用户可控字段拼进 innerHTML`,
    risks.length ? risks.map((r) => `L${r.line}: ${r.stmt}`).join(' ｜ ') : '');
}

console.log('## 可访问性与键盘');
const bareButtons = (source, name) => {
  const badBtns = [...source.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => {
      const text = inner.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
      return !text && !/aria-label\s*=/.test(attrs);
    });
  ok(badBtns.length === 0, `${name} 里没有「无文字又无 aria-label」的按钮${badBtns.length ? '（发现 ' + badBtns.length + ' 个：' + badBtns[0][1].slice(0, 60) + '）' : ''}`);
};
bareButtons(ops, 'ops.html');
bareButtons(library, 'library.html');
ok(/:focus-visible\s*\{/.test(ops), 'ops.html 有 :focus-visible 焦点样式');
ok(!/outline\s*:\s*none/.test(ops), 'ops.html 没有用 outline:none 把焦点环干掉');

console.log('## 故障注入与失败分支（批次十）');
const fixtureSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'console-ui-fixture.mjs'), 'utf8');
ok(/export function parseFailSpec/.test(fixtureSrc), 'fixture 有故障注入解析（parseFailSpec）');
ok(/process\.env\.FIXTURE_FAIL\b/.test(fixtureSrc), '支持环境变量 FIXTURE_FAIL');
for (const mode of ['500', 'badjson', 'timeout', 'empty']) {
  ok(new RegExp(`'${mode}'`).test(fixtureSrc), `故障注入支持模式 ${mode}`);
}
ok(/path\.includes\(x\.fragment\)/.test(fixtureSrc), '按路径片段命中注入');
ok(/path\.startsWith\('\/__fixture\/'\)[\s\S]{0,60}?\? null/.test(fixtureSrc), '注入不拦 fixture 自身控制口（否则测试脚本起不来）');

console.log('## fixture mock 覆盖');
const fixture = fs.readFileSync(path.join(ROOT, 'scripts', 'console-ui-fixture.mjs'), 'utf8');
ok(fixture.includes("case '/api/dsh/models'") && /function fixtureModels\(\)/.test(fixture), 'fixture mock 了 GET /api/dsh/models');
ok(/if \(!known\) return json\(\{ ok: false, error: '模型不在可用清单里（fixture）', models: fixtureModels\(\) \}, 400\)/.test(fixture), 'fixture 的 POST /api/dsh/model 对未知模型返回 400 + 清单');
ok(fixture.includes("case '/api/socialV2/voices'"), 'fixture mock 了 /api/socialV2/voices');
ok(fixture.includes("case '/api/voice/send'"), 'fixture mock 了 /api/voice/send');

console.log('## 离线预览静态资源（client.html 只引用 /client.js + /client.css，以前 fixture 不 serve 所以白屏）');
ok(/path === '\/client\.js' \|\| path === '\/client\.css'/.test(fixture), 'fixture serve /client.js 与 /client.css');
ok(/readFile\(resolve\(projectRoot, 'public', asset\)\)/.test(fixture), '资源从 public/ 读，不复制第二份');
{
  const { startConsoleFixture } = await import('./console-ui-fixture.mjs');
  const fixtureServer = await startConsoleFixture({ port: 0 });
  // 用 agent:false 的 http.get 而不是 fetch：undici 的全局 keep-alive 池会在 server.close() 后
  // 留下未释放的 handle，Windows 上触发 libuv 断言（Assertion failed: UV_HANDLE_CLOSING）。
  const httpGet = (target) => new Promise((resolveGet, rejectGet) => {
    http.get(target, { agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolveGet({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', rejectGet);
  });
  try {
    for (const asset of ['client.js', 'client.css']) {
      const res = await httpGet(`${fixtureServer.url}/${asset}`);
      const onDisk = fs.readFileSync(path.join(ROOT, 'public', asset));
      ok(res.status === 200, `GET /${asset} 返回 200`, String(res.status));
      ok(res.body.equals(onDisk), `GET /${asset} 与 public/${asset} 字节一致`, `${res.body.length} B`);
      const ct = String(res.headers['content-type'] || '');
      ok(ct.startsWith(asset.endsWith('.js') ? 'text/javascript' : 'text/css'), `GET /${asset} content-type`, ct);
    }
  } finally {
    await fixtureServer.close();
  }
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
