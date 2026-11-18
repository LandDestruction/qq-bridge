// 素材分类与「适配模型数量」规则（src/library-category.js）的纯单测。
//
// 为什么单独测：左栏分类树、顶部筛选、facets 计数、对账清单全都调用这同一套判定。
// 规则错一位，用户就会看到「左栏写服装 2 件、点进去 1 件」——这种不一致比分类不准更伤。
// 这里不碰 fs、不发网络，只喂对象断言结论。
import assert from 'node:assert/strict';

import {
  LIBRARY_CATEGORIES,
  LIBRARY_UNCLASSIFIED,
  MODEL_BUCKETS,
  categoryOf,
  modelCountOf,
  modelBucketOf,
  isModelBucket,
  categoryFilterOf,
  applyCategoryToAsset
} from '../src/library-category.js';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

console.log('## 固定分类表');

check('分类表 11 项、末项是兜底「未分类」', LIBRARY_CATEGORIES.length === 11 && LIBRARY_CATEGORIES.at(-1) === '未分类');
check('分类表被冻结（页面/规则共享同一份，不能被人就地改）', Object.isFrozen(LIBRARY_CATEGORIES));
check('MODEL_BUCKETS 顺序与标签', JSON.stringify(MODEL_BUCKETS) === JSON.stringify([
  { value: 'unlabeled', label: '未标注' },
  { value: '1', label: '1' },
  { value: '2-3', label: '2~3' },
  { value: '4-7', label: '4~7' },
  { value: '8+', label: '8+' }
]));

console.log('\n## categoryOf：meta.category 优先');

eq('meta 写「衣装」→ 服装', categoryOf({ title: '随便', meta: { category: '衣装' } }), { category: '服装', from: 'meta' });
eq('meta 写日文「アクセサリー」→ 饰品', categoryOf({ meta: { category: 'アクセサリー' } }), { category: '饰品', from: 'meta' });
eq('meta 带后缀「衣装・小物」→ 取第一段 服装', categoryOf({ meta: { category: '衣装・小物' } }), { category: '服装', from: 'meta' });
eq('meta 大小写「Outfit」→ 服装', categoryOf({ meta: { category: 'Outfit' } }), { category: '服装', from: 'meta' });
eq('meta 已是规范名「贴图」→ 贴图', categoryOf({ meta: { category: '贴图' } }), { category: '贴图', from: 'meta' });
eq('meta 是认不出的词 → 退回规则（不硬猜）', categoryOf({ title: 'Mew Hair', meta: { category: '謎カテゴリ' } }), { category: '发型', from: 'rule' });
eq('meta 优先于标题关键词', categoryOf({ title: 'Mew Hair', meta: { category: '服装' } }), { category: '服装', from: 'meta' });

console.log('\n## categoryOf：标题/别名/主件/标签关键词');

eq('标题 hair → 发型', categoryOf({ title: 'Mew Hair' }), { category: '发型', from: 'rule' });
eq('标题 Costume → 服装', categoryOf({ title: 'Witch Costume' }), { category: '服装', from: 'rule' });
eq('目录名不参与分类（方向是来源信息，不是品类证据）', categoryOf({ title: 'set01', dir: '2026/衣装' }), { category: LIBRARY_UNCLASSIFIED, from: 'none' });
eq('标签「耳环」→ 饰品', categoryOf({ title: 'pack', tags: ['耳环'] }), { category: '饰品', from: 'rule' });
eq('标签「发饰」不抢发型（发饰属于发型的附属，标题有 hair 时先按发型判）', categoryOf({ title: 'Mew Hair', tags: ['发饰'] }), { category: '发型', from: 'rule' });
eq('主件名 テクスチャ → 贴图', categoryOf({ title: 'p', mainName: 'texture_set.zip' }), { category: '贴图', from: 'rule' });
eq('标题 World → 地图', categoryOf({ title: 'Cozy World 01' }), { category: '地图', from: 'rule' });
eq('标题 Shader → 特效', categoryOf({ title: 'Toon Shader Pack' }), { category: '特效', from: 'rule' });
eq('标题 Voice → 音声', categoryOf({ title: 'Voice Set 3' }), { category: '音声', from: 'rule' });
eq('标题 Unitypackage → 工具', categoryOf({ title: 'unitypackage helper' }), { category: '工具', from: 'rule' });
eq('标题 Avatar → 模型', categoryOf({ title: 'Astraea Avatar' }), { category: '模型', from: 'rule' });
eq('都没有 → 未分类 / from none', categoryOf({ title: 'plain pack' }), { category: LIBRARY_UNCLASSIFIED, from: 'none' });
eq('空对象也不抛', categoryOf(null), { category: LIBRARY_UNCLASSIFIED, from: 'none' });
eq('解压码/正文不参与分类（只看名字类字段）', categoryOf({ title: 'plain', archivePassword: 'hair' }), { category: '未分类', from: 'none' });

