// DSH 桌面版的 web 端口每次启动都会变（5297 → 13326 → …），
// 而 config.json 里的 dsh.baseUrl 是写死的。DSH 一重启，桥接就会一直连旧端口，
// 表现是「进程活着、SnowLuma 也连着，但 AI 永远不回话」。
//
// 这里做端口发现：
//   1. 先探测配置里的 baseUrl 是否仍是 DSH；
//   2. 不是的话，找到 DSH 桌面的 host 进程（命令行含 dsh-desktop-host），
//      取它正在 LISTEN 的端口，逐个探测是不是 DSH 根路径，
//      命中就把地址返回给调用方（由调用方决定是否持久化）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PS_TIMEOUT_MS = 10000;

async function runPs(script) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: PS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }
  );
  return String(stdout ?? '').trim();
}

function normalizeBase(baseUrl) {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

/** 探测一个地址是不是 DSH web（未带凭据时 DSH 回 401 + 特定文案）。 */
export async function probeDshBaseUrl(baseUrl, timeoutMs = 1500) {
  const base = normalizeBase(baseUrl);
  if (!base) return false;
  try {
    const res = await fetch(new URL('/', base), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.text().catch(() => '');
    if (/dsh web authentication required/i.test(body)) return true;
    if (/__DSH_BOOT__/.test(body)) return true;
    // 兜底：401 也算（老版本不带那句文案），但 200 必须带 DSH 特征，避免误判别的本地服务。
    if (res.status === 401) return true;
    return false;
  } catch {
    return false;
  }
}

/** 找 DSH 桌面 host 进程 PID（命令行里带 dsh-desktop-host 的那个）。 */
export async function findDshHostPid() {
  const out = await runPs(
    "$p = Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | "
    + "Where-Object { $_.CommandLine -match 'dsh-desktop-host' } | "
    + 'Select-Object -First 1 -ExpandProperty ProcessId; '
    + 'if ($p) { $p }'
  );
  const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  const pid = Number(first);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 列出某个进程占用的本地端口（netstat 解析）。
 * 不用 Get-NetTCPConnection：本机实测该 cmdlet 对 DSH 的监听端口返回空，
 * 而 netstat 里能稳定看到该进程的本地端口（监听端 + 已建立连接的本地端都算候选）。 */
export async function listListeningPorts(pid) {
  const { stdout } = await execFileAsync('netstat', ['-ano'], {
    timeout: PS_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  const ports = new Set();
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const owner = Number(cols[cols.length - 1]);
    if (owner !== pid) continue;
    const local = cols[1] ?? '';
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (Number.isInteger(port) && port > 1024 && port < 65536) ports.add(port);
  }
  return [...ports];
}

/**
 * 解析当前可用的 DSH 地址。
 *
 * findHostPid / listPorts 可注入：默认走真实实现（PowerShell + netstat），
 * 测试里传假函数，这样用例不依赖「本机此刻有没有 DSH 在跑」——
 * 早期版本直接调真实实现，导致同一份代码在不同机器上结果不同（测试假失败）。
 *
 * @param {object} [options]
 * @param {string} [options.current] 配置里的地址
 * @param {(msg: string) => void} [options.log] 诊断日志
 * @param {() => Promise<number|null>} [options.findHostPid] 找 DSH host 进程
 * @param {(pid: number) => Promise<number[]>} [options.listPorts] 列该进程的监听端口
 * @returns {Promise<{ baseUrl: string, changed: boolean, found: boolean }>}
 */
export async function discoverDshBaseUrl({
  current,
  log = () => {},
  findHostPid = findDshHostPid,
  listPorts = listListeningPorts
} = {}) {
  const configured = normalizeBase(current);
  if (configured && await probeDshBaseUrl(configured)) {
    return { baseUrl: configured, changed: false, found: true };
  }

  let pid = null;
  try {
    pid = await findHostPid();
  } catch (error) {
    log(`DSH 端口发现失败（查进程）：${error?.message ?? error}`);
  }
  if (!pid) {
    log(`DSH 端口发现：没找到 DSH 桌面 host 进程（配置地址 ${configured || '(空)'} 也不通）`);
    return { baseUrl: configured, changed: false, found: false };
  }

  let ports = [];
  try {
    ports = await listPorts(pid);
  } catch (error) {
    log(`DSH 端口发现失败（列端口）：${error?.message ?? error}`);
  }

  for (const port of ports) {
    const candidate = `http://127.0.0.1:${port}`;
    if (candidate === configured) continue;
    if (await probeDshBaseUrl(candidate, 1200)) {
      return { baseUrl: candidate, changed: true, found: true };
    }
  }
  log(`DSH 端口发现：host 进程 ${pid} 的监听端口 ${ports.join(', ') || '(空)'} 里没有 DSH web`);
  return { baseUrl: configured, changed: false, found: false };
}
