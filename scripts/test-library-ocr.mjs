// 已购库截图识别（WinRT OCR）自测：
// ① extractPurchaseHints 对真实 OCR 片段（中文字之间会被插空格、一行里混着价格/按钮）抽号/配对标题；
// ② createLibraryOcr 的进程调用失败/超时/坏输出翻译成人话，且并发只跑一个；
// ③ handlePurchasesOcr 路由：dataURL/path 两种入口、8MB 上限、临时文件不残留、暂停闸、状态路由。
// 真 PowerShell 由 fixture 假实现替代（本机有 OCR 也不该在测试里反复 spawn）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  createLibraryOcr,
  extractPurchaseHints,
  OCR_MAX_IMAGE_BYTES,
  OCR_TMP_DIRNAME
} from '../src/bridge/console/library-ocr.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-test-'));
const logLines = [];
let failed = 0;
let passed = 0;
function check(ok, name, extra) {
  if (ok) { passed += 1; console.log(`  ok   ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`); }
  else { failed += 1; console.log(`  FAIL ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`); }
}

// ── §1 extractPurchaseHints：真实截图里的文本形态 ─────────────────────────────
console.log('§1 从 OCR 文本抽号/标题');
const LINES = [
  { text: '已购 10 库里对上 3 缺少 7', x: 700, y: 40 },
  { text: '上次同步 10-30 02:43 · 上次只同步了 1 页', x: 700, y: 70 },
  { text: '， Midnight Hug2 （ 蜉 “', x: 312, y: 519 },
  { text: '# 7547599', x: 313, y: 545 },
  { text: '三 步 丆 亻 尢 Milltinal', x: 735, y: 517 },
  { text: '# 8991327 cherry berry', x: 735, y: 545 },
  { text: 'Hana Capture Studio 2 ． 0', x: 307, y: 889 },
  { text: '# 9006522 Studio HANA', x: 313, y: 916 },
  { text: 'https://booth.pm/ja/items/9028816', x: 20, y: 620 },
  { text: 'CYCR ( Cyber Critter)', x: 306, y: 640 },
  { text: 'こちらの商品 ¥ 1,200円', x: 306, y: 660 },
  { text: '解 沂 入 （ 接 从 800TH 河 步 已', x: 737, y: 101 }
];
const hints = extractPurchaseHints(LINES);
check(hints.ids.slice().sort().join(',') === '7547599,8991327,9006522,9028816', '抽出 4 个 BOOTH 号', hints.ids);
check(hints.urls.length === 1 && hints.urls[0].includes('/items/9028816'), '抽出商品链接', hints.urls);
const pair = (id) => hints.items.find((item) => item.boothId === id);
check(pair('7547599')?.title === 'Midnight Hug2', '标题配对：Midnight Hug2', pair('7547599'));
check(pair('8991327')?.title === 'Milltinal', '标题配对：Milltinal（去掉前面的杂字）', pair('8991327'));
check(pair('9006522')?.title === 'Hana Capture Studio 2 ． 0', '标题配对：Hana Capture Studio', pair('9006522'));
check(hints.titles.some((t) => t.includes('CYCR') && t.includes('Cyber Critter')), '没配到号的标题也回给前端', hints.titles);
check(!hints.titles.some((t) => t.includes('已购') || t.includes('同步') || t.includes('解')), 'UI 文案不进标题候选', hints.titles);
check(!hints.titles.includes('10-30 02:43'), '时间行不当标题');
check(pair('9006522')?.priceText === '' || pair('9006522')?.priceText === undefined, '没有价格时不硬编价格', pair('9006522'));
const priced = extractPurchaseHints([{ text: '# 7777777 価格 1,200円', x: 10, y: 10 }]);
check(priced.items[0]?.priceText?.includes('円'), '价格从号行里抽出来', priced.items[0]);
const empty = extractPurchaseHints([]);
check(empty.items.length === 0 && empty.ids.length === 0 && empty.titles.length === 0, '空输入回空结构');
check(extractPurchaseHints(null).ids.length === 0, 'null 输入不炸');
const deco = extractPurchaseHints([{ text: '• ♥ 𝟑 ShatteredVow', x: 10, y: 10 }]);
check(deco.titles.includes('ShatteredVow'), '装饰字符（•♥𝟑）不进标题', deco.titles);
const wideIds = extractPurchaseHints([{ text: '# ９００６５２２', x: 1, y: 1 }, { text: '# 9O06522', x: 1, y: 30 }]);
check(wideIds.ids.join(',') === '9006522' && wideIds.items.length === 1, '全角/字母混淆的号也抽得到，且只算一件', wideIds);