console.log('\n## modelCountOf');

eq('meta.models 数组长度 2', modelCountOf({ meta: { models: ['a', 'b'] } }), 2);
eq('meta.models 数组长度 8', modelCountOf({ meta: { models: new Array(8).fill('m') } }), 8);
eq('meta.models 数字 5', modelCountOf({ meta: { models: 5 } }), 5);
eq('meta.models 数字字符串 "3"', modelCountOf({ meta: { models: '3' } }), 3);
eq('meta.models 空数组 + 名字有数字 → 退回名字', modelCountOf({ meta: { models: [] }, title: '対応 4アバター' }), 4);
eq('meta.models 0 → 当未知（0 与 null 不等价）', modelCountOf({ meta: { models: 0 } }), null);
eq('标题「3アバター」', modelCountOf({ title: '衣装セット 3アバター対応' }), 3);
eq('标题「4 avatars」', modelCountOf({ title: 'outfit for 4 avatars' }), 4);
eq('标题「2人用」', modelCountOf({ title: '2人用ポーズ' }), 2);
eq('主件名「8 models」', modelCountOf({ mainName: 'pack_8_models.zip' }), 8);
eq('只有版本号没有数量 → null', modelCountOf({ title: 'set v2026 版' }), null);
eq('抽不到 → null', modelCountOf({ title: 'plain pack' }), null);

console.log('\n## modelBucketOf / isModelBucket');

eq('null → unlabeled', modelBucketOf(null), 'unlabeled');
eq('空串 → unlabeled', modelBucketOf(''), 'unlabeled');
eq('0 → unlabeled', modelBucketOf(0), 'unlabeled');
eq('-1 → unlabeled', modelBucketOf(-1), 'unlabeled');
eq('"abc" → unlabeled', modelBucketOf('abc'), 'unlabeled');
eq('1 → 1', modelBucketOf(1), '1');
eq('2 → 2-3', modelBucketOf(2), '2-3');
eq('3 → 2-3', modelBucketOf(3), '2-3');
eq('4 → 4-7', modelBucketOf(4), '4-7');
eq('7 → 4-7', modelBucketOf(7), '4-7');
eq('8 → 8+', modelBucketOf(8), '8+');
eq('99 → 8+', modelBucketOf(99), '8+');
eq('2.9 取整 → 2-3', modelBucketOf(2.9), '2-3');
check('isModelBucket 认 2-3', isModelBucket('2-3') === true);
check('isModelBucket 认 unlabeled', isModelBucket('unlabeled') === true);
check('isModelBucket 不认 3（那是数字不是桶）', isModelBucket('3') === false);
check('isModelBucket 不认空串', isModelBucket('') === false);
check('isModelBucket 不认 null', isModelBucket(null) === false);

console.log('\n## categoryFilterOf');

eq('unclassified → 未分类', categoryFilterOf('unclassified'), '未分类');
eq('「未分类」→ 未分类', categoryFilterOf('未分类'), '未分类');
eq('别名「衣装」→ 服装', categoryFilterOf('衣装'), '服装');
eq('日文别名 → 饰品', categoryFilterOf('アクセサリー'), '饰品');
eq('规范名原样', categoryFilterOf('服装'), '服装');
eq('认不出的原样返回（由筛选层当无命中）', categoryFilterOf('xyz'), 'xyz');
eq('空值 → 空串（= 不加分类条件）', categoryFilterOf(''), '');
eq('null → 空串', categoryFilterOf(null), '');

console.log('\n## applyCategoryToAsset');

