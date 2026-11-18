import { readBridgeSource, readBridgeSources } from './bridge-source.mjs';
import { readMcpSafeSource } from './mcp-safe-source.mjs';
// 表情包体系自检：
// 1) sticker-lib 纯函数（合并/查找/格式化/笔记/使用统计）
// 2) 配置项与 MCP 工具描述存在性
// 3) 可选 live 模式：QQ_BRIDGE_TEST_LIVE=1 时调用 SnowLuma 拉取收藏表情并验证 safeFetchBuffer 可抓图
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  dedupeStickerEntries,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  pickFreshStickerEntries,
  applyStickerNote,
  markStickerUsed,
  collectSticker,
  md5Hex,
  stickerCandidates,
  backfillStickerMd5,
  prepareStickerStoreBytes,
  persistStickerThumb,
  STICKER_SHRINK_OVER_BYTES
} from '../src/sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## sticker-lib 纯函数');
{
  const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
  ok(raw && raw.id === 'a' && raw.desc === '笑死' && raw.localNote === '嘲讽', 'normalizeStickerEntry 基本字段');
  ok(normalizeStickerEntry({}) === null, '空记录返回 null');
}

{
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' }
  ]);
  ok(base.length === 2, 'merge 新增两条');
  const merged = mergeStickerLibrary(base, [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }
  ]);
  ok(merged.length === 1, 'merge 会移除 QQ 端已删除的表情');
  ok(merged[0].id === 'a' && merged[0].url === 'https://x/a2' && merged[0].desc === '笑哭', 'merge 更新 QQ 字段');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }
  ]);
  ok(findSticker(list, 'a')?.id === 'a', '按 emoji_id 查找');
  ok(findSticker(list, 'abc')?.id === 'a', '按 md5 大小写不敏感查找');
  ok(findSticker(list, 'https://x/b')?.id === 'b', '按 URL 查找');
  ok(findSticker(list, '不存在') === null, '找不到返回 null');
}

{
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', md5: 'GHI', desc: '', localNote: '无语' })
  ];
  const all = formatStickerList(list, '', 10);
  ok(all.total === 3 && all.stickers.length === 3, 'formatStickerList 总数');
  const q = formatStickerList(list, '生气', 10);
  ok(q.matched === 1 && q.stickers[0].id === 'b', 'formatStickerList 按备注搜索');
  const q2 = formatStickerList(list, '无语', 10);
  ok(q2.matched === 1 && q2.stickers[0].id === 'c', 'formatStickerList 按本地笔记搜索');
  // 默认 policy 是 understand-only（管理员没批过就不让发），要发给模型看的上下文只收 usable 的。
  // 以前这里靠「默认 usable」蒙过去，默认值改严之后这条断言就假失败了——改成显式给 policy。
  const usableList = list.map((e) => ({ ...e, policy: 'usable' }));
  const ctx = buildStickerContext(usableList, 8);
  ok(ctx.includes('笑死') && ctx.includes('生气'), 'buildStickerContext 包含备注');
  ok(!buildStickerContext(list, 8).includes('笑死'), '没标可用的表情不进「可以发」的上下文');
  ok(buildStickerStrategyHint().includes('qq_send_sticker'), '策略提示包含发送工具');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }
  ]);
  const noted = applyStickerNote(list, 'a', { note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
  ok(noted.entry.localNote === '嘲讽用' && noted.entry.tags.includes('怼人'), 'applyStickerNote 写入本地认知');
  const used = markStickerUsed(noted.entries, 'a', '接梗');
  ok(used.entry.useCount === 1 && used.entry.lastContext === '接梗', 'markStickerUsed 记录使用');
}

console.log('## 配置文件');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const tools = cfg.socialV2?.tools ?? {};
  ok(tools.listStickers === true, 'config listStickers=true');
  ok(tools.getStickerImage === true, 'config getStickerImage=true');
  ok(tools.sendSticker === true, 'config sendSticker=true');
  ok(tools.stickerNote === true, 'config stickerNote=true');
  ok(tools.setStickerRemark === false, 'config setStickerRemark=false（默认禁用）');
  ok(cfg.socialV2?.sticker?.enabled === true, 'config sticker.enabled=true');
  ok(!('sendCaptionMaxChars' in (cfg.socialV2?.sticker ?? {})), 'config sticker 不再包含 sendCaptionMaxChars');
}