// ── §2 引擎调用：失败分类、超时、坏输出、串行 ────────────────────────────────
console.log('§2 OCR 进程调用');
const baseDeps = () => ({
  fs,
  path,
  ROOT: tmp,
  STATE_DIR: tmp,
  log: (line) => logLines.push(String(line)),
  Buffer,
  safeResolveInside: (root, rel) => {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root))) throw new Error('outside');
    return abs;
  }
});
const noEngine = createLibraryOcr(baseDeps());
const rNo = await noEngine.ocrImageFile(path.join(tmp, 'a.png'));
check(rNo.ok === false && rNo.reason === 'no_deps' && /没有注入/.test(String(rNo.error)), '没注入 runPowerShell → no_deps（说清缺什么）', rNo);

const spawnFail = createLibraryOcr({ ...baseDeps(), runPowerShell: async () => ({ ok: false, error: 'powershell: not found' }) });
const rSpawn = await spawnFail.ocrImageFile(path.join(tmp, 'a.png'));
check(rSpawn.ok === false && rSpawn.reason === 'spawn', '进程起不来 → spawn', rSpawn.reason);

const badOut = createLibraryOcr({ ...baseDeps(), runPowerShell: async () => ({ ok: true, stdout: 'not json at all' }) });
const rBad = await badOut.ocrImageFile(path.join(tmp, 'a.png'));
check(rBad.ok === false && rBad.reason === 'bad_output', '输出不是 JSON → bad_output', rBad.reason);

const noLang = createLibraryOcr({
  ...baseDeps(),
  runPowerShell: async () => ({ ok: true, stdout: JSON.stringify({ ok: false, error: '这台机器没有可用的 OCR 语言包' }) })
});
const rNoLang = await noLang.ocrImageFile(path.join(tmp, 'a.png'));
check(rNoLang.ok === false && rNoLang.reason === 'no_ocr', '脚本报没有语言包 → no_ocr', rNoLang.reason);

let inflight = 0;
let maxInflight = 0;
const serial = createLibraryOcr({
  ...baseDeps(),
  runPowerShell: async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 15));
    inflight -= 1;
    return { ok: true, stdout: JSON.stringify({ ok: true, engine: 'en-US', langs: ['en-US'], lines: [{ text: 'Midnight Hug2', x: 1, y: 2 }] }) };
  }
});
const [s1, s2] = await Promise.all([serial.ocrImageFile(path.join(tmp, 'a.png')), serial.ocrImageFile(path.join(tmp, 'b.png'))]);
check(s1.ok && s2.ok, '并发两次都成功', [s1.ok, s2.ok]);
check(maxInflight === 1, '并发只跑一个 OCR', maxInflight);
check(s1.lines[0].text === 'Midnight Hug2' && s1.engine === 'en-US', '解析出 lines/engine', s1.lines?.[0]);

let probeCount = 0;
const probeDeps = {
  ...baseDeps(),
  runPowerShell: async () => {
    probeCount += 1;
    return { ok: true, stdout: JSON.stringify({ ok: true, engine: 'zh-Hans-CN', langs: ['en-US', 'zh-Hans-CN'], lines: [] }) };
  }
};
const statusSvc = createLibraryOcr(probeDeps);
const st1 = await statusSvc.ocrStatus();
const st2 = await statusSvc.ocrStatus();
check(st1.available === true && st1.langs.length === 2 && st1.engine === 'zh-Hans-CN', 'status 探活结果', st1);
check(probeCount === 1 && st2.checkedAt === st1.checkedAt, 'status 只探一次（缓存）', probeCount);
check(!fs.existsSync(path.join(tmp, OCR_TMP_DIRNAME, 'probe.png')), '探活图用完就删');

const noDepsSvc = createLibraryOcr({ ...baseDeps(), runPowerShell: undefined });
const stNoDeps = await noDepsSvc.ocrStatus();
check(stNoDeps.available === false && stNoDeps.reason === 'no_deps' && /没有注入/.test(String(stNoDeps.error)), '缺 runPowerShell → 状态报没注入（不是语言包）', stNoDeps);
check(logLines.some((line) => /\[OCR\] 探活 不可用/.test(line) && /没有注入|runPowerShell/.test(line)), '探活失败留可断言日志', logLines.slice(-1));

