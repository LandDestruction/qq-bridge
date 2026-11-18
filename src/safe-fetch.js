// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有包含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值也必须是有效 IP；不能把非法地址当成公网地址。
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true;
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isPrivateIp(embedded);
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return true;
}

/**
 * 把校验过的地址排成「尝试顺序」。
 *
 * 为什么不能只取第一个：DNS 返回顺序是**轮转/不确定**的，而本机常常只有 IPv4 出口。
 * QQ 的表情 CDN（gxh.vip.qq.com / p.qpic.cn / multimedia.nt.qq.com.cn）和
 * raw.githubusercontent.com 都同时有 AAAA/A 记录 —— 抢到第一个 AAAA 的那次请求会一路
 * 连到 20 秒超时，其余请求正常，于是表现为「**部分**表情包/图片/网页时好时坏」。
 * 这里优先 IPv4，并把两个族交替排布：v4 全部不可用时还能试 v6（v6-only 主机同理）。
 * @param {{address: string, family: number}[]} addresses
 * @returns {string[]} 地址字符串（已按尝试顺序排列）
 */
function orderAddresses(addresses) {
  const v4 = addresses.filter((item) => Number(item?.family) === 4).map((item) => item.address);
  const v6 = addresses.filter((item) => Number(item?.family) === 6).map((item) => item.address);
  const ordered = [];
  const max = Math.max(v4.length, v6.length);
  for (let i = 0; i < max; i += 1) {
    if (v4[i]) ordered.push(v4[i]);
    if (v6[i]) ordered.push(v6[i]);
  }
  return ordered;
}

/** 解析主机名并校验**全部**解析结果，返回可尝试的地址列表（IPv4 优先）。 */
export async function resolveSafeAddresses(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return [h];
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  const ordered = orderAddresses(addresses);
  return ordered.length ? ordered : [addresses[0].address];
}

export async function resolveSafeHost(hostname) {
  const [first] = await resolveSafeAddresses(hostname);
  return first;
}

export async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, ip: addresses[0], addresses };
}

const REQUEST_TIMEOUT_MS = 20000;
// 多地址时的单次尝试预算：够一次 TCP+TLS+首字节，又不至于让「第一个地址是坏的 IPv6」
// 把整个 20 秒总预算耗光。
const ATTEMPT_TIMEOUT_MS = 8000;
const MAX_ADDRESS_ATTEMPTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
}

/**
 * 用**一个**已校验的地址发起一次尝试，保留原始 Host/SNI（禁止重新解析 DNS）。
 * 返回 `{ok:true,result}` 或 `{ok:false,error,retryable}`；retryable 只标记网络层失败
 * （连接失败/超时/正文中断），大小与图片签名等策略性拒绝不重试。
 */