console.log('## 表情单气泡约束');
{
  const mcp = readMcpSafeSource();
  const sendStickerBlock = mcp.slice(mcp.indexOf("'qq_send_sticker'"), mcp.indexOf("'qq_sticker_note'"));
  ok(!sendStickerBlock.includes('message: z.string()'), 'qq_send_sticker MCP 不再接受 message 参数');
  ok(sendStickerBlock.includes('不能在同一气泡里附带文字'), 'qq_send_sticker 描述强调单气泡');
  const hint = buildStickerStrategyHint();
  ok(hint.includes('不能在同一气泡里附带文字'), '策略提示禁止同气泡混文字');
  ok(!hint.includes('先发一句话再发一张'), '策略提示不再引导“先发一句话再发一张”');
}

console.log('## MCP 工具描述存在性');
{
  const mcp = readMcpSafeSource();
  for (const name of ['qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_sticker_note', 'qq_set_sticker_remark']) {
    ok(mcp.includes(`'${name}'`) || mcp.includes(`"${name}"`), `MCP 工具 ${name} 已注册`);
  }
}

console.log('## bridge 路由/函数存在性');
{
  // ④ 重构后 /api/socialV2/sticker-image 等路由字面量搬进了 console 模块，按职责范围搜。
  const bridge = readBridgeSources();
  for (const s of ['/api/socialV2/sticker-list', '/api/socialV2/sticker-image', '/api/socialV2/sticker-note', '/api/socialV2/send-sticker', '/api/socialV2/sticker-remark', '/api/stickers', 'syncStickerLibrary', 'sendStickerV2']) {
    ok(bridge.includes(s), `bridge 包含 ${s}`);
  }
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：SnowLuma 收藏表情链路');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const res = await fetch(`${base}/fetch_custom_face_detail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 5 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    ok(res.ok && body.status === 'ok' && body.retcode === 0, 'fetch_custom_face_detail 调用成功');
    const items = Array.isArray(body.data) ? body.data : [];
    ok(items.length > 0, `返回 ${items.length} 个收藏表情`);
    if (items.length > 0) {
      const { safeFetchBuffer } = await import('../src/safe-fetch.js');
      try {
        const img = await safeFetchBuffer(items[0].url, 4 * 1024 * 1024);
        ok(img.buffer.length > 0, `可抓取表情图片字节（${img.buffer.length} bytes）`);
      } catch (e) {
        ok(false, `safeFetchBuffer 抓取表情失败: ${e.message}`);
      }
    }
  } catch (e) {
    ok(false, `live 链路异常: ${e.message}`);
  }
}

console.log('## 表情 id 唯一性 / md5 回填 / 同 id 候选（线上「四张图片已失效」回归）');
{
  const entries = [];
  const urlA = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=AAA&rkey=1';
  const urlB = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=BBB&rkey=1';
  const a = collectSticker(entries, { url: urlA, source: '观察群 100000002' });
  const b = collectSticker(entries, { url: urlB, source: '观察群 100000002' });
  ok(a && b && a.id !== b.id, '不同 url（尾部相同）不会生成同一个 id');
  ok(a && a.source === '观察群 100000002', '观察群来源保留在 source');
  const digest = md5Hex(Buffer.from('abc'));
  ok(/^[0-9A-F]{32}$/.test(digest), 'md5Hex 返回 32 位大写十六进制');
  ok(md5Hex(Buffer.alloc(0)) === '', '空 buffer 不算 md5');
  const changed = backfillStickerMd5(entries, { id: a.id, md5: digest, url: urlA });
  ok(changed && entries.find((e) => e.id === a.id).md5 === digest, '无 md5 的条目可以回填');
  ok(backfillStickerMd5(entries, { id: b.id, md5: digest, url: 'https://other.invalid/x' }) === false, 'url 不匹配不回填（防串图）');
  const sameId = [{ id: 'x', md5: '' }, { id: 'x', md5: 'AA' }, { id: 'y' }];
  const cands = stickerCandidates(sameId, 'x');
  ok(cands.length === 2, 'stickerCandidates 返回同 id 的全部候选（缩略图逐个尝试）');
}