// ── §3 路由：dataURL / path / 大小上限 / 临时文件 / 暂停闸 / 状态 ─────────────
console.log('§3 截图路由');
const OCR_JSON = JSON.stringify({
  ok: true,
  engine: 'zh-Hans-CN',
  langs: ['en-US', 'zh-Hans-CN'],
  lines: LINES
});
const routeSvc = createLibraryOcr({
  ...baseDeps(),
  runPowerShell: async () => ({ ok: true, stdout: OCR_JSON })
});
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeReq(body, { readError = null } = {}) {
  const sent = [];
  return {
    sent,
    request: {
      readBody: async (opts) => {
        if (readError) throw readError;
        readCalls.push(opts && opts.maxBytes);
        return body;
      },
      sendJson: (payload, status = 200) => sent.push({ status, payload })
    }
  };
}
const readCalls = [];

const noImage = makeReq({});
await routeSvc.handlePurchasesOcr(noImage.request, makeApi());
check(noImage.sent[0].status === 400 && /image/.test(noImage.sent[0].payload.error), '没给图 400 说清要什么', noImage.sent[0]);

const OCR_TITLES = {
  '7547599': 'Midnight Hug2',
  '8991327': 'Milltinal',
  '9006522': 'Hana Capture Studio 2 ． 0',
  '9028816': 'CYCR ( Cyber Critter)'
};

function makeApi({ paused = false, failIds = [], titles = {} } = {}) {
  const calls = [];
  return {
    calls,
    pausedNow: () => (paused ? { paused: true, text: 'BOOTH 正在限速暂停，剩余 3 分钟' } : { paused: false }),
    // 只读：抓商品页拿候选；写台账/下封面一律不在这里做。
    fetchItem: async (boothId) => {
      calls.push(boothId);
      if (failIds.includes(boothId)) throw new Error('fixture: 商品页抓不到');
      return {
        ok: true,
        item: {
          boothId,
          title: titles[boothId] || OCR_TITLES[boothId] || `fixture-${boothId}`,
          shopName: '',
          priceText: '',
          itemUrl: `https://booth.pm/ja/items/${boothId}`,
          coverUrl: `https://booth.pximg.net/fixture-${boothId}.jpg`
        }
      };
    },
    coverInfo: (boothId, remoteUrl) => (remoteUrl
      ? { coverUrl: String(remoteUrl), coverRemote: true }
      : { coverUrl: '', coverRemote: false })
  };
}

