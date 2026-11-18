// 表情库「收录标准」的单测：只看文件头 + 媒体标记，不解码像素。
// 这里用现造的图片头做样本（不依赖真实缓存文件），每条断言都对应一条判定分支。
import { readImageMeta, shouldAutoCollectSticker, STICKER_COLLECT_MAX_EDGE } from '../src/sticker-collect-rules.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
}
function png(width, height, colorType = 6, extraBytes = 0) {
  const buf = Buffer.alloc(33 + extraBytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;          // bit depth
  buf[25] = colorType;  // 6 = RGBA（有 alpha），2 = RGB
  return buf;
}
function gif(width, height, frames = 1) {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  // 每个图片描述符 0x2C 算一帧；帧之间垫 0x00（不能用 0x2C，否则会被当成更多帧）
  const parts = [];
  for (let i = 0; i < frames; i += 1) parts.push(Buffer.from([0x2c]), Buffer.alloc(8, 0x00));
  return Buffer.concat([head, ...parts]);
}
function jpeg(width, height) {
  // SOI + APP0(最小) + SOF0（宽高在 SOF 段 +7/+5 处）
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

// ── 文件头解析 ──────────────────────────────────────────────────────────────
{
  const meta = readImageMeta(png(64, 48, 6));
  check('PNG 宽高/alpha', meta?.format === 'PNG' && meta.width === 64 && meta.height === 48 && meta.alpha === true);
  check('PNG 无 alpha 认得出', readImageMeta(png(64, 48, 2))?.alpha === false);
  const g = readImageMeta(gif(320, 240, 3));
  check('GIF 宽高 + 动图', g?.format === 'GIF' && g.width === 320 && g.height === 240 && g.animated === true);
  check('GIF 单帧不是动图', readImageMeta(gif(320, 240, 1))?.animated === false);
  const j = readImageMeta(jpeg(1080, 1920));
  check('JPEG 宽高', j?.format === 'JPEG' && j.width === 1080 && j.height === 1920);
  check('脏数据解析成 null', readImageMeta(Buffer.from('not an image at all, really not')) === null);
  check('太短的数据不崩', readImageMeta(Buffer.from([1, 2, 3])) === null);
}

// ── 协议标记优先：表情段无条件收 ────────────────────────────────────────────
{
  const big = readImageMeta(jpeg(1080, 1920));
  check('kind=sticker 即使像截图也收', shouldAutoCollectSticker({ media: { kind: 'sticker' }, meta: big, bytes: 900000 }).ok === true);
  check('subType=1 收', shouldAutoCollectSticker({ media: { kind: 'image', subType: '1' }, meta: big, bytes: 900000 }).ok === true);
  check('emojiId 收', shouldAutoCollectSticker({ media: { kind: 'image', emojiId: 'abc' }, meta: big, bytes: 900000 }).ok === true);
  check('表情标记的 reason', shouldAutoCollectSticker({ media: { kind: 'sticker' }, meta: big, bytes: 1 }).reason === '表情标记');
}

// ── 普通图片：只收像表情的 ──────────────────────────────────────────────────
{
  const caseOf = (name, { media = { kind: 'image' }, meta, bytes = 0 }, want) => {
    const got = shouldAutoCollectSticker({ media, meta, bytes });
    check(name, got.ok === want, `${got.ok} / ${got.reason}`);
  };
  caseOf('小图（≤420）收', { meta: readImageMeta(png(300, 300, 2)), bytes: 300 * 300 * 3 }, true);
  caseOf('中等动图（≤700）收', { meta: readImageMeta(gif(500, 500, 3)), bytes: 90000 }, true);
  caseOf('中等透明 PNG 收', { meta: readImageMeta(png(600, 600, 6)), bytes: 40000 }, true);
  caseOf('大透明图（>700 且不扁平）不收', { meta: readImageMeta(png(900, 900, 6)), bytes: 400000 }, false);
  caseOf('1080x1920 手机截图不收', { meta: readImageMeta(jpeg(1080, 1920)), bytes: 300000 }, false);
  caseOf('2560x1440 桌面截图不收', { meta: readImageMeta(jpeg(2560, 1440)), bytes: 500000 }, false);
  caseOf('2376x980 长条截图不收', { meta: readImageMeta(png(2376, 980, 2)), bytes: 400000 }, false);
  caseOf('300x1200 竖长图不收', { meta: readImageMeta(jpeg(300, 1200)), bytes: 90000 }, false);
  caseOf('1080x1080 照片不收', { meta: readImageMeta(jpeg(1080, 1080)), bytes: 400000 }, false);
  caseOf('1080x1080 即使很扁也不收（超过扁平上限 1000）', { meta: readImageMeta(png(1080, 1080, 2)), bytes: 20000 }, false);
  caseOf('1000x1000 扁平图形收', { meta: readImageMeta(png(1000, 1000, 2)), bytes: 40000 }, true);
  caseOf('读不出尺寸不收', { meta: null, bytes: 100 }, false);
  caseOf('未知格式不收', { meta: readImageMeta(Buffer.from('garbage-garbage-garbage')), bytes: 100 }, false);
  caseOf('视频段不收', { media: { kind: 'video' }, meta: readImageMeta(jpeg(320, 240)), bytes: 5000 }, false);
  caseOf('空 meta 不收', {}, false);
}

// ── 边界与健壮性 ────────────────────────────────────────────────────────────
{
  check('完全不传参数不崩', shouldAutoCollectSticker().ok === false);
  check('小图阈值是 420', STICKER_COLLECT_MAX_EDGE === 420);
  const edge = readImageMeta(jpeg(STICKER_COLLECT_MAX_EDGE, STICKER_COLLECT_MAX_EDGE));
  check('正好 420 的小图收', shouldAutoCollectSticker({ media: { kind: 'image' }, meta: edge, bytes: 100000 }).ok === true);
  const over = readImageMeta(jpeg(1500, 1500));
  check('超过 1400 一定不收（即使密度低）', shouldAutoCollectSticker({ media: { kind: 'image' }, meta: over, bytes: 1000 }).ok === false);
}

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`  FAIL ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`\n========== 通过 ${results.length - failed.length} / 失败 ${failed.length} ==========`);
if (failed.length) process.exit(1);
