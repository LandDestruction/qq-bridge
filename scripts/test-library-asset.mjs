// scripts/test-library-asset.mjs — 「一件素材」识别规则的单测（纯函数，不碰磁盘）
import assert from 'node:assert/strict';
import {
  ASSET_RULES_VERSION, buildAssets, boothIdCandidates, displayTitle, digitsIn, isArchive, isImage,
  looksLikeDate, looksLikeUnityProject, normalizeName, pickBoothId, pickReadme, reconcileWithLedger,
  summarizeAssets, extOf, isThumb, isMeta
} from '../src/library-asset.js';

let passed = 0;
const failures = [];
function check(ok, title, detail = '') {
  if (ok) { passed += 1; console.log(`  ok   ${title}`); }
  else { failures.push(`${title}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${title}${detail ? ` — ${detail}` : ''}`); }
}

console.log('库里「一件」怎么认：');

// ── 名字工具 ──────────────────────────────────────────────────────────────
check(ASSET_RULES_VERSION === 2, '规则版本号从 1 起（改了规则要 +1，台账才认得出旧行）');
check(extOf('a.ZIP') === '.zip' && isArchive('x.tar.gz') && !isArchive('x.jpg'), '扩展名小写化，压缩包判定按末段扩展');
check(isImage('9013048_1.JPG') && !isImage('x.zip'), '图片判定大小写不敏感');
check(isThumb('9013048.thumbnail.jpg') && isThumb('cover.png') && !isThumb('9013048_1.jpg'), '缩略图/封面排第一，普通预览图不算');
check(isMeta('9013048.meta.json') && isMeta('meta.json') && !isMeta('说明.txt'), '元数据 .meta.json 不算独立件');
check(normalizeName('9013048_【9アバター対応】♡ ハート (1).zip') === normalizeName('9013048_【9アバター対応】♡ ハート.jpg'),
  '全角/编号/下划线归一后同名（压缩包与预览图能配上）');

// ── BOOTH 号 ──────────────────────────────────────────────────────────────
check(pickBoothId({ name: '9013048 Foxia.zip' }) === '9013048', '文件名开头 7 位数字认出来');
check(pickBoothId({ name: '9004871.pdf' }) === '9004871', '开头号后面跟别的扩展名也认');
check(pickBoothId({ name: 'Booth-9028816.zip' }) === '9028816', 'Booth- 前缀也能认');
check(pickBoothId({ name: '【PB】xxx 9040914.zip' }) === '9040914', '名字中间夹着的号（退路）');
check(pickBoothId({ name: '素材 20261027.zip' }) === '', '8 位日期不当商品号（2026-10-27 落月份目录就是这么来的）');
check(pickBoothId({ name: '素材 202610.zip' }) === '', '6 位 YYYYMM 也不当号');
check(pickBoothId({ name: 'x.zip', folderName: '9014210' }) === '9014210', '目录名本身就是号');
check(pickBoothId({ name: 'x.zip', text: 'https://booth.pm/ja/items/9038753' }) === '9038753', '说明里的商品链接最可信');
check(pickBoothId({ name: '9053400_a.zip', text: 'https://booth.pm/items/9004871' }) === '9004871',
  '说明链接优先于文件名开头（人写的最准）');
check(digitsIn('9053400') [0] === '9053400' && looksLikeDate('20261027') && !looksLikeDate('9053400'),
  '日期判断与号判断分开');
check(boothIdCandidates({ name: '9013048_2.zip', folderName: '9013048' }).length === 1,
  '同一个号只留一条候选');
check(pickReadme(['Texture/a.png', 'readme.txt', 'ReadMe_9013048.txt']) === 'ReadMe_9013048.txt',
  '压缩包内读 readme（前三层），多个时取最短的那个');
check(pickReadme(['a/b/c/d/readme.txt']) === '', '第四层以下的 readme 不读（防误判）');

// ── 一件的判定：单包 + 预览图 + 说明 + 元数据 ──────────────────────────────
const single = buildAssets({
  dir: '9013048',
  files: [
    { name: '9013048.zip', bytes: 1000 },
    { name: '9013048.jpg', bytes: 200 },
    { name: '9013048.meta.json', bytes: 10 },
    { name: '9013048.thumbnail.jpg', bytes: 20 },
    { name: '说明.txt', bytes: 5 }
  ]
});
check(single.assets.length === 1 && single.loose.length === 0, '一个包 + 图 + 说明 + 元数据 = 一件');
const one = single.assets[0];
check(one.main.name === '9013048.zip' && one.previews.length === 2, '主件是压缩包，两张图都进预览');
check(one.previews[0].name === '9013048.thumbnail.jpg', '封面（thumbnail）排第一张');
check(one.docs.length === 1 && one.metas.length === 1, '说明与元数据分开挂');
check(one.boothId === '9013048' && one.boothSource === 'name-prefix', '件上带 BOOTH 号与来源');
check(/^[0-9a-f]{16}$/.test(one.key), 'contentKey 与台账同口径（16 位十六进制）');
check(one.title === '9013048', '名字里只有号时，标题退回号本身（不能是空串）');

