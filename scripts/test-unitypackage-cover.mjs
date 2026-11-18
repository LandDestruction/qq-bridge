// src/unitypackage-cover.js 的契约测试：从 `.unitypackage`（本质是 ZIP）里抠封面。
//
// 夹具在内存里现拼（scripts/fixtures/zip-build.mjs，和 test-zip-read 共用写入器）：
//   - 有 `<guid>/preview.png`（真实 unitypackage 的常见形状）；
//   - 只有 `thumbnail.png` / `cover.png`（降级）；
//   - 没有预览图；坏包；加密包；封面超过 maxBytes。
// 另外锁住中文人话文案：调用方（素材库卡片）直接把它当兜底提示显示。
import { isUnitypackageName, findUnitypackageCover, describeCoverExtraction } from '../src/unitypackage-cover.js';
import { buildZip } from './fixtures/zip-build.mjs';

const failures = [];
let pass = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? '' : ' — ' + String(detail)}`);
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const previewBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(120, 9)]);
const thumbBytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(60, 3)]);

const unitypackage = (extra = []) => buildZip([
  { name: '4f5c1a2b-0000-4000-8000-000000000001/asset', data: 'meta' },
  { name: '4f5c1a2b-0000-4000-8000-000000000001/pathname', data: 'Assets/Robot.prefab' },
  ...extra
]);

console.log('## 正常：<guid>/preview.png');
{
  const zip = unitypackage([{ name: '4f5c1a2b-0000-4000-8000-000000000001/preview.png', data: previewBytes }]);
  const cover = findUnitypackageCover(zip);
  eq('ok:true', cover.ok, true);
  eq('选中 guid 目录下的 preview.png', cover.entryName, '4f5c1a2b-0000-4000-8000-000000000001/preview.png');
  check('返回 Buffer', Buffer.isBuffer(cover.bytes), typeof cover.bytes);
  eq('字节数一致', cover.bytes.length, previewBytes.length);
  eq('PNG 头原样', [...cover.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  eq('mime 是 image/png', cover.mime, 'image/png');
  eq('成功时 error 为空', cover.error, '');
  eq('人话：成功', describeCoverExtraction(cover), '已从包里读出封面');
}

console.log('## 降级：只有 thumbnail / cover');
{
  const onlyThumb = findUnitypackageCover(unitypackage([{ name: 'guid-a/thumbnail.png', data: thumbBytes }]));
  eq('只有 thumbnail.png 也能出图', onlyThumb.ok, true);
  eq('选中 thumbnail.png', onlyThumb.entryName, 'guid-a/thumbnail.png');
  eq('mime 仍是 image/png', onlyThumb.mime, 'image/png');

  const both = findUnitypackageCover(unitypackage([
    { name: 'guid-a/cover.png', data: thumbBytes },
    { name: 'guid-a/thumbnail.png', data: thumbBytes }
  ]));
  eq('thumbnail 优先于 cover', both.entryName, 'guid-a/thumbnail.png');

  const rootWins = findUnitypackageCover(unitypackage([
    { name: 'deep/guid-b/preview.png', data: previewBytes },
    { name: 'preview.png', data: thumbBytes }
  ]));
  eq('根目录 preview.png 优先于深层', rootWins.entryName, 'preview.png');
}

console.log('## 没有预览图 / 坏包 / 加密包');
{
  const empty = findUnitypackageCover(unitypackage());
  eq('没有预览图 → ok:false', empty.ok, false);
  eq('没有预览图 → no_preview', empty.error, 'no_preview');
  eq('人话：没有 preview.png', describeCoverExtraction(empty), '包里没有 preview.png');

  const garbage = findUnitypackageCover(Buffer.from('definitely not a zip'));
  eq('坏包 → not_a_zip', garbage.error, 'not_a_zip');
  eq('人话：不是标准 ZIP', describeCoverExtraction(garbage), '这个包不是标准 ZIP');

  const encrypted = findUnitypackageCover(buildZip([
    { name: 'guid-a/preview.png', data: previewBytes, encrypted: true }
  ]));
  eq('加密包 → encrypted', encrypted.error, 'encrypted');
  eq('人话：加密了读不了', describeCoverExtraction(encrypted), '压缩包加密了，读不了里面的封面');

  eq('null 输入不抛', describeCoverExtraction(findUnitypackageCover(null)), '这个包不是标准 ZIP');
}

console.log('## 大小上限');
{
  const zip = unitypackage([{ name: 'guid-a/preview.png', data: previewBytes }]);
  const tooLarge = findUnitypackageCover(zip, { maxBytes: 10 });
  eq('超过 maxBytes → ok:false', tooLarge.ok, false);
  eq('超过 maxBytes → entry_too_large', tooLarge.error, 'entry_too_large');
  eq('人话：封面太大', describeCoverExtraction(tooLarge), '封面图太大，读出来也没用');
  eq('默认上限下正常读', findUnitypackageCover(zip).bytes.length, previewBytes.length);
}

console.log('## 文件名判定与人话兜底');
{
  eq('isUnitypackageName：.unitypackage', isUnitypackageName('robot.unitypackage'), true);
  eq('isUnitypackageName：大小写不敏感', isUnitypackageName('ROBOT.UNITYPACKAGE'), true);
  eq('isUnitypackageName：.zip 不算', isUnitypackageName('robot.zip'), false);
  eq('isUnitypackageName：备份后缀不算', isUnitypackageName('robot.unitypackage.bak'), false);
  eq('isUnitypackageName：非字符串不算', isUnitypackageName(null), false);
  eq('人话：未知错误也有中文兜底', describeCoverExtraction({ ok: false, error: 'weird_thing' }), '封面读取失败：weird_thing');
  eq('人话：空结果不炸', describeCoverExtraction(undefined), '封面读取失败：结果无效');
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('失败项：');
  for (const name of failures) console.log(` - ${name}`);
}
process.exit(failures.length ? 1 : 0);
