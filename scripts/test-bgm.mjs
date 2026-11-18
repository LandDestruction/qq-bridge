#!/usr/bin/env node
// 背景音乐（设置 → 外观 → 背景音乐 + 顶栏音量条）的静态体检。
//
// 这里不打开浏览器（那是 test-client-ui / 无头探针的事），只把「会静默坏掉」的接线钉住：
//   1. 默认曲子文件真的在、真的是 mp3、体积在预算内（别哪次重新生成塞进 3 MB）；
//   2. 生成器是「自己合成」的，没有引用外部曲库/网络地址（版权承诺要能被读出来）；
//   3. 静态资源表带 binary:true —— 少这一条，音频会被按 utf8 读成乱码；
//   4. 免令牌白名单、控制台 GET 名单、开发用 host/fixture 四处都放行，缺一处就是 404；
//   5. 前端片段：只存本机、没有上传接口、静音图标三道弧 + 斜杠、顶栏与设置页双向同步；
//   6. 关闭开关后顶栏整组 hidden（用户要求：关了就别在右上角挂着音量条）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const failures = [];
let total = 0;
const check = (name, ok, detail) => {
  total += 1;
  if (!ok) failures.push({ name, detail });
};

// ── 1. 默认曲子 ────────────────────────────────────────────────────────
const MP3 = 'public/bgm/default-tune.mp3';
check('默认曲子存在', exists(MP3), MP3 + ' 不存在（跑 node scripts/make-bgm.mjs 生成）');
if (exists(MP3)) {
  const buf = fs.readFileSync(path.join(ROOT, MP3));
  const id3 = buf.slice(0, 3).toString('latin1') === 'ID3';
  const frameSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  check('默认曲子是 mp3', id3 || frameSync, '文件头既不是 ID3 也不是帧同步，浏览器可能不认');
  check('默认曲子体积合理', buf.length > 900 * 1024 && buf.length < 1500 * 1024,
    '当前 ' + (buf.length / 1024).toFixed(1) + ' KB，预期 900~1500 KB（约两分钟 80kbps 单声道）；'
    + '再大就不该进安装包了，再小说明曲子被截短了');
  check('默认曲子有音频帧', buf.length > 4096, '文件太小，像是生成失败的空壳');
}

