// 黑话「预选」：把候选里能直接批的挑出来。纯函数，不连桥接。
import {
  buildSlangPreselect,
  scoreSlangCandidate,
  PRESELECT_READY_SCORE,
  PRESELECT_MAX_ITEMS
} from '../src/bridge/console/slang.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
}
function candidate(over = {}) {
  return {
    id: 'e1',
    content: '哈基米',
    meaning: '群里用来形容可爱小猫的说法',
    usage: '夸猫时用',
    example: '这只哈基米真可爱',
    risk: '',
    status: 'candidate',
    source: 'ai-research',
    basis: 'context',
    count: 3,
    evidence: [{ key: 'group:1', text: 'a' }, { key: 'group:2', text: 'b' }],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...over
  };
}

// 1) 齐全且有研究的候选 → ready
{
  const v = scoreSlangCandidate(candidate());
  check('齐全候选判 ready', v.tier === 'ready' && v.score >= PRESELECT_READY_SCORE, JSON.stringify(v));
  check('理由写清凭什么', v.reasons.some((r) => r.includes('含义')) && v.reasons.some((r) => r.includes('证据')));
}

// 2) 没含义 → weak（确认了也注不进上下文）
{
  const v = scoreSlangCandidate(candidate({ meaning: '' }));
  check('没含义判 weak', v.tier === 'weak' && v.reasons[0].includes('含义'));
}

// 3) 纯数字 / 纯符号 / 太长 → weak
{
  check('纯数字 weak', scoreSlangCandidate(candidate({ content: '123456' })).tier === 'weak');
  check('纯符号 weak', scoreSlangCandidate(candidate({ content: '。。。' })).tier === 'weak');
  check('过长 weak', scoreSlangCandidate(candidate({ content: '这是一整句话而不是一个黑话词条啊哈' })).tier === 'weak');
}

// 4) 风险提示 → 降到 review（不排除，人能自己判断）
{
  const v = scoreSlangCandidate(candidate({ risk: '这个词有贬义，慎用' }));
  check('风险降级 review', v.tier === 'review' && v.risk === true);
  check('风险也写了理由', v.reasons.some((r) => r.includes('风险')));
}

// 5) 只有含义、没有证据/用法/例句 → 不够 ready
{
  const v = scoreSlangCandidate(candidate({ evidence: [], usage: '', example: '', source: 'manual', count: 1, basis: '' }));
  check('信息不够不进预选', v.tier === 'weak', JSON.stringify(v));
}

// 6) buildSlangPreselect：只算候选、计数对、ready 排在 review 前
{
  const entries = [
    candidate({ id: 'a', content: '词A' }),
    candidate({ id: 'b', content: '词B', risk: '有贬义慎用' }),
    candidate({ id: 'c', content: '词C', meaning: '' }),
    candidate({ id: 'd', content: '已确认', status: 'confirmed' })
  ];
  const view = buildSlangPreselect(entries);
  check('只统计候选', view.counts.candidates === 3, JSON.stringify(view.counts));
  check('计数分类正确', view.counts.ready === 1 && view.counts.review === 1 && view.counts.weak === 1, JSON.stringify(view.counts));
  check('预选清单不含弱信号与已确认', view.entries.length === 2 && !view.entries.some((e) => e.id === 'c' || e.id === 'd'));
  check('ready 排在 review 前', view.entries[0].preselect.tier === 'ready' && view.entries[1].preselect.tier === 'review');
}

// 7) 清单是精简字段：不带证据正文，只给条数
{
  const view = buildSlangPreselect([candidate({ id: 'x' })]);
  const one = view.entries[0];
  check('精简字段不带证据数组', !Array.isArray(one.evidence) && one.evidenceCount === 2);
  check('带上审阅需要的字段', one.content === '哈基米' && one.meaning.includes('可爱') && typeof one.preselect.score === 'number');
}

// 8) 上限与空输入
{
  const many = [];
  for (let i = 0; i < PRESELECT_MAX_ITEMS + 50; i++) many.push(candidate({ id: 'k' + i, content: '词' + i }));
  check('结果不超过上限', buildSlangPreselect(many).entries.length === PRESELECT_MAX_ITEMS);
  const empty = buildSlangPreselect([]);
  check('空库不炸', empty.entries.length === 0 && empty.counts.candidates === 0);
  check('非数组不炸', buildSlangPreselect(null).entries.length === 0);
}

// 9) 排序稳定：同分按出现次数降序
{
  const view = buildSlangPreselect([
    candidate({ id: 'low', content: '词低', count: 1 }),
    candidate({ id: 'high', content: '词高', count: 9 })
  ]);
  check('同分按出现次数排', view.entries[0].id === 'high', view.entries.map((e) => e.id).join(','));
}

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log(`  FAIL ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`\n========== 通过 ${results.length - failed.length} / 失败 ${failed.length} ==========`);
if (failed.length) process.exitCode = 1;
