// 生图 provider 适配层的离线单测（不联网、不打真实 API）。
import assert from 'node:assert/strict';
import {
  IMAGEGEN_DEFAULT_ENDPOINT,
  buildOpenAIImageRequest,
  buildTemplateUrl,
  describeImagegenError,
  imagegenCfg,
  parseOpenAIImageResponse,
  describeUrlForLog,
  needsTranslation,
  sanitizeTranslatedPrompt,
  translateImagePrompt,
  redactSecret,
  resolveImageBuffer
} from '../src/imagegen.js';

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} — ${error?.message ?? error}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (error) { failed += 1; console.error(`❌ ${name} — ${error?.message ?? error}`); }
}

// ── 配置规范化 ─────────────────────────────────────────────────────────────
check('缺省配置 → url-template + pollinations，行为与旧版一致', () => {
  const c = imagegenCfg({});
  assert.equal(c.mode, 'url-template');
  assert.equal(c.endpoint, IMAGEGEN_DEFAULT_ENDPOINT);
  assert.equal(c.enabled, true);
  assert.equal(c.cooldownMs, 45000);
  assert.equal(c.maxPerHour, 10);
});
check('mode 写错 → 回落 url-template（不让一条坏配置把出图打死）', () => {
  assert.equal(imagegenCfg({ imagegen: { mode: 'whatever' } }).mode, 'url-template');
});
check('openai-image 配置被接受，baseUrl 去掉尾部斜杠', () => {
  const c = imagegenCfg({ imagegen: { mode: 'openai-image', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-x', model: 'flux' } });
  assert.equal(c.mode, 'openai-image');
  assert.equal(c.baseUrl, 'https://api.example.com/v1');
});

// ── url-template ───────────────────────────────────────────────────────────
check('url-template：{prompt} 被替换并做 URL 编码', () => {
  const url = buildTemplateUrl('https://x/p/{prompt}?w=1', '猫 猫 & 狗');
  assert.equal(url, `https://x/p/${encodeURIComponent('猫 猫 & 狗')}?w=1`);
  assert.ok(!url.includes('{prompt}'));
});

// ── openai-image 请求构造 ──────────────────────────────────────────────────
check('openai-image：Bearer 头 + body 字段齐全', () => {
  const req = buildOpenAIImageRequest(imagegenCfg({ imagegen: { mode: 'openai-image', baseUrl: 'https://api.x/v1', apiKey: 'sk-abc', model: 'flux-1', size: '768x768' } }), '一只猫');
  assert.equal(req.url, 'https://api.x/v1/images/generations');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, 'Bearer sk-abc');
  assert.equal(req.body.prompt, '一只猫');
  assert.equal(req.body.size, '768x768');
  assert.equal(req.body.n, 1);
  assert.equal(req.body.response_format, 'b64_json');
  assert.equal(req.body.model, 'flux-1');
});
check('openai-image：未配 baseUrl 直接抛错（快速失败，不发请求）', () => {
  assert.throws(() => buildOpenAIImageRequest(imagegenCfg({ imagegen: { mode: 'openai-image' } }), 'x'), /baseUrl/);
});

// ── 响应解析 ───────────────────────────────────────────────────────────────
check('解析 b64_json → buffer', () => {
  const buf = Buffer.from('hello');
  const r = parseOpenAIImageResponse({ data: [{ b64_json: buf.toString('base64') }] });
  assert.equal(r.kind, 'b64');
  assert.equal(r.buffer.toString(), 'hello');
});
check('解析 url → 待下载地址', () => {
  const r = parseOpenAIImageResponse({ data: [{ url: 'https://cdn.x/a.png' }] });
  assert.deepEqual(r, { kind: 'url', url: 'https://cdn.x/a.png' });
});
check('两者都没有 → none（调用方报 502）', () => {
  assert.equal(parseOpenAIImageResponse({ data: [{}] }).kind, 'none');
  assert.equal(parseOpenAIImageResponse({}).kind, 'none');
});

// ── key 打码 ───────────────────────────────────────────────────────────────
check('错误文本里的 apiKey 被打码', () => {
  const secret = 'sk-verysecret-123456';
  const out = redactSecret(`请求失败：key=${secret} 无效`, secret);
  assert.ok(!out.includes(secret), '不得残留原文');
  assert.ok(out.includes('***'));
});
check('失败分类：429 / 401 / 超时 → 可操作提示，且都不含 key', () => {
  const secret = 'sk-verysecret-123456';
  const a = describeImagegenError(429, 'rate limited', secret);
  const b = describeImagegenError(401, `bad key ${secret}`, secret);
  const c = describeImagegenError(0, 'The operation was aborted due to timeout', secret);
  assert.equal(a.status, 429);
  assert.match(a.error, /限流|配额|冷却/);
  assert.equal(b.status, 502);
  assert.match(b.error, /apiKey/);
  assert.equal(c.status, 504);
  assert.match(c.error, /超时/);
  for (const r of [a, b, c]) assert.ok(!r.error.includes(secret), `提示里不得出现 key：${r.error}`);
});

// ── resolveImageBuffer 端到端（注入假 fetch）──────────────────────────────
await checkAsync('url-template 模式：走注入的 safeFetchBuffer，返回字节', async () => {
  let seen = '';
  const out = await resolveImageBuffer({ imagegen: {} }, '一只猫', {
    safeFetchBuffer: async (url) => { seen = url; return { buffer: Buffer.from('img'), contentType: 'image/png' }; }
  });
  assert.equal(out.ok, true);
  assert.equal(out.source, 'url-template');
  assert.equal(out.buffer.toString(), 'img');
  assert.ok(seen.includes(encodeURIComponent('一只猫')));
});
await checkAsync('openai-image 模式：b64 路径直接拿字节，不打第二跳', async () => {
  let bufCalls = 0;
  const out = await resolveImageBuffer(
    { imagegen: { mode: 'openai-image', baseUrl: 'https://api.x/v1', apiKey: 'sk-1' } },
    '猫',
    {
      safeFetchBuffer: async () => { bufCalls += 1; return { buffer: Buffer.from('unused') }; },
      safeFetchJson: async (url, opts) => {
        assert.equal(url, 'https://api.x/v1/images/generations');
        assert.equal(opts.headers.authorization, 'Bearer sk-1');
        return { data: [{ b64_json: Buffer.from('from-b64').toString('base64') }] };
      }
    }
  );
  assert.equal(out.ok, true);
  assert.equal(out.source, 'openai-image:b64');
  assert.equal(out.buffer.toString(), 'from-b64');
  assert.equal(bufCalls, 0, 'b64 路径不应再下载 url');
});
await checkAsync('openai-image 模式：url 路径必须再过 safeFetchBuffer（SSRF 不绕过）', async () => {
  let fetchedUrl = '';
  const out = await resolveImageBuffer(
    { imagegen: { mode: 'openai-image', baseUrl: 'https://api.x/v1', apiKey: 'sk-1' } },
    '猫',
    {
      safeFetchBuffer: async (url) => { fetchedUrl = url; return { buffer: Buffer.from('from-url') }; },
      safeFetchJson: async () => ({ data: [{ url: 'https://cdn.x/a.png' }] })
    }
  );
  assert.equal(out.source, 'openai-image:url');
  assert.equal(fetchedUrl, 'https://cdn.x/a.png');
  assert.equal(out.buffer.toString(), 'from-url');
});
await checkAsync('openai-image 失败：HTTP 401 → 502 + 提示检查 apiKey，且不回显 key', async () => {
  const secret = 'sk-verysecret-123456';
  const out = await resolveImageBuffer(
    { imagegen: { mode: 'openai-image', baseUrl: 'https://api.x/v1', apiKey: secret } },
    '猫',
    {
      safeFetchBuffer: async () => ({ buffer: Buffer.from('x') }),
      safeFetchJson: async () => { const e = new Error(`HTTP 401: invalid ${secret}`); e.status = 401; throw e; }
    }
  );
  assert.equal(out.ok, false);
  assert.equal(out.status, 502);
  assert.ok(!out.error.includes(secret), '错误信息不得回显 key');
  assert.match(out.error, /apiKey/);
});
await checkAsync('通道关闭时直接返回 403，不发任何请求', async () => {
  let called = 0;
  const out = await resolveImageBuffer({ imagegen: { enabled: false } }, '猫', {
    safeFetchBuffer: async () => { called += 1; return { buffer: Buffer.from('x') }; }
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
  assert.equal(called, 0);
});

// ── 中文 → 英文提示词翻译（失败必须回退原文，不能把生图搞挂）──────────────
await checkAsync('纯中文提示词 → 走翻译并返回英文', async () => {
  const out = await translateImagePrompt({ prompt: '一只橘猫坐在窗台上，水彩风格', callModel: async () => 'an orange tabby cat on a windowsill, watercolor painting' });
  assert.equal(out.translated, true);
  assert.match(out.text, /orange tabby/);
});
await checkAsync('纯英文提示词 → 不调用翻译器（省一次调用）', async () => {
  let called = 0;
  const out = await translateImagePrompt({ prompt: 'a cat on a windowsill', callModel: async () => { called += 1; return 'x'; } });
  assert.equal(called, 0);
  assert.equal(out.translated, false);
  assert.equal(out.text, 'a cat on a windowsill');
});
await checkAsync('翻译超时 → 回退原文且流程继续', async () => {
  const out = await translateImagePrompt({ prompt: '一只猫', timeoutMs: 200, callModel: () => new Promise(() => {}) });
  assert.equal(out.translated, false);
  assert.equal(out.text, '一只猫');
  assert.match(out.reason, /超时|失败/);
});
await checkAsync('翻译抛错 → 回退原文', async () => {
  const out = await translateImagePrompt({ prompt: '一只猫', callModel: async () => { throw new Error('模型挂了'); } });
  assert.equal(out.text, '一只猫');
  assert.equal(out.translated, false);
});
await checkAsync('译文仍是中文 / 空串 → 视为失败，回退原文', async () => {
  const a = await translateImagePrompt({ prompt: '一只猫', callModel: async () => '一只橘色的猫' });
  const b = await translateImagePrompt({ prompt: '一只猫', callModel: async () => '   ' });
  assert.equal(a.translated, false);
  assert.equal(a.text, '一只猫');
  assert.equal(b.text, '一只猫');
});
check('译文清洗：单行、去引号、去「译文：」前缀', () => {
  assert.equal(sanitizeTranslatedPrompt('译文： "an orange cat, watercolor"\n多余的解释'), 'an orange cat, watercolor');
});
check('needsTranslation 能区分中英文', () => {
  assert.equal(needsTranslation('一只猫'), true);
  assert.equal(needsTranslation('a cat'), false);
});

// ── URL 只有 1 小时有效期：必须立刻下载、失败重试一次、日志不打完整 URL ────────
await checkAsync('url 路径下载失败 → 重试一次后仍失败则报错（不重新生成）', async () => {
  let bufCalls = 0;
  const out = await resolveImageBuffer(
    { imagegen: { mode: 'openai-image', baseUrl: 'https://api.x/v1', apiKey: 'sk-1' } },
    '猫',
    {
      safeFetchBuffer: async () => { bufCalls += 1; throw new Error('network wobble'); },
      safeFetchJson: async () => ({ data: [{ url: 'https://cdn.x/a.png?sign=abc' }] })
    }
  );
  assert.equal(bufCalls, 2, '下载应正好尝试 2 次（原始 + 1 次重试）');
  assert.equal(out.ok, false);
  assert.ok(!String(out.error).includes('sign=abc'), '错误文案不得带出签名参数');
});
await checkAsync('url 路径第一次失败、第二次成功 → 正常返回字节', async () => {
  let n = 0;
  const out = await resolveImageBuffer(
    { imagegen: { mode: 'openai-image', baseUrl: 'https://api.x/v1', apiKey: 'sk-1' } },
    '猫',
    {
      safeFetchBuffer: async () => { n += 1; if (n === 1) throw new Error('ECONNRESET'); return { buffer: Buffer.from('ok-2nd') }; },
      safeFetchJson: async () => ({ data: [{ url: 'https://cdn.x/a.png' }] })
    }
  );
  assert.equal(out.ok, true);
  assert.equal(out.buffer.toString(), 'ok-2nd');
});
check('describeUrlForLog 只留域名与长度，不带路径与签名', () => {
  const d = describeUrlForLog('https://cdn.siliconflow.cn/img/a.png?Expires=1&Signature=secret123');
  assert.ok(d.includes('cdn.siliconflow.cn'));
  assert.ok(!d.includes('secret123'), '不得带签名');
  assert.ok(!d.includes('/img/a.png'), '不得带路径');
});

if (failed) {
  console.error(`\n❌ 生图 provider 测试失败（${failed} 项）`);
  process.exit(1);
}
console.log('\n🎉 生图 provider 适配层测试通过');
