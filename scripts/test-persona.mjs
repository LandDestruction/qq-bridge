// persona 纯逻辑单测：私聊自定义人设的判定边界。
//
// 为什么需要：POST /api/socialV2/set-persona 挂在 HTTP server 闭包里，起真进程测成本太高；
// 但这里的每条判断都关安全/体验——群聊必须拒绝（公共场合）、超长必须截断（否则每轮提示词都在烧 token）、
// reset 必须真的清空。所以判定抽到 src/persona.js 后在这里逐条覆盖。
//
// 运行：node scripts/test-persona.mjs

import {
  PERSONA_DEFAULT_MAX_CHARS,
  personaMaxChars,
  personaKeyError,
  parsePersonaRequest
} from '../src/persona.js';

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass += 1; console.log(`  ok   ${name} → ${got}`); }
  else { fail += 1; console.log(`  FAIL ${name} → got ${got}, want ${want}`); }
}

console.log('\n[1] 字数上限：默认值与上下夹取');
{
  check('未配置 → 默认 2000', personaMaxChars(undefined), PERSONA_DEFAULT_MAX_CHARS);
  check('null → 默认', personaMaxChars(null), 2000);
  check('非数字串 → 默认', personaMaxChars('abc'), 2000);
  check('0 视为未配置', personaMaxChars(0), 2000);
  check('负数视为未配置', personaMaxChars(-5), 2000);
  check('合法值原样', personaMaxChars(3500), 3500);
  check('超上限夹到 6000', personaMaxChars(99999), 6000);
  check('低于下限夹到 100', personaMaxChars(50), 100);
  check('小数四舍五入', personaMaxChars(1200.6), 1201);
}

console.log('\n[2] key 校验：只有 private 能设人设（群聊是公共场合，必须拒绝）');
{
  check('private 合法 → null', personaKeyError('private:100000006'), null);
  check('群聊拒绝 403', personaKeyError('group:123456')?.status, 403);
  check('群聊拒绝文案', personaKeyError('group:123456')?.error.includes('private'), true);
  check('缺前缀 400', personaKeyError('100000006')?.status, 400);
  check('非数字号 400', personaKeyError('private:abc')?.status, 400);
  check('空串 400', personaKeyError('')?.status, 400);
  check('undefined 400', personaKeyError(undefined)?.status, 400);
  check('带空格也能识别', personaKeyError(' private:42 ')?.error ?? null, null);
}

console.log('\n[3] 请求解析：reset / set / error 三种去向');
{
  check('reset=true → reset', parsePersonaRequest({ reset: true }).action, 'reset');
  check('reset 优先于 persona', parsePersonaRequest({ reset: true, persona: '不管我' }).action, 'reset');
  check('reset="true" 字符串不算', parsePersonaRequest({ reset: 'true', persona: 'x' }).action, 'set');
  check('空 persona → error', parsePersonaRequest({ persona: '   ' }).action, 'error');
  check('缺 persona → error', parsePersonaRequest({}).action, 'error');
  check('null persona → error', parsePersonaRequest({ persona: null }).action, 'error');
  check('空 body → error', parsePersonaRequest(undefined).action, 'error');
  check('error 状态码 400', parsePersonaRequest({}).status, 400);
  check('正常文本 → set', parsePersonaRequest({ persona: '我是猫娘' }).text, '我是猫娘');
  check('超长截断到上限', parsePersonaRequest({ persona: 'x'.repeat(150) }, 100).text.length, 100);
  check('低于下限的 maxChars 被抬到 100', parsePersonaRequest({ persona: 'x'.repeat(150) }, 10).text.length, 100);
  check('上限非法时回落到默认', parsePersonaRequest({ persona: 'x'.repeat(2100) }, 'bad').text.length, 2000);
  check('数字 persona 转字符串', parsePersonaRequest({ persona: 123 }).text, '123');
}

console.log('\n[4] 文本归一化：复用桥接的 normalizeInitialPromptText（可注入）');
{
  const stripBom = (raw) => String(raw ?? '').replace(/^\uFEFF/, '').trim();
  check('注入的归一化生效', parsePersonaRequest({ persona: '\uFEFF猫娘' }, 2000, stripBom).text, '猫娘');
  check('归一化后为空 → error', parsePersonaRequest({ persona: '   ' }, 2000, stripBom).action, 'error');
}

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
