// 表情库「图片已失效」回归测试（离线，不依赖 config.json / 网络）。
//
// 线上事故：运维面板表情注释页出现 **4 张「图片已失效」**。根因两条：
// 1) 收集表情时用 `url.slice(-24)` 生成 id —— 多媒体下载链接尾部相同，
//    4 张不同表情共用一个 id；缩略图接口只 find 第一条，第一条链接过期 ⇒ 四张全废。
// 2) 「只有 url、没有 md5」的条目缩略图完全依赖会过期的 QQ 直链，且成功后也不回填 md5/缓存。
// 本测试钉住修复后的纯函数语义（id 唯一、md5 回填、同 id 全候选）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectSticker,
  md5Hex,
  stickerCandidates,
  backfillStickerMd5
} from '../src/sticker-lib.js';
import { createConsoleMediaTools } from '../src/bridge/console/media-tools.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

console.log('[1] 收集表情的 id 不能再撞车');
check('不同 url（尾部相同）→ 不同 id', () => {
  const entries = [];
  const a = collectSticker(entries, {
    url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=AAA&rkey=1',
    source: '观察群 100000005'
  });
  const b = collectSticker(entries, {
    url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=BBB&rkey=1',
    source: '观察群 100000005'
  });
  assert.ok(a && b);
  assert.notEqual(a.id, b.id, '旧实现按 url 尾部 24 字符会把两张收成同一个 id');
  assert.equal(a.source, '观察群 100000005');
  assert.equal(entries.length, 2);
});
check('同 md5 仍按内容去重（不重复收）', () => {
  const entries = [];
  const md5 = 'A'.repeat(32);
  const a = collectSticker(entries, { md5, source: '观察群 1' });
  const b = collectSticker(entries, { md5, url: 'https://x.invalid/a', source: '观察群 1' });
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(entries.length, 1);
});

console.log('[2] md5 回填（缩略图/修复接口拿到字节后）');
check('md5Hex：大写 32 位；空 buffer 返回空串', () => {
  assert.match(md5Hex(Buffer.from('abc')), /^[0-9A-F]{32}$/);
  assert.equal(md5Hex(Buffer.alloc(0)), '');
});
check('只回填空值，且 url 必须匹配（防串图）', () => {
  const entries = [
    { id: 'c_1', url: 'https://x.invalid/a', md5: '' },
    { id: 'c_2', url: 'https://x.invalid/b', md5: 'B'.repeat(32) }
  ];
  const digest = md5Hex(Buffer.from('abc'));
  assert.equal(backfillStickerMd5(entries, { id: 'c_1', md5: digest, url: 'https://x.invalid/a' }), true);
  assert.equal(entries[0].md5, digest);
  // 已有 md5 不覆盖
  assert.equal(backfillStickerMd5(entries, { id: 'c_2', md5: digest, url: 'https://x.invalid/b' }), false);
  assert.equal(entries[1].md5, 'B'.repeat(32));
  // id 相同但 url 不同（历史撞车数据）不能串
  assert.equal(backfillStickerMd5(entries, { id: 'c_1', md5: digest, url: 'https://x.invalid/zzz' }), false);
  // 非法摘要拒绝
  assert.equal(backfillStickerMd5(entries, { id: 'c_1', md5: 'zzz' }), false);
});

console.log('[3] 缩略图按同 id 逐个候选（4 张共用 id 时的关键）');
check('stickerCandidates 返回同 id 全部条目，保持原顺序', () => {
  const list = [{ id: 'x', md5: '' }, { id: 'x', md5: 'AA' }, { id: 'y' }];
  const cands = stickerCandidates(list, 'x');
  assert.equal(cands.length, 2);
  assert.equal(cands[0], list[0]);
  assert.equal(cands[1], list[1]);
  assert.deepEqual(stickerCandidates(list, 'none'), []);
});

console.log('[4] 缩略图路由的缓存头（同源 bug：小写 cache-control 被 SECURITY_HEADERS 的 no-store 顶掉）');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-thumb-cache-'));
  const cacheDir = path.join(tmp, 'sticker-files');
  fs.mkdirSync(cacheDir, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(cacheDir, 'AAAA1111.img'), png);
  const entries = [{ id: 'demo-a', md5: 'AAAA1111', url: 'https://x.invalid/a' }];
  const tools = createConsoleMediaTools({
    path, fs, STATE_DIR: tmp, stickerEntries: entries,
    stickerCandidates, md5Hex,
    mimeFromBuffer: () => 'image/png'
  });
  const callThumb = (id) => new Promise((resolve) => {
    const res = {
      writeHead(status, headers = {}) { this._code = status; this._headers = headers; },
      end(chunk) { resolve({ code: this._code, headers: this._headers || {}, body: chunk }); }
    };
    tools.handleConsoleMediaTools({
      req: { method: 'GET', headers: {} },
      url: new URL('http://x/api/stickers/thumbnail?id=' + encodeURIComponent(id)),
      res,
      // 真实 console-server 注入的安全头就带这个，不照抄验不出覆盖关系。
      SECURITY_HEADERS: { 'x-frame-options': 'DENY', 'Cache-Control': 'no-store' },
      sendJson: (payload, code) => resolve({ code: code || 200, headers: {}, body: JSON.stringify(payload) })
    });
  });
  const hit = await callThumb('demo-a');
  check('本地缓存命中 → 200 + image/png + 字节一致', () => {
    assert.equal(hit.code, 200);
    assert.equal(hit.headers['content-type'], 'image/png');
    assert.deepEqual([...hit.body], [...png]);
  });
  check('Cache-Control 只有一个且是公共长缓存（不被全局 no-store 抹掉）', () => {
    const keys = Object.keys(hit.headers).filter((k) => k.toLowerCase() === 'cache-control');
    assert.equal(keys.length, 1, JSON.stringify(hit.headers));
    assert.equal(hit.headers['Cache-Control'], 'public, max-age=86400');
  });
  const miss = await callThumb('nope');
  check('id 不存在 → 404 + 人话', () => {
    assert.equal(miss.code, 404);
    assert.match(String(JSON.parse(miss.body).error), /找不到该表情/);
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
