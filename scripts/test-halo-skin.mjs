#!/usr/bin/env node
// 第五套皮肤「数据环 HUD」+ HALOFLUX 主题曲的静态体检。
//
// 这套东西有两个容易静默坏掉的地方，测试就盯这两类：
//   1. 皮肤：注册表、三处白名单、CSS 令牌块、直角/等宽/伪元素关掉、数据环画布的启停条件；
//   2. 授权：HALOFLUX 是 PolyForm Noncommercial，必须随包带原文与署名，且只能非商业使用。
//      音乐文件少一个字节、授权文件丢一行 Required Notice，都是法务问题不是视觉问题。
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

// ── 1. 皮肤注册表 ──────────────────────────────────────────────────────
const shell = read('client/01-shell.js');
const settings = read('client/05-settings.js');
const usage = read('client/04-usage.js');
const css = read('public/client.css');
const html = read('public/client.html');

check('皮肤注册表里有第五套 halo', /id: 'halo', name: '数据环 HUD'/.test(shell), 'SKINS 里找不到 { id: halo }');
check('皮肤色块有 halo', /halo: \{ bg: '#08090b'/.test(shell), 'SKIN_SWATCHES 缺 halo，方案卡会是空白块');
check('currentSkin 接受 halo', /value === 'pink' \|\| value === 'halo' \? value : 'mint'/.test(settings),
  'currentSkin 不认识 halo，刷新后会掉回 mint');
check('applySkin 接受 halo', /'paper' \|\| next === 'peach' \|\| next === 'pink' \|\| next === 'halo' \? next : 'mint'/.test(settings),
  'applySkin 不认识 halo，点了不生效');
check('设置页文案改成五套', /五套方案只换颜色/.test(usage), '界面方案那段还写着「四套方案」');

// ── 2. CSS 令牌与整流 ──────────────────────────────────────────────────
check('halo 令牌块存在', /\[data-skin="halo"\],/.test(css) && /--ui-bg: #08090b;/.test(css), 'CSS 里没有 halo 的暗色令牌');
check('halo 直角（--ui-radius: 2px）', /--ui-radius: 2px;/.test(css), '这套皮肤应该是直角，圆角令牌没压到 2px');
check('halo 等宽字体覆盖到 body/按钮/输入框', /\[data-skin="halo"\] body,[\s\S]{0,220}font-family: "JetBrains Mono"/.test(css),
  '只给 html 设字体不够，body 会盖回去（实机就是这样，字体没变）');
check('halo 关掉毛玻璃扫光伪元素', /\.qdb-panel::after \{ content: none; \}/.test(css),
  '近黑实色卡上还留着扫光 ::before，会是一块脏白');
check('halo 背景光雾全关', /html\[data-skin="halo"\]\[data-glass="on"\] body::before \{ opacity: 0; \}/.test(css),
  '彩光不压下去，暗色皮肤会被糊成灰绿');

// ── 3. 数据环画布 ──────────────────────────────────────────────────────
const ring = read('client/09-ring.js');
check('仪表盘有数据环容器', /id="qdbHero"/.test(html) && /id="qdbRing"/.test(html), 'client.html 里没有 #qdbHero/#qdbRing');
check('容器默认 hidden', /<div class="qdb-hero" id="qdbHero" hidden>/.test(html), '默认应该藏起来，只有 halo 皮肤才显示');
check('只有 halo 皮肤才显示', /dataset\.skin === 'halo'/.test(ring) && /hero\.hidden = !ringSkinOn;/.test(ring),
  '画布该跟着 data-skin 开关，别在别的皮肤上也烧 rAF');
check('切走就停 rAF', /if \(!ringSkinOn\) \{ ringStop\(\); return; \}/.test(ring), '切到别的皮肤要停掉动画');
check('标签页隐藏/切页会停', /visibilitychange/.test(ring) && /document\.hidden/.test(ring), '没有 visibilitychange 兜底，后台会一直烧 CPU');
check('监听在提前 return 之前挂', /function ringMount\(\)[\s\S]{0,900}MutationObserver/.test(ring),
  '第一版把观察者挂在「皮肤已开」之后，进来是别的皮肤就再也不响应切换了');
check('用 ResizeObserver 接住「切回仪表盘」', /ResizeObserver/.test(ring),
  '页面被切走时宽高是 0，没有 ResizeObserver 画布会永远停在 1x1（看着就是一块黑）');
check('0 尺寸不写画布', /if \(rect\.width < 8 \|\| rect\.height < 8\) return;/.test(ring), '拿 0 去写画布会让后续都画不出来');
check('尊重「减少动态」', /prefers-reduced-motion: reduce/.test(ring) && /if \(ringReduced\(\)\) return;/.test(ring),
  '旋转的东西对前庭敏感的人不友好，系统关了动态就只画静帧');
check('静态层只画一次', /ringBuildStill/.test(ring) && /drawImage\(ringStill/.test(ring),
  '每帧全量重画会在弱机上掉帧，静态部分要预渲染');
check('标注了原作者与许可', /HALOFLUX by Ryder191/.test(ring) && /PolyForm Noncommercial/.test(ring),
  '重画的视觉语言也要在代码里署名');

// ── 4. 音乐：文件、授权原文、四处放行 ──────────────────────────────────
const MP3 = 'public/bgm/haloflux-sw421k.mp3';
const LIC = 'public/bgm/HALOFLUX-LICENSE.txt';
check('主题曲文件在', exists(MP3), MP3 + ' 不存在（重新从 HALOFLUX 站点下载）');
if (exists(MP3)) {
  const buf = fs.readFileSync(path.join(ROOT, MP3));
  check('主题曲是 mp3', buf.slice(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0),
    '文件头不是 ID3/帧同步');
  check('主题曲体积对得上（7.5 MB）', buf.length > 7 * 1024 * 1024 && buf.length < 9 * 1024 * 1024,
    '当前 ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB，预期 7~9 MB');
}
check('授权原文随包', exists(LIC), LIC + ' 不存在（PolyForm Noncommercial 要求保留声明）');
if (exists(LIC)) {
  const lic = read(LIC);
  check('授权声明含版权方', /Ryder191 \(RYDER CODE \/ Ms MAIKEBAIs CAT\)/.test(lic), '缺版权署名');
  check('授权声明含非商业限制', /Noncommercial use only/i.test(lic), '缺「仅限非商业」这句');
  check('授权声明含项目地址', /github\.com\/Ryder191\/haloflux/.test(lic), '缺项目地址');
}

const ops = read('src/bridge/console/operations.js');
const server = read('src/bridge/console-server.js');
const host = read('scripts/console-host.mjs');
const fixture = read('scripts/console-ui-fixture.mjs');
check('静态资源表登记主题曲（binary）', /'\/bgm\/haloflux-sw421k\.mp3', \{ file: 'bgm\/haloflux-sw421k\.mp3', type: 'audio\/mpeg', binary: true \}/.test(ops),
  '少 binary:true 会被按 utf8 读成乱码');
check('静态资源表登记授权原文', /'\/bgm\/HALOFLUX-LICENSE\.txt'/.test(ops), '授权原文也要能被访问到');
for (const [name, text] of [['console-server 免令牌白名单', server], ['console-server GET 名单', server],
  ['开发 host', host], ['离线 fixture', fixture]]) {
  check(name + '放行主题曲', /haloflux-sw421k\.mp3/.test(text), '少一处就是 404');
}

// ── 5. 前端音乐选择 ────────────────────────────────────────────────────
const bgm = read('client/08-bgm.js');
check('前端认识 halo 这首', /BGM_HALO_URL = '\/bgm\/haloflux-sw421k\.mp3'/.test(bgm) && /bgmSource\(\) === 'halo'/.test(bgm),
  'bgmSource/bgmResolveUrl 里没有 halo 分支');
check('设置页有三选一', /data-bgm-track="' \+ it\.id \+ '"/.test(bgm), '没有曲目切换按钮');
check('切换会重播并落盘', /function bgmSetTrack\(id\)/.test(bgm) && /bgmStoreSet\(BGM_SRC_KEY, id === 'halo'/.test(bgm),
  '切曲目要写 localStorage，否则下次又回到默认曲');
check('状态里报真实曲名', /name: bgmTrackName\(\)/.test(bgm), '__qdbBgmState().name 要能看出正在放哪首');

if (failures.length) {
  console.log('');
  for (const f of failures) console.log('❌ ' + f.name + (f.detail ? ' — ' + f.detail : ''));
  console.log('');
  console.log('test-halo-skin：' + total + ' 条断言，失败 ' + failures.length);
  process.exit(1);
}
console.log('🎉 test-halo-skin 全部通过（' + total + '/' + total + '）');