// ── 一个目录里多个包：图按名字配给最像的那件 ──────────────────────────────
const multi = buildAssets({
  dir: '2026-10',
  files: [
    { name: '9013048 Foxia.zip', bytes: 100 },
    { name: '9013048_1.jpg', bytes: 10 },
    { name: 'Astraea.zip', bytes: 200 },
    { name: 'Astraea preview.png', bytes: 20 },
    { name: '陌生图.png', bytes: 5 }
  ]
});
check(multi.assets.length === 2 && multi.kind === 'multi', '一个目录多个包 = 多件');
const foxia = multi.assets.find((a) => a.main.name.includes('Foxia'));
const astraea = multi.assets.find((a) => a.main.name.includes('Astraea'));
check(foxia && foxia.previews.some((p) => p.name === '9013048_1.jpg'), '同号预览图配给同号那件');
check(astraea && astraea.previews.some((p) => p.name === 'Astraea preview.png'), '同名预览图按名字配');
check(multi.loose.length === 1 && multi.loose[0].name === '陌生图.png', '配不上的图留成散文件，不硬塞');

// ── Unity 工程整棵算一件 ──────────────────────────────────────────────────
check(looksLikeUnityProject(['Assets/Foo.prefab', 'Assets/Tex/a.png', 'readme.txt']), '有 .prefab 就判 Unity 工程');
check(looksLikeUnityProject(['Materials/a.mat']), '有 .mat 也算');
const unity = buildAssets({ dir: '8664050_模型', files: ['Assets/a.prefab', 'Assets/Tex/b.png', 'readme.txt'] });
check(unity.kind === 'unity' && unity.assets.length === 1, 'Unity 工程不拆包，整棵目录一件');
check(unity.assets[0].previews.length === 1, 'Unity 工程里的图当预览图');

// ── 没有包的目录 ──────────────────────────────────────────────────────────
const imageOnly = buildAssets({ dir: '9027237', files: [{ name: '9027237ASTREA.jpg', bytes: 9 }] });
check(imageOnly.kind === 'image' && imageOnly.assets.length === 1, '只有一张图也能成件（封面素材）');
const empty = buildAssets({ dir: '空目录', files: [] });
check(empty.kind === 'none' && empty.assets.length === 0 && empty.loose.length === 0, '空目录不产生件（调用方记 EmptyDirs）');

// ── 只剩缩略图：缩略图永远不当主件（真机 P2②：原包被移走/备份走后）──────────
const thumbOnly = buildAssets({
  dir: '5197537',
  files: [{ name: '6985553.thumbnail.png', bytes: 40 }, { name: '6985553.meta.json', bytes: 8 }]
});
check(thumbOnly.kind === 'image-only' && thumbOnly.assets.length === 1,
  '目录里只剩缩略图时认成 image-only（不把缩略图当独立图片素材）');
check(thumbOnly.assets[0].main === null && thumbOnly.assets[0].kind === 'image-only',
  'image-only 的主件留空（缩略图不能当 mainName，否则「已解压」认不到）');
check(thumbOnly.assets[0].title === '6985553', 'image-only 的标题从缩略图名剥掉 thumbnail 标记');
check(thumbOnly.assets[0].previews.length === 1 && thumbOnly.assets[0].previews[0].name === '6985553.thumbnail.png',
  '缩略图仍进预览（卡片封面照常显示）');
const imageWithThumb = buildAssets({
  dir: 'x',
  files: [{ name: 'x.thumbnail.png', bytes: 10 }, { name: 'x full.png', bytes: 20 }]
});
check(imageWithThumb.kind === 'image' && imageWithThumb.assets[0].main.name === 'x full.png',
  '有真实图片时主件取图片，缩略图只当封面（主件判定优先「同名压缩包 > 其它」）');

// ── 标题 / 展示名 ─────────────────────────────────────────────────────────
check(displayTitle('9038753_奥の手 -OkunoTe-【愛莉・ミルティナ専用】.zip') === '奥の手 -OkunoTe-【愛莉・ミルティナ専用】',
  '标题只去掉号前缀与分隔符');
check(displayTitle('9014210') === '9014210', '没有别的名字时退回原名');

// ── 与台账对账 ────────────────────────────────────────────────────────────
const ledger = [
  { id: 1, content_key: one.key, booth_id: '9013048' },
  { id: 2, content_key: 'deadbeefdeadbeef', booth_id: '9004871' }
];
const recon = reconcileWithLedger([one], ledger);
check(recon.items[0].inLedger === true && recon.items[0].rowId === 1, '认出来的件能对上台账行');
check(recon.notInLedger.length === 0, '盘上有、台账也有 → 不是缺口');
check(recon.missingOnDisk.length === 1 && recon.missingOnDisk[0].id === 2, '台账有、盘上没了 → 报出来（被外面删了）');
const orphan = reconcileWithLedger([{ ...one, key: 'ffffffffffffffff', files: [{ name: '另放的手工素材.zip', bytes: 77 }], main: { name: '另放的手工素材.zip', bytes: 77 }, previews: [], docs: [], metas: [] }], ledger);
check(orphan.notInLedger.length === 1, '盘上有、台账没有 → 报出来（手工放进来的）');

// ── 汇总 ──────────────────────────────────────────────────────────────────
const sum = summarizeAssets(multi);
check(sum.assets === 2 && sum.withBooth >= 1 && sum.loose === 1, '汇总能报件数 / 有号的 / 有图的 / 散文件');

console.log(`\n素材识别：通过 ${passed} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
assert.ok(passed > 0);
