// 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeSlangEntry,
  createSlangEntry,
  parseResearchJson,
  buildResearchPrompt,
  buildSlangContext,
  SLANG_STATUS,
} from '../src/slang-learner.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. normalize 保留合法 sources，过滤空串并限长
{
  const e = normalizeSlangEntry({
    content: 'yyds',
    sources: ['https://example.com/a', '', ' https://example.com/b '],
  });
  assert.deepEqual(e.sources, ['https://example.com/a', 'https://example.com/b']);
  ok('normalizeSlangEntry 保留/清洗 sources');
}

// 2. createSlangEntry 支持 sources
{
  const e = createSlangEntry({ content: 'xswl', sources: ['https://example.com'] });
  assert.deepEqual(e.sources, ['https://example.com']);
  ok('createSlangEntry 支持 sources');
}

// 3. parseResearchJson 解析 sources
{
  const out = parseResearchJson('[{"content":"yyds","meaning":"永远的神","sources":["https://a",""]}]');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].sources, ['https://a']);
  ok('parseResearchJson 解析 sources');
}

// 4. buildResearchPrompt 要求深度联网与 sources
{
  const prompt = buildResearchPrompt([{ content: 'yyds', evidence: [{ text: '这波 yyds' }] }]);
  assert.ok(prompt.includes('web_fetch'), 'prompt 应要求 web_fetch 抓正文');
  assert.ok(prompt.includes('"sources"'), 'prompt 应要求输出 sources');
  assert.ok(prompt.includes('深度联网考究'), 'prompt 应强调深度联网考究');
  ok('buildResearchPrompt 深度研究指令');
}

// 5. buildSlangContext 只注入已确认且有含义的词条
{
  const ctx = buildSlangContext([
    { content: 'a', meaning: '甲', status: SLANG_STATUS.CONFIRMED, count: 2 },
    { content: 'b', meaning: '', status: SLANG_STATUS.CONFIRMED, count: 1 },
    { content: 'c', meaning: '丙', status: SLANG_STATUS.CANDIDATE, count: 9 },
  ], 8);
  assert.ok(ctx.includes('a：甲'));
  assert.ok(!ctx.includes('b：'));
  assert.ok(!ctx.includes('c：丙'));
  ok('buildSlangContext 只注入已确认且有含义词条');
}

// 6. 联网考究每块都换新会话：同一会话连跑多块会让上下文滚到 20 万 token
{
  const src = fs.readFileSync(new URL('../src/bridge/slang-runtime.js', import.meta.url), 'utf8');
  assert.ok(/if \(i > 0\) invalidateSlangLearnerSession\(deps\);/.test(src),
    '分块循环里每块开始前重置学习会话（否则第 3、4 块输入会滚到 20 万）');
  const loopAt = src.indexOf('for (let i = 0; i < targets.length; i += chunkSize)');
  const resetAt = src.indexOf('if (i > 0) invalidateSlangLearnerSession(deps);');
  assert.ok(loopAt > 0 && resetAt > loopAt, '重置要落在分块循环内部（不是循环外一次）');
  ok('联网考究按块重置学习会话');
}

console.log(`\n🎉 黑话学习新增逻辑测试通过（${passed} 项）`);
