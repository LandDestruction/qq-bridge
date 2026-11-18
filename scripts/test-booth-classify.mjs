// BOOTH 分类映射表 + 目录名清洗单测（离线纯函数）。
import assert from 'node:assert/strict';
import {
  BOOTH_CATEGORY_MAP,
  normalizeBoothCategory,
  sanitizeCategoryName
} from '../src/booth-classify.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (error) { fail += 1; console.error(`  FAIL ${name}: ${error?.message ?? error}`); }
}

console.log('[1] 已知分类 → 固定目录名');
const known = ['3D衣装', '3Dモデル', '3D小道具', '素材', 'ツール', '音声', 'その他'];
for (const name of known) {
  check(`${name} → ${BOOTH_CATEGORY_MAP[name]}`, () => {
    assert.equal(normalizeBoothCategory(name), BOOTH_CATEGORY_MAP[name]);
  });
}
check('子类归并：テクスチャ/シェーダー/アニメーション/モーション → 素材', () => {
  for (const name of ['テクスチャ', 'シェーダー', 'アニメーション', 'モーション']) {
    assert.equal(normalizeBoothCategory(name), '素材');
  }
});
check('去括号后再匹配：`3D衣装（セール）` → 3D衣装', () => {
  assert.equal(normalizeBoothCategory('3D衣装（セール）'), '3D衣装');
  assert.equal(normalizeBoothCategory('3Dモデル(その他)'), '3Dモデル');
});

console.log('[2] 未知分类 / 空值 → 未分类');
check('未知分类一律未分类', () => {
  for (const name of ['謎カテゴリ', 'VRoid', '完全に未知', '']) {
    assert.equal(normalizeBoothCategory(name), '未分类');
  }
  assert.equal(normalizeBoothCategory(null), '未分类');
  assert.equal(normalizeBoothCategory(undefined), '未分类');
});

console.log('[3] 非法路径字符清洗');
check('去掉 \\/:*?"<>| 与控制字符，压缩空白', () => {
  assert.equal(sanitizeCategoryName('3D/衣装:*?"<>|'), '3D衣装');
  assert.equal(sanitizeCategoryName('  a  b  '), 'a b');
  assert.equal(sanitizeCategoryName('...名字...'), '名字');
  assert.equal(sanitizeCategoryName('///'), '未分类');
  assert.equal(sanitizeCategoryName('x'.repeat(80)).length, 40, '限制 40 字符');
}); 
check('映射后的值也过清洗（防表里写错）', () => {
  const mapped = normalizeBoothCategory('3D衣装');
  assert.equal(mapped.includes('/'), false);
  assert.equal(mapped.includes('\\'), false);
});

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