function attemptOnce(url, address, limit, binary, budgetMs) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    let response;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const fail = (error, retryable) => settle({ ok: false, error, retryable: retryable === true });
    const done = (result) => settle({ ok: true, result });
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`);
      fail(error, true);
      req?.destroy(error);
      response?.destroy();
    }, budgetMs);
    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      req = mod.request({
        hostname: address,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          host: url.host,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          accept: binary ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        timeout: budgetMs,
      }, (res) => {
        response = res;
        res.on('error', (error) => fail(error, true));
        res.on('aborted', () => fail(new Error('响应体读取中断'), true));
        res.on('close', () => {
          if (!res.complete) fail(new Error('响应体读取中断'), true);
        });
        if (settled) { res.destroy(); return; }
        const statusCode = res.statusCode || 0;
        if (REDIRECT_STATUSES.has(statusCode)) {
          done({ statusCode, redirect: String(res.headers.location || '') });
          // 不下载重定向正文：攻击者可以发送无限正文消耗连接和带宽。
          res.destroy();
          return;
        }
        const chunks = [];
        const decoder = binary ? null : new StringDecoder('utf8');
        let size = 0;
        const appendText = (text) => {
          const points = Array.from(text);
          const remaining = limit - size;
          chunks.push(points.slice(0, remaining).join(''));
          size += Math.min(points.length, remaining);
          if (size >= limit) {
            done({ statusCode, body: chunks.join(''), truncated: true });
            res.destroy();
          }
        };
        res.on('data', (chunk) => {
          if (settled) return;
          if (!binary) { appendText(decoder.write(chunk)); return; }
          size += chunk.length;
          if (size > limit) {
            fail(new Error(`图片超过大小限制（${limit} 字节）`), false);
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (binary) done({ statusCode, buffer: Buffer.concat(chunks) });
          else {
            appendText(decoder.end());
            done({ statusCode, body: chunks.join(''), truncated: false });
          }
        });
      });
      req.on('timeout', () => {
        const error = new Error(`请求超时：${url.hostname}`);
        fail(error, true);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => fail(error, true));
      req.end();
    } catch (error) {
      fail(error, true);
      req?.destroy();
    }
  });
}

/**
 * 依次尝试已校验的地址（IPv4 优先，见 orderAddresses）。
 *
 * 单地址时沿用原来的「整个 20 秒总预算」，多地址时才启用单次尝试预算与失败切换：
 * 这样「只有一个地址、对方慢慢滴流」仍然会等满总时限（由总 deadline 兜底），
 * 而「第一个地址是坏的 IPv6」不会再白等 20 秒。
 * 所有地址都失败时抛最后一个错误（保留原始错误文案，便于日志排查）。
 */
async function requestOnce(url, addresses, limit, binary = false) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error(`没有可用地址：${url.hostname}`);
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let lastError = null;
  const attempts = Math.min(list.length, MAX_ADDRESS_ATTEMPTS);
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 250) break;
    const budget = list.length === 1
      ? REQUEST_TIMEOUT_MS
      : Math.min(ATTEMPT_TIMEOUT_MS, remaining);
    const outcome = await attemptOnce(url, list[i], limit, binary, budget);
    if (outcome.ok) return outcome.result;
    lastError = outcome.error;
    if (!outcome.retryable) throw outcome.error;
    if (i < attempts - 1) {
      // 换地址重试：只换连接目标，Host/SNI/路径全部不变（同一个站点）。
      continue;
    }
  }
  if (lastError && attempts > 1) {
    lastError.message = `${lastError.message}（已尝试 ${attempts} 个地址）`;
  }
  throw lastError ?? new Error(`请求失败：${url.hostname}`);
}

export async function safeFetch(urlString, maxChars = 50000) {
  validateLimit(maxChars, 'maxChars');
  const MAX_REDIRECTS = 5;
  let { url, addresses } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, addresses, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, addresses } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function imageContentType(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'application/octet-stream';
}

/**
 * 按**魔数**判定真实图片类型（不信任服务端声明的 Content-Type）。
 * 实测：智谱 cogview-3-flash 返回的是 **JPEG**，而代码里曾写死 image/png ——
 * 调用方按声明的类型把 JPEG 存成 .png，read_image 会直接报「扩展名与字节不符」。
 */
export function looksLikeImageBuffer(buf) {
  return imageContentType(buf) !== 'application/octet-stream';
}

/**
 * 按字节上限「流式」读取响应体：读满上限就停，绝不把整段响应读进内存。
 *
 * 为什么需要它：safeFetchBuffer 是给图片用的（还要求内容真的是 PNG/JPEG/GIF/WebP，
 * 超限直接失败），而 QQ 网关给的视频地址经常是本机地址、内容也不是图片；
 * 直接用 safeFetchBuffer 要么被 SSRF 校验拒掉，要么被图片魔数校验拒掉。
 * 这里只做一件事：有上限地读字节，超限返回 truncated=true。
 *
 * @param {AsyncIterable<Uint8Array>|ReadableStream|null} body 响应体（fetch 的 body 即可）
 * @param {number} maxBytes 字节上限
 * @returns {Promise<{buffer: Buffer, truncated: boolean, bytesRead: number}>}
 */
export async function readBodyBounded(body, maxBytes) {
  validateLimit(maxBytes, 'maxBytes');
  if (!body) return { buffer: Buffer.alloc(0), truncated: false, bytesRead: 0 };
  let iterator;
  if (typeof body[Symbol.asyncIterator] === 'function') iterator = body[Symbol.asyncIterator]();
  else if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    iterator = { next: () => reader.read(), return: () => reader.cancel() };
  } else throw new Error('响应体不可读');
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const step = await iterator.next();
    if (!step || step.done) break;
    const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value ?? []);
    if (!chunk.length) continue;
    const room = maxBytes - size;
    if (room <= 0) { truncated = true; break; }
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      size = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  if (truncated && typeof iterator.return === 'function') {
    // 主动断开：别让剩余正文继续往下流（这是「不整段读入」的关键）。
    try { await iterator.return(); } catch {}
  }
  return { buffer: Buffer.concat(chunks), truncated, bytesRead: size };
}

/**
 * 抓取**任意二进制**（群文件转存用）：同样逐跳做 SSRF 校验、按 maxBytes 限量读入。
 * 与 safeFetchBuffer 的区别是**不校验图片签名**——调用方负责校验业务格式。
 * 超限时 truncated=true，调用方必须据此拒绝落盘（不保存半截文件）。
 *
 * 注意：这里把正文读进内存，因此调用方必须用 fileArchive.maxFileMb 收紧 maxBytes；
 * 真正的流式落盘需要改 requestOnce 的采集方式（当前复用已验证的读法，换取更小的改动面）。
 */
export async function safeFetchBinary(urlString, maxBytes = 8 * 1024 * 1024) {
  validateLimit(maxBytes, 'maxBytes');
  const MAX_REDIRECTS = 5;
  let { url, addresses } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, addresses, maxBytes, true);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, addresses } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`文件下载失败：HTTP ${result.statusCode}`);
    }
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      buffer: result.buffer,
      truncated: result.truncated === true
    };
  }
  throw new Error('重定向次数过多，已停止');
}

// 大文件下载的时限口径：**不再用「总预算」**（2.5GB 在慢速网络上不可能 20 秒下完），
// 改成「单次 socket 空闲超时 + 一个宽松的总上限」：只要还在持续收数据就不算超时。
const DOWNLOAD_IDLE_TIMEOUT_MS = 120000;
const DOWNLOAD_MAX_TOTAL_MS = 3 * 60 * 60 * 1000;

/**
 * 把一段响应体**流式**写进 destPath：逐块计数、逐块更新 sha256、绝不 Buffer.concat 整段。
 *
 * 这是「2.5GB 落盘不炸内存」的核心：无论文件多大，内存里最多只有一个 chunk。
 * 超过 maxBytes 立即停止、删掉半截文件，并抛 `code='ARCHIVE_TOO_LARGE'`（带已写入字节数）。
 * 任何失败（超限/写盘错误/超时/中断）都会在 finally 里删掉目标文件，不留 `.tmp-*` 垃圾。
 *
 * @param {AsyncIterable<Uint8Array>|ReadableStream|{getReader:Function}} body 响应体
 * @param {string} destPath 目标临时文件（调用方保证独占；用 'wx' 打开）
 * @param {{maxBytes:number, timeoutMs?:number}} opts timeoutMs = 单次无数据空闲超时
 * @returns {Promise<{bytes:number, sha256:string}>}
 */
export async function streamBodyToFile(body, destPath, { maxBytes, timeoutMs = 0 } = {}) {
  validateLimit(maxBytes, 'maxBytes');
  if (!body) throw new Error('响应体不可读');
  let iterator;
  if (typeof body[Symbol.asyncIterator] === 'function') iterator = body[Symbol.asyncIterator]();
  else if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    iterator = { next: () => reader.read(), return: () => reader.cancel() };
  } else throw new Error('响应体不可读');

  const hash = crypto.createHash('sha256');
  const ws = fs.createWriteStream(destPath, { flags: 'wx' });
  let streamError = null;
  ws.on('error', (error) => { streamError = error; });
  let bytes = 0;
  let finished = false;
  let idleTimer = null;
  const armIdle = () => {
    if (!(timeoutMs > 0)) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { streamError = streamError || new Error(`下载超时（${timeoutMs}ms 无数据）`); }, timeoutMs);
    idleTimer.unref?.();
  };
  const cleanup = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    try { iterator.return?.(); } catch {}
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        ws.once('close', finish);
        ws.destroy();
        setTimeout(finish, 200).unref?.();
      } catch { finish(); }
    });
    try { fs.unlinkSync(destPath); } catch {}
  };
  try {
    armIdle();
    for (;;) {
      const step = await iterator.next();
      if (!step || step.done) break;
      const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value ?? []);
      if (!chunk.length) continue;
      armIdle();
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = new Error(`文件超过大小限制（${maxBytes} 字节）`);
        error.code = 'ARCHIVE_TOO_LARGE';
        error.bytes = bytes - chunk.length;
        throw error;
      }
      hash.update(chunk);
      if (!ws.write(chunk)) {
        await new Promise((resolve, reject) => {
          const onDrain = () => { ws.off('error', onError); resolve(); };
          const onError = (error) => { ws.off('drain', onDrain); reject(error); };
          ws.once('drain', onDrain);
          ws.once('error', onError);
        });
      }
      if (streamError) throw streamError;
    }
    if (streamError) throw streamError;
    await new Promise((resolve, reject) => {
      ws.end((error) => (error ? reject(error) : resolve()));
      ws.once('error', reject);
    });
    finished = true;
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    if (!finished) await cleanup();
  }
}

/**
 * 单次流式尝试：把响应体直接写进 destPath，边写边算 sha256，**不占内存**。
 * 与 attemptOnce 同一套 SSRF 约束：地址已校验、Host/SNI 固定、逐跳由调用方重新校验。
 * 真正的写盘/计数/超限中止都交给 streamBodyToFile（那是可单测的纯流式实现）。
 */
function attemptStreamToFile(url, address, destPath, maxBytes, idleMs) {
  return new Promise((resolve) => {
    let settled = false;
    let req;
    let response;
    let streaming = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const fail = (error, retryable = true) => {
      req?.destroy(error);
      response?.destroy();
      settle({ ok: false, error, retryable });
    };
    const done = (result) => settle({ ok: true, result });
    const timer = setTimeout(() => {
      // 正在流式：销毁响应让 streamBodyToFile 抛错并自行删 tmp；未开始则直接结束。
      if (streaming) {
        response?.destroy(new Error(`文件下载超时：${url.hostname}`));
        return;
      }
      fail(new Error(`文件下载超时：${url.hostname}`), true);
    }, DOWNLOAD_MAX_TOTAL_MS);
    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      req = mod.request({
        hostname: address,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          host: url.host,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          accept: '*/*',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
        servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        timeout: idleMs,
      }, (res) => {
        response = res;
        const statusCode = res.statusCode || 0;
        if (REDIRECT_STATUSES.has(statusCode)) {
          res.destroy();
          done({ statusCode, redirect: String(res.headers.location || '') });
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.destroy();
          done({ statusCode });
          return;
        }
        streaming = true;
        streamBodyToFile(res, destPath, { maxBytes, timeoutMs: idleMs }).then((result) => {
          done({
            statusCode,
            bytes: result.bytes,
            sha256: result.sha256,
            contentType: String(res.headers['content-type'] || '')
          });
        }).catch((error) => {
          if (error?.code === 'ARCHIVE_TOO_LARGE') {
            done({ statusCode, truncated: true, bytes: Number(error.bytes) || 0 });
            return;
          }
          fail(error, true);
        });
      });
      req.on('timeout', () => {
        fail(new Error(`文件下载超时（${idleMs}ms 无数据）：${url.hostname}`), true);
      });
      req.on('error', (error) => fail(error, true));
      req.end();
    } catch (error) {
      fail(error, true);
      req?.destroy();
    }
  });
}

/**
 * 把任意大小的文件**流式**下载到 destPath（群文件转存用，2.5GB 也不会撑爆内存）。
 *
 * 与 safeFetchBinary 的区别：不把正文读进内存，边下边写盘、边算 sha256；
 * 逐跳重定向仍重新做 SSRF 校验；超过 maxBytes 时删掉半截文件并返回 truncated=true。
 * 调用方负责提供**本进程独占**的临时路径（已存在会失败，flags: 'wx'）。
 *
 * 兼容两种调用：`safeFetchToFile(url, dest, { maxBytes, timeoutMs })` 或旧的
 * `safeFetchToFile(url, dest, maxBytes)`（第三个参数是数字时按 maxBytes 处理）。
 *
 * @returns {Promise<{url:string,statusCode:number,bytes:number,sha256:string,
 *   contentType:string,truncated:boolean}>}
 */
export async function safeFetchToFile(urlString, destPath, options = {}) {
  const opts = typeof options === 'number' ? { maxBytes: options } : (options ?? {});
  const maxBytes = Number(opts.maxBytes);
  validateLimit(maxBytes, 'maxBytes');
  const idleMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DOWNLOAD_IDLE_TIMEOUT_MS;
  const MAX_REDIRECTS = 5;
  let { url, addresses } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
    if (!list.length) throw new Error(`没有可用地址：${url.hostname}`);
    let lastError = null;
    let redirected = false;
    const attempts = Math.min(list.length, MAX_ADDRESS_ATTEMPTS);
    for (let k = 0; k < attempts; k += 1) {
      const outcome = await attemptStreamToFile(url, list[k], destPath, maxBytes, idleMs);
      if (outcome.ok) {
        const result = outcome.result;
        if (REDIRECT_STATUSES.has(result.statusCode)) {
          if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
          ({ url, addresses } = await validateFetchUrl(new URL(result.redirect, url).toString()));
          redirected = true;
          break;
        }
        if (result.statusCode < 200 || result.statusCode >= 300) {
          throw new Error(`文件下载失败：HTTP ${result.statusCode}`);
        }
        if (result.truncated) {
          return {
            url: url.toString(),
            statusCode: result.statusCode,
            bytes: Number(result.bytes) || 0,
            sha256: '',
            contentType: '',
            truncated: true
          };
        }
        return {
          url: url.toString(),
          statusCode: result.statusCode,
          bytes: Number(result.bytes) || 0,
          sha256: String(result.sha256 || ''),
          contentType: String(result.contentType || ''),
          truncated: false
        };
      }
      lastError = outcome.error;
      if (!outcome.retryable) throw outcome.error;
    }
    if (redirected) continue;
    if (lastError) throw lastError;
    throw new Error(`下载失败：${url.hostname}`);
  }
  throw new Error('重定向次数过多，已停止');
}

/** 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。 */
export async function safeFetchBuffer(urlString, maxBytes = 8 * 1024 * 1024) {
  validateLimit(maxBytes, 'maxBytes');
  const MAX_REDIRECTS = 5;
  let { url, addresses } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, addresses, maxBytes, true);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, addresses } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}
