#!/usr/bin/env node
// 一次性把 PolyForm Noncommercial 1.0.0 的官方全文落到仓库里（LICENSE.polyform-nc）。
// 网络不可用时退出码 2，并在 stderr 给出可手工放置的说明；不会覆盖已存在且校验通过的文件。
// 注意：这里不用 process.exit()——undici 的 keep-alive 连接在 exit 时会触发 libuv 断言（Windows）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..'
);
const OUT = path.join(ROOT, 'LICENSE.polyform-nc');
const API_URL =
  'https://api.github.com/repos/polyformproject/polyform-licenses/contents/PolyForm-Noncommercial-1.0.0.md';
const CANDIDATES = [
  'https://raw.githubusercontent.com/polyformproject/polyform-licenses/main/PolyForm-Noncommercial-1.0.0.md',
  'https://polyformproject.org/licenses/noncommercial/1.0.0/'
];

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normalize(text) {
  return String(text).replace(/\r\n/g, '\n').trim() + '\n';
}

function looksRight(text) {
  return /PolyForm Noncommercial/i.test(text) && text.length > 2000;
}

async function fetchViaGitHubApi() {
  const res = await fetch(API_URL, {
    headers: {
      'User-Agent': 'qq-deepseek-bot-license-fetch',
      accept: 'application/vnd.github+json'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const json = await res.json();
  if (!json || typeof json.content !== 'string') throw new Error('GitHub API 返回里没有 content');
  return Buffer.from(json.content, json.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
}

function writeOut(text, source) {
  fs.writeFileSync(OUT, text, 'utf8');
  console.log(`已写入 ${path.relative(ROOT, OUT)}（${source}）`);
  console.log(`  字符数：${text.length}`);
  console.log(`  sha256：${sha(fs.readFileSync(OUT))}`);
  console.log('  许可证：PolyForm Noncommercial 1.0.0（SPDX: PolyForm-Noncommercial-1.0.0）');
}

async function main() {
  if (fs.existsSync(OUT)) {
    const text = fs.readFileSync(OUT, 'utf8');
    if (looksRight(text)) {
      console.log(
        `已存在：${path.relative(ROOT, OUT)}（${text.length} 字符，sha256 ${sha(fs.readFileSync(OUT))}）`
      );
      return 0;
    }
    console.warn('已存在的 LICENSE.polyform-nc 看起来不完整，将尝试重新获取。');
  }

  let lastErr = null;

  try {
    const apiText = normalize(await fetchViaGitHubApi());
    if (!looksRight(apiText)) throw new Error(`API 内容看起来不对（${apiText.length} 字符）`);
    writeOut(apiText, 'GitHub contents API');
    return 0;
  } catch (error) {
    lastErr = error;
  }

  for (const url of CANDIDATES) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = normalize(await res.text());
      if (/<html/i.test(text.slice(0, 200))) {
        throw new Error('拿到的是 HTML 页面而不是纯文本（请改用 GitHub 原始地址）');
      }
      if (!looksRight(text)) throw new Error(`内容看起来不对（${text.length} 字符）`);
      writeOut(text, url);
      return 0;
    } catch (error) {
      lastErr = error;
    }
  }

  console.error('获取失败：' + (lastErr && lastErr.message ? lastErr.message : String(lastErr)));
  console.error('手工方案：从 https://polyformproject.org/licenses/noncommercial/1.0.0/ 复制全文，');
  console.error('存为仓库根目录的 LICENSE.polyform-nc（UTF-8、纯文本），再运行本脚本校验。');
  return 2;
}

process.exitCode = await main();
