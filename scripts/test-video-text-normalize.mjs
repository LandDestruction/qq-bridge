// 视频字幕「事实化」回归：正文里不应该再出现给模型的判断/指令，加载态能回填历史正文。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeVideoRecordText, normalizeVideoRecordMessages } from '../src/video-text-normalize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
};

const OLD = '【视频声音】听不清（empty）：这段语音不可当作内容依据，别猜、别复述。';
const VIDEO = '[视频 10 秒｜画面：已抽 11 帧（约 0.9s/帧）拼成 4×3 网格]';

// ── [1] 归一函数本身
check('旧正文 → 事实版（听不清）', () => {
  const out = normalizeVideoRecordText(`${OLD} ${VIDEO}`);
  assert.equal(out, `${VIDEO}\n声音：听不清`);
  assert.ok(!/别猜|不可当作内容依据/.test(out));
});

check('拼了两遍的正文收敛成一份', () => {
  const out = normalizeVideoRecordText(`${OLD} ${VIDEO}\n${OLD}`);
  assert.equal(out, `${VIDEO}\n声音：听不清`);
});

check('原话转写 → 声音：“…”', () => {
  const out = normalizeVideoRecordText(`【视频声音】原话转写：“小心点，别摔了” ${VIDEO}`);
  assert.equal(out, `${VIDEO}\n声音：“小心点，别摔了”`);
});

check('no-audio → 声音：无', () => {
  const out = normalizeVideoRecordText(`【视频声音】没有可用的人声（no-audio） ${VIDEO}`);
  assert.equal(out, `${VIDEO}\n声音：无`);
});

check('转写失败 → 声音：没转出来', () => {
  const out = normalizeVideoRecordText(`【视频声音】转写失败（failed） ${VIDEO}`);
  assert.equal(out, `${VIDEO}\n声音：没转出来`);
});

check('正文里其它文字保留', () => {
  const out = normalizeVideoRecordText(`这条视频很有趣 ${OLD} ${VIDEO}`);
  assert.equal(out, `这条视频很有趣\n${VIDEO}\n声音：听不清`);
});

check('没有旧文案 → null（不白改）', () => {
  assert.equal(normalizeVideoRecordText(`${VIDEO}\n声音：听不清`), null);
  assert.equal(normalizeVideoRecordText('普通消息'), null);
  assert.equal(normalizeVideoRecordText(''), null);
  assert.equal(normalizeVideoRecordText(null), null);
});

check('批量：只改旧的那几条，原地返回', () => {
  const list = [
    { text: `${OLD} ${VIDEO}` },
    { text: '正常消息' },
    null,
    { text: `${VIDEO}\n声音：无` },
    { text: 'x', plain: 'y' }
  ];
  const out = normalizeVideoRecordMessages(list);
  assert.equal(out, list);
  assert.equal(list[0].text, `${VIDEO}\n声音：听不清`);
  assert.equal(list[1].text, '正常消息');
  assert.equal(list[3].text, `${VIDEO}\n声音：无`);
  assert.equal(normalizeVideoRecordMessages('nope'), 'nope');
});

// ── [2] 写入路径：正文只写事实，判断/指令留在日志
const incoming = read('src/bridge/incoming-media.js');
const factsAt = incoming.indexOf('const applyVideoFacts');
const applyFacts = factsAt < 0 ? '' : incoming.slice(factsAt, factsAt + 1800);
check('写入路径不再把「别猜、别复述」写进正文', () => {
  assert.ok(!/别猜|不可当作内容依据|别复述/.test(applyFacts), 'applyVideoFacts 里还有指令文案');
});
check('写入路径用「声音：…」事实口径', () => {
  assert.ok(applyFacts, '没切到 applyVideoFacts');
  assert.ok(/声音：/.test(applyFacts), '没找到「声音：」事实文案');
});

const prompts = read('src/bridge/wake-prompts.js');
check('「听不清就别猜」只出现在给模型的提示里', () => {
  assert.ok(/听不清/.test(prompts), 'wake-prompts 里应该有「听不清」的提示');
});

// ── [3] 加载态回填：老状态文件打开时自动修正
const wakeState = read('src/bridge/wake-state.js');
check('wake-state 加载时调用回填函数', () => {
  assert.ok(/normalizeVideoRecordMessages\)\(val\.recentMessages\)/.test(wakeState));
  assert.ok(/normalizeVideoRecordMessages\)\(val\.unread\)/.test(wakeState));
});

const bridge = read('src/bridge.js');
check('bridge.js 导出 bindings', () => {
  assert.ok(/get normalizeVideoRecordMessages\(\)/.test(bridge));
});

const manifest = JSON.parse(read('src/bridge/manifest.json'));
check('manifest 给 wake-state 登记了依赖', () => {
  const mod = manifest.modules.find((m) => String(m.file).endsWith('wake-state.js'));
  assert.ok(mod && mod.dependencies.includes('normalizeVideoRecordMessages'));
});

// ── [4] 修数据脚本存在且默认预演
const fixer = read('scripts/fix-video-texts.mjs');
check('修数据脚本默认预演、--apply 才写', () => {
  assert.ok(/--apply/.test(fixer));
  assert.ok(/预演，没有写盘/.test(fixer));
});
check('修数据脚本会处理与事实版重复的旧行', () => {
  assert.ok(/UNIQUE constraint failed/.test(fixer));
});

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