const source = { key: 'k1', title: 'Mew Hair 2アバター', meta: { category: '服装' } };
const applied = applyCategoryToAsset(source);
eq('补 category', applied.category, '服装');
eq('补 categoryFrom', applied.categoryFrom, 'meta');
eq('补 modelCount（meta 没给数量 → 读标题）', applied.modelCount, 2);
eq('补 modelBucket', applied.modelBucket, '2-3');
check('不改入参（缓存/快照可安全复用原对象）', source.category === undefined && source.modelCount === undefined);
check('其余字段原样保留', applied.key === 'k1' && applied.title === 'Mew Hair 2アバター');

console.log('\n## categoryOf：meta.category 带前缀（真机踩过的坑）');

eq('meta「3D衣装」→ 服装（包含匹配，不再落未分类）', categoryOf({ title: '8844481', meta: { category: '3D衣装' } }), { category: '服装', from: 'meta' });
eq('meta「3Dモデル」→ 模型', categoryOf({ title: 'x', meta: { category: '3Dモデル' } }), { category: '模型', from: 'meta' });
eq('meta 写「未分类」不挡后续证据 → 标签里有衣装就是服装', categoryOf({ title: '9014210', tags: ['衣装'], meta: { category: '未分类' } }), { category: '服装', from: 'rule' });
eq('meta 写「未分类」且没别的证据 → 仍未分类', categoryOf({ title: 'plain', meta: { category: '未分类' } }), { category: LIBRARY_UNCLASSIFIED, from: 'none' });

console.log('\n## categoryOf：meta.tags 也参与（标题只有 BOOTH 号时靠它）');

eq('meta.tags 有エフェクト → 特效', categoryOf({ title: '9014210', meta: { category: '未分类', tags: ['花火', 'エフェクト'] } }), { category: '特效', from: 'rule' });
eq('标题只有号码、meta.tags 有衣装 → 服装', categoryOf({ title: '9054339', meta: { tags: ['衣装', 'VRChat'] } }), { category: '服装', from: 'rule' });
eq('aliasTitle 也参与', categoryOf({ title: 'x', aliasTitle: 'Mew Hair' }), { category: '发型', from: 'rule' });

console.log('\n## 真机 17 件 fixture：分类分布不能漂');

