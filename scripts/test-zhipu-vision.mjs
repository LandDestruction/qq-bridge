// 智谱直连识图的单测：全部用假 fetch，不真的走网络，也不依赖 key。
// 覆盖：正常描述 / 400（该模型始终思考）/ 空 content（思考被截断）/ 没 key / 超时 / 提示词行格式。
import assert from 'node:assert/strict';
import { describeImageWithZhipu, describeLineForPrompt, zhipuVisionCfg } from '../src/zhipu-vision.js';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const cfg = { socialV2: { zhipu: { apiKey: 'k-123', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', visionModel: 'glm-5.3-flash' } } };
const buf = Buffer.from('fake-jpeg-bytes');
const fakeOk = (payload) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

console.log('[1] 配置解析');
{
  const c = zhipuVisionCfg(cfg);
  ok('去尾斜杠', c.baseUrl === 'https://open.bigmodel.cn/api/paas/v4');
  ok('默认模型', c.model === 'glm-5.3-flash');
  ok('有 key 视为启用', c.enabled === true);
  ok('visionEnabled:false 关闭', zhipuVisionCfg({ socialV2: { zhipu: { apiKey: 'k', visionEnabled: false } } }).enabled === false);
  ok('没 key 不启用', zhipuVisionCfg({ socialV2: {} }).enabled === false);
}

console.log('[2] 正常返回');
{
  const r = await describeImageWithZhipu({
    buffer: buf, mimeType: 'image/jpeg', cfg,
    fetchImpl: fakeOk({ choices: [{ finish_reason: 'stop', message: { content: '一只橘猫趴在键盘上，屏幕里是 QQ 群聊。' } }] }),
  });
  ok('ok=true', r.ok === true);
  ok('文本回传', r.text.includes('橘猫'), r.text);
  ok('带耗时', Number.isFinite(r.ms));
}

console.log('[3] 请求体参数（reasoning_effort，不能用 thinking）');
{
  let captured = null;
  const fetchSpy = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), headers: init.headers };
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '描述' } }] }) };
  };
  await describeImageWithZhipu({ buffer: buf, mimeType: 'image/png', cfg, fetchImpl: fetchSpy });
  ok('打到 /chat/completions', String(captured.url).endsWith('/chat/completions'), captured.url);
  ok('reasoning_effort=low', captured.body.reasoning_effort === 'low');
  ok('没有 thinking 字段', captured.body.thinking === undefined);
  ok('图片走 image_url data URL', captured.body.messages[0].content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));
  ok('Authorization 头', String(captured.headers.authorization) === 'Bearer k-123');
}

console.log('[4] 错误分支');
{
  const r400 = await describeImageWithZhipu({
    buffer: buf, mimeType: 'image/png', cfg,
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { code: '1210', message: '该模型始终思考，不支持关闭思考；请使用 low、high 或 max。' } }) }),
  });
  ok('400 带回智谱原文', r400.ok === false && r400.error.includes('该模型始终思考'), r400.error);

  const rEmpty = await describeImageWithZhipu({
    buffer: buf, mimeType: 'image/png', cfg,
    fetchImpl: fakeOk({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '思考中' } }] }),
  });
  ok('空 content → 判失败并带 finish_reason', rEmpty.ok === false && rEmpty.error.includes('length'), rEmpty.error);

  const rNoKey = await describeImageWithZhipu({ buffer: buf, cfg: { socialV2: {} }, fetchImpl: fakeOk({}) });
  ok('没 key 直接拒绝且不碰网络', rNoKey.ok === false && rNoKey.error.includes('key'));

  const rThrow = await describeImageWithZhipu({ buffer: buf, cfg, fetchImpl: async () => { const e = new Error('boom'); e.name = 'TimeoutError'; throw e; } });
  ok('异常编号成「超时」前缀', rThrow.ok === false && rThrow.error.includes('超时'), rThrow.error);

  const rEmptyBuf = await describeImageWithZhipu({ buffer: Buffer.alloc(0), cfg, fetchImpl: fakeOk({}) });
  ok('空图不请求', rEmptyBuf.ok === false && rEmptyBuf.error.includes('没有图片'));
}

console.log('[5] 提示词行');
{
  const line = describeLineForPrompt('[图片1]', '一只猫坐在键盘上');
  ok('标明是转述、不是模型自己看到', line.includes('画面描述') && line.includes('不是你自己看到的'), line);
  ok('保留标签', line.startsWith('[图片1]'), line);
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
if (fail) process.exitCode = 1;
assert.ok(pass >= 15);
