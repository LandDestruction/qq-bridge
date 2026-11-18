// 渲染 DeepSeek-chan Live2D 模型并截图（Chrome headless + CDP 精确控制渲染时机）。
// 用法: node scripts/live2d-shot.mjs --exp=爱心眼 --motion=IDLE --out=out.png [--w=720 --h=720 --bg=#1a1a2e --scale=1]
//  或按情绪: node scripts/live2d-shot.mjs --emotion=开心 --out=out.png （内部映射到表情）
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const get = (k, d = '') => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const emotionArg = get('emotion');
const motion = get('motion');
const out = get('out', 'live2d.png');
const W = get('w', '720');
const H = get('h', '720');
const bg = get('bg', '#1a1a2e');
const scale = get('scale', '1');

// 情绪 → 表情映射（机器人情绪 → DeepSeek-chan 的 Exp3 表情名）
const EMOTION_MAP = [
  ['开心', '爱心眼'], ['高兴', '爱心眼'], ['喜悦', '爱心眼'], ['兴奋', '爱心眼'], ['喜欢', '爱心眼'], ['幸福', '爱心眼'], ['爱', '爱心眼'],
  ['难过', '流泪'], ['伤心', '流泪'], ['悲伤', '流泪'], ['哭', '流泪'], ['委屈', '流泪'], ['想哭', '流泪'],
  ['生气', '黑脸'], ['愤怒', '黑脸'], ['恼火', '黑脸'], ['黑脸', '黑脸'], ['不爽', '黑脸'],
  ['害羞', '脸红'], ['脸红', '脸红'], ['羞', '脸红'], ['不好意思', '脸红'],
  ['惊讶', '圈圈眼'], ['震惊', '圈圈眼'], ['吃惊', '圈圈眼'], ['意外', '圈圈眼'], ['目瞪口呆', '圈圈眼'],
  ['嫌弃', '屑屑眼'], ['无语', '屑屑眼'], ['嘲讽', '屑屑眼'], ['看不上', '屑屑眼'],
  ['尴尬', '流冷汗'], ['流汗', '流冷汗'], ['紧张', '流冷汗'], ['害怕', '流冷汗'], ['恐惧', '流冷汗'], ['慌', '流冷汗'],
  ['俏皮', '兔牙'], ['调皮', '兔牙'], ['狡黠', '兔牙'], ['坏笑', '兔牙'],
  ['得意', '＞＜'], ['嘿嘿', '＞＜'], ['得意洋洋', '＞＜'],
  ['平静', ''], ['默认', ''], ['中性', ''],
];
const exp = get('exp') || (emotionArg ? (EMOTION_MAP.find(([k]) => emotionArg.includes(k))?.[1] ?? '') : '');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE2D_DIR = join(ROOT, 'data', 'live2d');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.moc3': 'application/octet-stream', '.jpg': 'image/jpeg' };

// 静态服务器
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/render.html';
    p = p.replace(/^\/+/, '');
    const fp = join(LIVE2D_DIR, p);
    const s = await stat(fp);
    if (s.isDirectory()) throw new Error('dir');
    const data = await readFile(fp);
    res.writeHead(200, { 'content-type': MIME[extname(fp).toLowerCase()] || 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const q = new URLSearchParams({ exp, motion, w: W, h: H, bg, scale }).toString();
const url = `http://127.0.0.1:${port}/render.html?${q}`;

// Chrome headless + CDP
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const debugPort = 9333;
const proc = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--remote-debugging-port=' + debugPort, `--window-size=${W},${H}`, 'about:blank'
], { stdio: 'ignore' });

async function waitJson(path, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}${path}`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('chrome devtools not ready');
}

async function main() {
  const tabs = await waitJson('/json/list');
  const tab = tabs.find((t) => t.type === 'page') || tabs[0];
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });

  // 轮询 window.__ready，最多 30s
  let ready = false;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const r = await send('Runtime.evaluate', { expression: 'window.__ready === true', returnByValue: true });
    if (r.result?.result?.value === true) { ready = true; break; }
    if (r.result?.result?.description?.includes('ERROR') || r.result?.exceptionDetails) { break; }
  }
  if (!ready) {
    const r = await send('Runtime.evaluate', { expression: 'document.title + " | " + document.body.textContent.slice(0,120)', returnByValue: true });
    throw new Error('render not ready: ' + (r.result?.result?.value || 'unknown'));
  }
  // 诊断：非背景像素数（判断模型是否真的画出来了）
  const pxr = await send('Runtime.evaluate', { expression: 'window.__px ?? -2', returnByValue: true });
  const exr = await send('Runtime.evaluate', { expression: 'JSON.stringify({exps: window.__exps, motions: window.__motions, expOk: window.__expOk, motOk: window.__motOk})', returnByValue: true });
  console.log('非背景像素:', pxr.result?.result?.value, '| 定义:', exr.result?.result?.value);
  // 直接从 WebGL buffer 取 PNG（比 Page.captureScreenshot 可靠）
  const shot = await send('Runtime.evaluate', { expression: 'window.__shot', returnByValue: true });
  const b64 = shot.result?.result?.value;
  if (typeof b64 !== 'string' || !b64.startsWith('data:image/png')) throw new Error('extract failed: ' + String(b64).slice(0, 60));
  const outPath = resolve(ROOT, out);
  await writeFile(outPath, Buffer.from(b64.split(',')[1], 'base64'));
  console.log('OUT', outPath, `(${W}x${H}, exp=${exp || '(默认)'}, motion=${motion || '(无)'})`);
  ws.close();
}

try { await main(); } finally { proc.kill(); server.close(); }