// ── 「用过」与「别人发过」必须分开统计 ─────────────────────────────────
// 2026-10-28 的 bug：别人在群里发库里已有的表情时，代码给 useCount +1，
// 于是「不可用（只解读）」的表情也会显示「用过 N 次」。
{
  const fresh = normalizeStickerEntry({ id: 'a', md5: 'AA', useCount: '3', seenCount: '2' });
  ok(fresh.useCount === 3 && fresh.seenCount === 2, '归一化：useCount 与 seenCount 各自独立');
  ok(normalizeStickerEntry({ id: 'a' }).seenCount === 0, '归一化：缺省 seenCount 为 0');
  ok(normalizeStickerEntry({ id: 'a', seenCount: -5 }).seenCount === 0, '归一化：seenCount 不接受负数');

  const used = markStickerUsed([{ id: 'a', md5: 'AA', seenCount: 4 }], 'a', 'sticker').entry;
  ok(used.useCount === 1 && used.seenCount === 4, '发出去只涨 useCount，不动 seenCount');

  const merged = dedupeStickerEntries([
    { id: 'a', md5: 'AA', localNote: '甲', useCount: 1, seenCount: 2, policy: 'usable' },
    { id: 'b', md5: 'AA', localNote: '乙', useCount: 2, seenCount: 3 }
  ]);
  const only = merged.find((e) => String(e.md5 || '').toUpperCase() === 'AA');
  ok(!!only && only.useCount === 3, '合并重复条目后 useCount 求和', only && String(only.useCount));
  ok(!!only && only.seenCount === 5, '合并重复条目后 seenCount 也求和', only && String(only.seenCount));

  // 收集路径（别人发过）不许再碰 useCount：静态守住 incoming-media 的写法
  const incoming = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'incoming-media.js'), 'utf8');
  ok(!/hit\.useCount\s*=/.test(incoming), '收集路径不再给 useCount 加数');
  ok(/hit\.seenCount\s*=\s*\(Number\(hit\.seenCount\) \|\| 0\) \+ 1;/.test(incoming), '收集路径改涨 seenCount');
  ok(!/hit\.lastUsedAt\s*=/.test(incoming), '收集路径不写 lastUsedAt（那不是「用过」的时间）');
}
console.log('## 大图落盘前缩图（「缩略图不可用」那类几 MB 的动图）');
{
  // 真实场景：QQ 里 8~14MB 的动图表情，2MB 下载上限时代全被判 missing。
  const big = Buffer.alloc(STICKER_SHRINK_OVER_BYTES + 1024, 7);
  const smallJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2048, 3)]);
  const prepared = await prepareStickerStoreBytes(big, { shrinkImpl: async () => smallJpeg });
  ok(prepared.shrunk === true && prepared.bytes === smallJpeg, '大图缩成小图后再存');
  ok(prepared.digest === md5Hex(big), 'md5 仍按原图算（内容身份不变，去重照旧）');

  const tiny = Buffer.alloc(1024, 1);
  const kept = await prepareStickerStoreBytes(tiny, { shrinkImpl: async () => smallJpeg });
  ok(kept.shrunk === false && kept.bytes === tiny, '小图原样保存，不碰缩图器');

  const degraded = await prepareStickerStoreBytes(big, { shrinkImpl: async () => null });
  ok(degraded.shrunk === false && degraded.bytes === big, '缩图失败时退回原图（不能因此存不进去）');

  // persistStickerThumb 走同一条路：缓存文件是缩略图，条目 md5 是原图哈希
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-'));
  const entry = { id: 'x', url: 'https://example.test/a.gif' };
  const result = await persistStickerThumb(entry, {
    cacheDir: dir,
    fetchImpl: async () => big,
    shrinkImpl: async () => smallJpeg,
    dhashImpl: async () => 'dh1'
  });
  const cacheFile = path.join(dir, `${md5Hex(big).toUpperCase()}.img`);
  ok(result.status === 'ok' && fs.existsSync(cacheFile), '大图落盘成功且缓存名用原图 md5', result.status);
  ok(fs.statSync(cacheFile).size === smallJpeg.length && entry.thumbShrunk === true, '缓存里存的是缩略图（不是 8MB 原图）');
  ok(result.bytes === smallJpeg.length && result.sourceBytes === big.length, '返回值同时给出存盘大小与原图大小');
}