// 2026-10-30 真机 GET /api/library/assets?limit=200 抄下来的字段（title/mainName/tags/meta.category/meta.tags）。
// 词表一改这里就会红，提醒「左栏数字变了」——比事后被用户发现好。
const REAL_ASSETS = [
  { key: '8289a88492bcaf34', title: '35種 Mew_Pose_Ver.3', mainName: '8664050_35種 Mew_Pose_Ver.3.zip', tags: [], meta: { category: '未分类' } },
  { key: 'e6e02c6547f40bdc', title: '8844481', mainName: '8844481.png', tags: [], meta: { category: '3D衣装', tags: ['ショコラ', 'セレスティア', 'イチゴ', 'ラムネ', '衣装', 'ライム', 'ルミナ', 'FBX'] } },
  { key: '707511e3fa6ce3e1', title: '【ミルティナMilltina】 じんわり血色感body texture', mainName: '9001543_【ミルティナMilltina】 じんわり血色感body texture.zip', tags: [], meta: { category: '未分类', tags: ['テクスチャ', 'VRChat', 'VRC想定モデル', 'vrchat向け', 'body texture', 'ミルティナ', 'ミルティナ対応'] } },
  { key: '940fcf75b9a56dd6', title: 'Foxia', mainName: '9004871 Foxia.zip', tags: [] },
  { key: '88723f8d7cd7fab2', title: '9013048', mainName: '9013048.zip', tags: [], meta: { category: '3D衣装', tags: ['かわいい', 'ハロウィン', 'セクシー', 'ショコラ', 'フリル', '十字架', '3Dモデル', '骸骨'] } },
  { key: 'b941c197e9d0c365', title: '9014210', mainName: '9014210.png', tags: [], meta: { category: '未分类', tags: ['猫耳', 'ショコラ', 'ミサイル', 'イチゴ', 'ラムネ', '花火', 'エフェクト', 'ルミナ'] } },
  { key: '8ef93b840666f2f0', title: 'ASTREA', mainName: '9027237ASTREA.jpg', tags: [], meta: { category: '3D衣装', tags: ['萌え', 'ショコラ', 'セレスティア', 'ラムネ', '衣装', 'ライム', 'ルミナ', 'ジャケット'] } },
  { key: '4da256bcbf459d30', title: '[ 3Avatars ] Mimuette Make up', mainName: '9028816_[ 3Avatars ] Mimuette Make up.zip', tags: ['3Avatars'], meta: { tags: [] } },
  { key: '55e8e499e5532b8d', title: '奥の手 -OkunoTe-【愛莉・ミルティナ専用】', mainName: '9038753_奥の手 -OkunoTe-【愛莉・ミルティナ専用】.zip', tags: ['愛莉・ミルティナ専用'], meta: { tags: [] } },
  { key: '2ec787d912a7f5b7', title: '♡期間限定無料♡【乳首にフィットする衣装改変】ぷにっぷる+フィット【メッシュ改変ツール・タッチギミック付き】', mainName: '9040444_衣装改変.zip', tags: [], meta: { tags: [] } },
  { key: 'e57743905f48a30e', title: '9040914', mainName: '9040914.png', tags: [], meta: { category: '3D衣装', tags: ['3D', 'ハロウィン', '魔女', 'セクシー', '水着', 'ショコラ', '帽子', '衣装'] } },
  { key: '652420d6446a1652', title: '【9アバター対応】♡ ハートハロウィン ♡ Spiderweb & Stitch Choker Set', mainName: '9041635_【9アバター対応】.zip', tags: ['9アバター対応'], meta: { tags: [] } },
  { key: '4e8f9c5dbae184c9', title: '9048449', mainName: '9048449.png', tags: [], meta: { tags: [] } },
  { key: '80d828b824b49d0c', title: '9053378', mainName: '9053378.zip', tags: [], meta: { tags: [] } },
  { key: '29779dead58d5110', title: '🎀SALE🎀【22 avatars】【VRC Hair】SP-008', mainName: '9053400_【22 avatars】.zip', tags: ['22 avatars', 'VRC Hair'], meta: { tags: [] } },
  { key: '875023d25aaa2c51', title: '宵惑 - YOIMADO', mainName: '9054339宵惑 - YOIMADO.zip', tags: [], meta: { category: '3D衣装', tags: ['ハロウィン', 'セット', '衣装', 'VRChat'] } },
  { key: '1c89cdf1f0fa3094', title: 'Endless Comfort (Ver1_0_2 Win)', mainName: 'Endless Comfort (Ver1_0_2 Win).zip', tags: [], meta: { tags: [] } }
];

const realCounts = {};
const realBuckets = {};
for (const asset of REAL_ASSETS) {
  const tagged = applyCategoryToAsset(asset);
  realCounts[tagged.category] = (realCounts[tagged.category] || 0) + 1;
  realBuckets[tagged.modelBucket] = (realBuckets[tagged.modelBucket] || 0) + 1;
}
eq('真机分布（2026-10-30）', realCounts, { 未分类: 6, 服装: 6, 模型: 3, 特效: 1, 发型: 1 });
eq('真机 model 桶分布', realBuckets, { unlabeled: 14, '2-3': 1, '8+': 2 });
eq('分类 count 之和 = 件数', Object.values(realCounts).reduce((sum, n) => sum + n, 0), REAL_ASSETS.length);
check('未分类 ≤ 8 件（左栏数字要有人用）', (realCounts['未分类'] || 0) <= 8);
check('至少出现 服装/模型/特效 三类', Boolean(realCounts['服装'] && realCounts['模型'] && realCounts['特效']));
eq('【9アバター対応】→ 8+', modelBucketOf(modelCountOf({ title: '【9アバター対応】♡ ハートハロウィン' })), '8+');
eq('【22 avatars】→ 8+', modelBucketOf(modelCountOf({ title: '🎀SALE🎀【22 avatars】【VRC Hair】' })), '8+');
eq('[3Avatars] → 2-3', modelBucketOf(modelCountOf({ title: '[ 3Avatars ] Mimuette Make up' })), '2-3');
eq('「N人対応」也吃', modelCountOf({ title: '衣装 5人対応' }), 5);

console.log('');
if (failures.length) {
  console.error(`分类规则：通过 ${pass} / 失败 ${failures.length}`);
  process.exit(1);
}
console.log(`🎉 分类规则全部通过（${pass} 项）`);
