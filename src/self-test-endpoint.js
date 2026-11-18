// 自测端点解析与错误分类（纯函数，可脱网单测）。
//
// 背景：`npm run self-test` 以前把默认端点硬编码成 127.0.0.1:3080，本机没人监听，
// 于是永远输出一句没有上下文的 "fetch failed"。这里把「端点从哪来」和「失败到底为什么」
// 拆成可测的纯逻辑，self-test.js 只负责调用。

import fs from 'node:fs';
import path from 'node:path';

/** 去掉尾部斜杠并校验协议；不合法返回 null。 */
export function normalizeBaseUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * 解析自测要连的 DSH 端点。
 * 优先级：命令行参数 > 环境变量 DSH_BASE_URL > config.json 的 dsh.baseUrl。
 * 都不合法时返回 { url: null, source: 'none' }，由调用方给出可操作提示（不再假装有个默认端口）。
 */
export function resolveSelfTestBaseUrl({ argvBase, envBase, configBase } = {}) {
  const candidates = [
    { raw: argvBase, source: 'argv' },
    { raw: envBase, source: 'env' },
    { raw: configBase, source: 'config' }
  ];
  for (const c of candidates) {
    const url = normalizeBaseUrl(c.raw);
    if (url) return { url, source: c.source };
  }
  return { url: null, source: 'none' };
}

/** 从 config.json 里读 dsh.baseUrl；读不到返回 null（不抛，自测要能继续跑）。 */
export function readConfigDshBaseUrl(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return cfg?.dsh?.baseUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * 把底层失败翻译成「连的是谁 + 为什么」。
 * 覆盖：连接被拒、域名解析失败、超时、401/403、HTTP 非 2xx、响应不像 DSH。
 */
export function describeConnectFailure(error, url) {
  const msg = String(error?.message ?? error ?? '');
  const code = String(error?.cause?.code ?? error?.code ?? '');
  const where = url ? `目标端点 ${url}` : '目标端点（未确定）';

  if (/ECONNREFUSED/.test(code) || /ECONNREFUSED/.test(msg)) {
    return `${where}：连接被拒（端口没人监听）。先确认 DSH 正在运行，再核对 config.json 的 dsh.baseUrl。`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code) || /ENOTFOUND|getaddrinfo/.test(msg)) {
    return `${where}：域名解析失败（地址写错了或没有网络）。`;
  }
  if (/ECONNRESET/.test(code) || /socket hang up/i.test(msg)) {
    return `${where}：连接被重置（对端不是 HTTP 服务，或进程刚退出）。`;
  }
  if (/TimeoutError|AbortError|timed out|timeout/i.test(`${error?.name} ${msg}`)) {
    return `${where}：请求超时。DSH 可能卡在启动或负载过高。`;
  }
  if (/\b401\b/.test(msg)) {
    return `${where}：鉴权失败（401）。config.json 的 dsh.authToken 与 DSH 实际密钥不一致，或 DSH_HOME 指到了别的 .dsh。`;
  }
  if (/\b403\b/.test(msg)) {
    return `${where}：被拒绝（403）。可能需要 dsh.allowRemote 或换成本机地址。`;
  }
  if (/\b404\b/.test(msg)) {
    return `${where}：路径不存在（404）。端口可能被别的服务占用，或 DSH 版本不匹配。`;
  }
  if (/invalid server-response/i.test(msg)) {
    return `${where}：响应不像 DSH 的 RPC 信封（端口指向了别的服务？）。`;
  }
  return `${where}：${msg || '未知错误'}`;
}