console.log('## 允许 AI 多发表情（策略常驻 + 每小时上限）');
{
  const hint = buildStickerStrategyHint();
  ok(/一轮最多 2 张/.test(hint), '策略里写明「一轮最多 2 张」', hint.slice(0, 20));
  ok(/1~2 轮就可以来一张/.test(hint), '频率更积极：普通闲聊 1~2 轮就可以来一张');
  ok(!/2~4 轮一张/.test(hint) && !/3~5 轮一张/.test(hint), '不再用旧的 2~4 / 3~5 轮一张口径');
  ok(/约八成/.test(hint), '别人回表情时回一张的比例提到约八成');
  ok(/新表情优先/.test(hint) && /还没发过/.test(hint), '策略里点名「新表情优先」（标了还没发过的先试）');

  const cfgLoad = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'config-load.js'), 'utf8');
  ok(/const STICKER_DEFAULTS = Object\.freeze\(\{/.test(cfgLoad), '默认值集中在 STICKER_DEFAULTS');
  ok(/alwaysInPrompt: true/.test(cfgLoad), '默认让表情策略常驻提示');
  ok(/promptMaxStickers: 14/.test(cfgLoad), '默认在提示里给 14 张常用表情');
  ok(/perHourMax: 30/.test(cfgLoad), '默认每小时最多 30 张（防跑飞，但别卡正常量）');
  ok((cfgLoad.match(/\.\.\.STICKER_DEFAULTS/g) || []).length >= 2, '两处默认块共用同一份默认值');

  const mediaSend = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'media-send.js'), 'utf8');
  ok(/function stickerQuota\(deps, key\)/.test(mediaSend), '发送前有小时配额检查');
  ok(/这一小时表情发得太多了/.test(mediaSend), '超额时给可读的拒绝原因');
  ok(/noteStickerSent\(key\);/.test(mediaSend), '发送成功后记账');
  const sendFn = mediaSend.slice(mediaSend.indexOf('async function sendStickerV2'));
  ok(sendFn.indexOf('if (!quota.allowed)') >= 0 && sendFn.indexOf('if (!quota.allowed)') < sendFn.indexOf('deps.markStickerUsed'), '配额检查在读/写统计之前');

  const socialCfg = fs.readFileSync(path.join(ROOT, 'src', 'bridge', 'console', 'social-config.js'), 'utf8');
  ok(/merged\.sticker\.perHourMax/.test(socialCfg) && /Math\.min\(120/.test(socialCfg), '控制台写配置时把 perHourMax 夹到 0~120');
}

console.log('## 首次可用的新表情（还没发过的优先）');
{
  const entries = [
    { id: 'old', desc: '老的熟图', policy: 'usable', useCount: 9, createdAt: '2026-10-01T00:00:00Z' },
    { id: 'fresh-new', desc: '刚收的新图', policy: 'usable', useCount: 0, createdAt: '2026-10-28T00:00:00Z' },
    { id: 'fresh-old', desc: '收了两周还没发过', policy: 'usable', useCount: 0, createdAt: '2026-10-01T00:00:00Z' },
    { id: 'understand', desc: '只解读不发的', policy: 'understand-only', useCount: 0 }
  ];
  const fresh = pickFreshStickerEntries(entries, { now: Date.parse('2026-10-29T00:00:00Z'), limit: 5 });
  ok(fresh.length === 2, '新表情只挑 usable 且一次没发过的（只解读的不算）', String(fresh.length));
  ok(fresh[0] && fresh[0].id === 'fresh-new', '最近新收的排在前面');
  ok(fresh.every((e) => (e.useCount || 0) === 0 && e.policy === 'usable'), '返回项确实都是没用过、可发的');

  const ctx = buildStickerContext([{ id: 'a', desc: '没发过的图', policy: 'usable', useCount: 0 }]);
  ok(/还没发过，可以试/.test(ctx), '表情清单里把「还没发过」标出来（而不是空着）');
  ok(/【新表情先试】/.test(ctx) && /没发过的图/.test(ctx), '清单末尾专门点出「新表情先试」并列出名字');
  const ctxUsed = buildStickerContext([{ id: 'b', desc: '熟图', policy: 'usable', useCount: 7 }]);
  ok(/用过7次/.test(ctxUsed) && !/【新表情先试】/.test(ctxUsed), '全都发过时不硬凑「新表情先试」这一行');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