// ── 2. 生成器：自己合成，不拉外部素材 ──────────────────────────────────
const gen = read('scripts/make-bgm.mjs');
check('生成器在', gen.includes('五声音阶'), '生成器里没写调式说明');
check('生成器自己合成波形', gen.includes('Math.sin'), '没有正弦合成，等于不是自己写的曲子');
check('生成器写 wav', gen.includes("write('RIFF'"), '没有写 RIFF 头，产物不是 wav');
check('生成器没有引用外部曲库', !/https?:\/\//.test(gen), '生成器里出现了 http(s) 地址：默认曲不该来自外部素材');
check('生成器写了无缝循环（尾巴折回开头）', gen.includes('折回开头'), '没有尾巴折回，循环点会「咔」一下');
check('生成器写了引进音', gen.includes('function pickups('), '段尾没有引进音，循环点会像被掐一下');
check('生成器做了轻微低通', gen.includes('轻微低通'), '没有低通，长时间听高频会刺');
check('生成器没有下载动作', !/execFileSync\('(curl|wget)'/.test(gen) && !/fetch\(/.test(gen), '生成器里有下载/抓取动作');
check('生成器说明版权口径', /没有版权问题/.test(gen), '生成器没说明为什么这首曲子可以随包分发');

// ── 3. 静态资源表（含 binary 标记） ────────────────────────────────────
const ops = read('src/bridge/console/operations.js');
check('静态表登记了默认曲', ops.includes("'/bgm/default-tune.mp3'"), 'STATIC_ASSETS 里没有这首曲子');
check('静态表标明二进制', /'\/bgm\/default-tune\.mp3'[^\n]*binary: ?true/.test(ops), '缺 binary:true，音频会被按 utf8 读坏');
check('静态表声明 audio/mpeg', /'\/bgm\/default-tune\.mp3'[^\n]*audio\/mpeg/.test(ops), 'content-type 必须是 audio/mpeg');
check('静态读取按二进制走', ops.includes('asset.binary ?'),
  'serveStaticAsset 没有按 asset.binary 分叉：音频被 readFileSync(utf8) 读会变成 U+FFFD，浏览器收到坏文件');

// ── 3.5 CSP 必须放行 blob:（自定义曲子是 Blob URL，'self' 不覆盖 blob:）──
// 这条踩过：不放行时 audio 报「Failed to load because no supported source was found」，
// 而其它断言全绿 —— 只有真的去听才发现没声音。
const cspOf = (rel) => {
  // 头名大小写不统一（桥接写 Content-Security-Policy，离线 fixture 写小写），统一小写比对
  const line = read(rel).split(/\r?\n/).find((l) => l.toLowerCase().includes('content-security-policy')) || '';
  const mediaPart = (line.split('media-src')[1] || '').split(';')[0];
  return mediaPart;
};
check('CSP 放行 blob 媒体', cspOf('src/bridge/console-server.js').includes('blob:'),
  "默认的 default-src 'self' 不覆盖 blob: —— 自定义曲子会静默播不出来，要写 media-src 'self' blob: data:");
check('开发 host 的 CSP 也放行', cspOf('scripts/console-host.mjs').includes('blob:'),
  'scripts/console-host.mjs 的 CSP 没同步');
check('离线 fixture 的 CSP 也放行', cspOf('scripts/console-ui-fixture.mjs').includes('blob:'),
  'scripts/console-ui-fixture.mjs 的 CSP 没同步');

// ── 4. 四处放行 ────────────────────────────────────────────────────────
const server = read('src/bridge/console-server.js');
check('免令牌白名单放行', /NO_TOKEN_GET_PATHS = new Set\(\[[\s\S]{0,400}'\/bgm\/default-tune\.mp3'/.test(server), '不需要令牌的 GET 名单里没有它');
check('控制台 GET 名单放行', /\[[^\]]*'\/bgm\/default-tune\.mp3'[^\]]*\]/.test(server), 'GET 分派名单里没有它 → 404');
const host = read('scripts/console-host.mjs');
check('开发 host 放行', host.includes("'/bgm/default-tune.mp3'"), 'scripts/console-host.mjs 的静态表缺它 → 本地开发 404');
const fixture = read('scripts/console-ui-fixture.mjs');
check('离线 fixture 放行', fixture.includes("'/bgm/default-tune.mp3'"), 'console-ui-fixture.mjs 缺它 → 离线预览没声音');
check('fixture 用 audio/mpeg', fixture.includes("'audio/mpeg'"), 'fixture 的 content-type 不是 audio/mpeg');

// ── 5. 前端片段 ────────────────────────────────────────────────────────
const bgm = read('client/08-bgm.js');
check('片段在', bgm.length > 2000, 'client/08-bgm.js 太短，像是被删空');
check('默认开关是开', bgm.includes("return raw === null || raw === '' ? true : raw === '1'"), '开关没写「默认开」');
check('自定义曲子用 IndexedDB', bgm.includes('indexedDB.open') && bgm.includes('createObjectStore'),
  '音量偏好塞 localStorage 可以，音频必须走 IndexedDB（一首 mp3 就几 MB）');
check('自定义曲子不上传', !/fetch\(/.test(bgm) && !/XMLHttpRequest/.test(bgm), '片段里出现了网络请求：音频不该离开这台机器');
check('自动播放被拦有兜底', bgm.includes('NotAllowedError') && bgm.includes('bgmArmGesture'), '缺「被拦 → 等第一次点击再播」的处理');
check('静音图标三道弧', (bgm.match(/qdb-bgm-wave\d/g) || []).length >= 3, '喇叭旁边应该有三道外扩圆弧');
check('静音图标有斜杠', bgm.includes('qdb-bgm-slash'), '缺静音斜杠');
check('顶栏挂在深浅色按钮前', bgm.includes('header.insertBefore(node, themeBtn)'), '顶栏控件应插在深浅色按钮前面（同一行靠右）');
check('设置页与顶栏共用一份状态',
  bgm.includes('function bgmSyncChrome()') && bgm.includes("byId('bgmVolTop')") && bgm.includes("byId('setBgmVol')"),
  '两个音量条必须是同一份状态，缺一处的同步');
check('关闭时顶栏整组隐藏', bgm.includes('ctl.hidden = !on'), '关了音乐顶栏还挂着音量条');
check('自定义曲子有大小上限', bgm.includes('BGM_MAX_BYTES'), '没上限就会有人塞 200 MB 进来把 IndexedDB 撑爆');
check('换曲后释放旧的 objectURL', bgm.includes('revokeObjectURL'), '不 revoke 会一直堆内存里的 Blob URL');
check('只重画这一行', bgm.includes('bgmRepaintRow') && !bgm.includes('host.innerHTML = settingsBodyHtml()'),
  '整块重画会像 07 那样把别的开关监听一起换掉');
const usage = read('client/04-usage.js');
check('设置页接入这一行', usage.includes('+ bgmRowHtml()'), 'settingsLookHtml 没拼上背景音乐行');
check('设置页绑定控件', usage.includes('bindBgmControls()'), 'bindSettingsControls 没调 bindBgmControls');
const bundle = read('public/client.js');
check('产物包含该片段', bundle.includes('qdb-bgm-vol') && bundle.includes('BGM_DEFAULT_URL'), 'public/client.js 没重新拼');
const css = read('public/client.css');
check('斜杠默认不显示', /\.qdb-bgm-slash \{[^}]*display: none/.test(css), '静音斜杠应默认隐藏');
check('静音时显示斜杠', css.includes('.qdb-bgm-mute[data-muted="1"] .qdb-bgm-slash'), '静音态没有切出斜杠');
check('顶栏音量条有宽度', /\.qdb-bgm-vol \{[^}]*width: \d+px/.test(css), '顶栏音量条没设宽度，会撑成一整行');
const readme = read('client/README.md');
check('README 记了新片段', readme.includes('08-bgm.js'), 'client/README.md 的片段表没加 08');
const pkg = JSON.parse(read('package.json'));
check('有生成命令', !!(pkg.scripts && pkg.scripts['make:bgm']), 'package.json 缺 make:bgm 脚本');

if (failures.length) {
  console.log('✗ 背景音乐自检：通过 ' + (total - failures.length) + ' / 失败 ' + failures.length);
  failures.forEach((f) => console.log('  ✗ ' + f.name + '：' + f.detail));
  process.exit(1);
}
console.log('========== 通过 ' + total + ' / 失败 0 ==========');