const okReq = makeReq({ image: TINY_PNG });
const okApi = makeApi();
await routeSvc.handlePurchasesOcr(okReq.request, okApi);
const okPayload = okReq.sent[0].payload;
check(okReq.sent[0].status === 200 && okPayload.ok === true, 'dataURL 200', okReq.sent[0].status);
check(okPayload.hints.ids.length === 4 && okPayload.lines.length <= 40, 'hints 与 lines 预览', { ids: okPayload.hints.ids.length, lines: okPayload.lines.length });
check(okApi.calls.slice().sort().join(',') === '7547599,8991327,9006522,9028816', '逐号解析（每个号都解析了一次）', okApi.calls);
check(okPayload.items.length === 4 && okPayload.items.every((one) => one.enriched === true && one.title === OCR_TITLES[one.boothId]), 'items 来自商品页补资料（enriched:true）', okPayload.items.map((one) => one.title));
check(okPayload.items.every((one) => one.coverRemote === true && /^https:\/\//.test(one.coverUrl) && /\/items\//.test(one.itemUrl) && one.shopName === '' && one.priceText === ''), '候选带封面/商品页字段', okPayload.items[0]);
check(!('upsertOne' in okApi) && !('publicItem' in okApi) && !('loadState' in okApi), '只读预览：没有写台账/下封面的口子', Object.keys(okApi));
check(readCalls.every((n) => n === 12 * 1024 * 1024), 'OCR 路由放宽请求体上限到 12MB', readCalls[0]);
const leftover = fs.existsSync(path.join(tmp, OCR_TMP_DIRNAME))
  ? fs.readdirSync(path.join(tmp, OCR_TMP_DIRNAME)).filter((f) => f !== 'probe.png')
  : [];
check(leftover.length === 0, '临时截图用完不残留', leftover);

const big = Buffer.alloc(OCR_MAX_IMAGE_BYTES + 1, 1);
const bigReq = makeReq({ image: `data:image/png;base64,${big.toString('base64')}` });
await routeSvc.handlePurchasesOcr(bigReq.request, makeApi());
check(bigReq.sent[0].status === 413 && bigReq.sent[0].payload.error === '图太大了，裁一下再传', '超过 8MB → 413 人话', bigReq.sent[0]);

// 能解码但不是图片：必须在 OCR 之前拦成 400（前端按状态码走错误 toast，200 ok:false 会当成功处理）。
const junk = Buffer.from('this is definitely not an image, just plain text bytes');
const junkReq = makeReq({ image: `data:image/png;base64,${junk.toString('base64')}` });
await routeSvc.handlePurchasesOcr(junkReq.request, makeApi());
check(junkReq.sent[0].status === 400 && /截图格式不对/.test(junkReq.sent[0].payload.error), 'base64 能解码但不是图片 → 400 人话', junkReq.sent[0]);

const badMime = makeReq({ image: 'data:image/gif;base64,AAAA' });
await routeSvc.handlePurchasesOcr(badMime.request, makeApi());
check(badMime.sent[0].status === 400 && /png \/ jpg \/ webp/.test(badMime.sent[0].payload.error), 'gif 不收', badMime.sent[0].payload.error);

const outsideReq = makeReq({ path: '../outside.png' });
await routeSvc.handlePurchasesOcr(outsideReq.request, makeApi());
check(outsideReq.sent[0].status === 400 && /越出/.test(outsideReq.sent[0].payload.error), 'path 越界 400', outsideReq.sent[0].payload.error);

const missingPath = makeReq({ path: 'nope.png' });
await routeSvc.handlePurchasesOcr(missingPath.request, makeApi());
check(missingPath.sent[0].status === 400 && /找不到/.test(missingPath.sent[0].payload.error), 'path 不存在 400', missingPath.sent[0].payload.error);

const pausedReq = makeReq({ image: TINY_PNG });
const pausedApi = makeApi({ paused: true });
await routeSvc.handlePurchasesOcr(pausedReq.request, pausedApi);
check(pausedReq.sent[0].payload.paused === true && pausedApi.calls.length === 0, '暂停中不查商品页、如实回报', pausedReq.sent[0].payload.paused);

const partialReq = makeReq({ image: TINY_PNG });
const partialApi = makeApi({ failIds: ['8991327'] });
await routeSvc.handlePurchasesOcr(partialReq.request, partialApi);
const partialPayload = partialReq.sent[0].payload;
const partialItem = partialPayload.items.find((one) => one.boothId === '8991327');
check(partialPayload.ok === true && partialItem && partialItem.enriched === false, '抓不到商品页仍返回该条（enriched:false）', partialItem);
check(partialItem && partialItem.title === 'Milltinal', '抓不到时保留 OCR 标题', partialItem && partialItem.title);
check(partialPayload.errors.some((one) => one.boothId === '8991327'), '失败号进 errors', partialPayload.errors);

const failSvc = createLibraryOcr({ ...baseDeps(), runPowerShell: async () => ({ ok: false, error: 'timeout after 20000ms' }) });
const failReq = makeReq({ image: TINY_PNG });
await failSvc.handlePurchasesOcr(failReq.request, makeApi());
check(failReq.sent[0].status === 200 && failReq.sent[0].payload.ok === false && failReq.sent[0].payload.reason === 'spawn' && /启动 OCR/.test(failReq.sent[0].payload.error), 'OCR 进程失败 200 + 人话（不 500）', failReq.sent[0].payload);

// OCR 把 6 认成 5：7547599 抓不到，但 7547699 的页面标题对得上 → 自动纠正并标 correctedFrom。
const fixReq = makeReq({ image: TINY_PNG });
const fixApi = makeApi({ failIds: ['7547599'], titles: { '7547699': 'Midnight Hug' } });
await routeSvc.handlePurchasesOcr(fixReq.request, fixApi);
const fixedItem = (fixReq.sent[0].payload.items || []).find((one) => one.boothId === '7547699');
check(Boolean(fixedItem) && fixedItem.enriched === true && fixedItem.correctedFrom === '7547599', '6 认成 5 时按近邻号纠正', fixedItem);
check(fixApi.calls.includes('7547699') && !(fixReq.sent[0].payload.items || []).some((one) => one.boothId === '7547599'), '纠正后预览里只有新号', fixReq.sent[0].payload.items.map((one) => one.boothId));

// 近邻号存在，但页面标题跟截图标题不相似（7547599 真的是另一个商品「憤懣」）→ 不纠正、标 uncertain。
const oddReq = makeReq({ image: TINY_PNG });
const oddApi = makeApi({ titles: { '7547599': '憤懣' } });
await routeSvc.handlePurchasesOcr(oddReq.request, oddApi);
const oddItems = oddReq.sent[0].payload.items || [];
const oddItem = oddItems.find((one) => one.boothId === '7547599');
check(Boolean(oddItem) && oddItem.uncertain === true && !oddItem.correctedFrom, '标题不相似：不纠正且标 uncertain:true', oddItem);
check(!oddItems.some((one) => one.correctedFrom), '标题不相似时不换号（宁可让用户二次确认）', oddItems.map((one) => one.boothId));

const okItemsUncertain = (okReq.sent[0].payload.items || []).some((one) => one.uncertain);
check(okItemsUncertain === false, '正常对得上的商品不带 uncertain', okReq.sent[0].payload.items.map((one) => one.uncertain));

// OCR 把 Bob 读成 80b（字母数字互认）：归一化后仍算同一款，不纠正也不报警。
const confuseSvc = createLibraryOcr({
  ...baseDeps(),
  runPowerShell: async () => ({ ok: true, stdout: JSON.stringify({ ok: true, engine: 'en-US', langs: ['en-US'], lines: [{ text: 'Twin 80b', x: 10, y: 10 }, { text: '# 8965459', x: 10, y: 40 }] }) })
});
const confuseReq = makeReq({ image: TINY_PNG });
await confuseSvc.handlePurchasesOcr(confuseReq.request, makeApi({ titles: { '8965459': 'Half Twin Bob' } }));
const confuseItem = (confuseReq.sent[0].payload.items || [])[0];
check(Boolean(confuseItem) && confuseItem.boothId === '8965459' && confuseItem.uncertain !== true, '字母数字互认（80b≈Bob）不误报 uncertain', confuseItem && { id: confuseItem.boothId, uncertain: confuseItem.uncertain });

// OCR 标题本身是噪声（"F 黾 n 巴" 其实是 Mimuette 被读碎）：不据此改号，也不标 uncertain。
const garbledSvc = createLibraryOcr({
  ...baseDeps(),
  runPowerShell: async () => ({ ok: true, stdout: JSON.stringify({ ok: true, engine: 'en-US', langs: ['en-US'], lines: [{ text: 'F 黾 n 巴', x: 10, y: 10 }, { text: '# 9028816', x: 10, y: 40 }] }) })
});
const garbledReq = makeReq({ image: TINY_PNG });
await garbledSvc.handlePurchasesOcr(garbledReq.request, makeApi({ titles: { '9028816': 'Mimuette' } }));
const garbledItem = (garbledReq.sent[0].payload.items || [])[0];
check(Boolean(garbledItem) && garbledItem.uncertain !== true, 'OCR 标题是噪声时不误报 uncertain', garbledItem && { ocrTitle: garbledItem.ocrTitle, uncertain: garbledItem.uncertain });

const statusReq = makeReq({});
await statusSvc.handlePurchasesOcrStatus(statusReq.request);
check(statusReq.sent[0].status === 200 && statusReq.sent[0].payload.ok === true && statusReq.sent[0].payload.available === true && statusReq.sent[0].payload.engine === 'zh-Hans-CN', 'status 路由字段', statusReq.sent[0].payload);

const noTitleReq = makeReq({ image: TINY_PNG });
const titleOnlySvc = createLibraryOcr({
  ...baseDeps(),
  runPowerShell: async () => ({ ok: true, stdout: JSON.stringify({ ok: true, engine: 'en-US', langs: ['en-US'], lines: [{ text: 'Midnight Hug2', x: 10, y: 10 }] }) })
});
await titleOnlySvc.handlePurchasesOcr(noTitleReq.request, makeApi());
check(noTitleReq.sent[0].payload.hints.titles.includes('Midnight Hug2') && noTitleReq.sent[0].payload.items.length === 0 && /标题/.test(noTitleReq.sent[0].payload.message), '只有标题时回标题提示', noTitleReq.sent[0].payload.message);

const readFail = makeReq({}, { readError: Object.assign(new Error('请求体过大（超过 12MB）'), { statusCode: 413 }) });
await routeSvc.handlePurchasesOcr(readFail.request, makeApi());
check(readFail.sent[0].status === 413, '请求体读爆 → 413 透传', readFail.sent[0]);

assert.ok(passed + failed > 0);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n========== 通过 ${passed} / 失败 ${failed} ==========`);
process.exitCode = failed ? 1 : 0;
