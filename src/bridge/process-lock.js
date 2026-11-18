// process-lock: extracted bridge responsibilities; no startup side effects.
// Live dependencies: BRIDGE_LOG, LOCK_FILE, ROOT, STATE_DIR, console, decideLock, execFileSync, fs, path, readJsonSafe, staleLogMs
export function createProcessLock(deps) {
// @bridge-function consolePortInUse:start
function consolePortInUse() {
  try {
    const cfg = (0, deps.readJsonSafe)(deps.path.join(deps.ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = (0, deps.execFileSync)('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = (0, deps.execFileSync)('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}
// @bridge-function consolePortInUse:end

// @bridge-function consolePortOwnerPid:start
function consolePortOwnerPid() {
  try {
    const cfg = (0, deps.readJsonSafe)(deps.path.join(deps.ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = (0, deps.execFileSync)('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split('\n')) {
        if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
        if (!/LISTENING/i.test(line)) continue;
        const m = /(\d+)\s*$/.exec(line.trim());
        if (m) return Number(m[1]);
      }
      return null;
    }
    const out = (0, deps.execFileSync)('sh', ['-c', 'ss -ltnp 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = new RegExp(`[:.]${port}\\s.*pid=(\\d+)`).exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
// @bridge-function consolePortOwnerPid:end

// @bridge-function bridgeLogIdleMs:start
function bridgeLogIdleMs() {
  try {
    return Date.now() - deps.fs.statSync(deps.BRIDGE_LOG).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
// @bridge-function bridgeLogIdleMs:end

// @bridge-function consoleProbeResponsive:start
function consoleProbeResponsive(port, timeoutMs = 2000) {
  const args = ['-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{http_code}', '-m', String(Math.max(1, Math.ceil(timeoutMs / 1000))), `http://127.0.0.1:${port}/api/health`];
  const bin = process.platform === 'win32' ? 'curl.exe' : 'curl';
  try {
    const out = (0, deps.execFileSync)(bin, args, { encoding: 'utf8', timeout: timeoutMs + 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    const code = Number(String(out).trim());
    return Number.isFinite(code) && code > 0;
  } catch (error) {
    if (error?.error?.code === 'ENOENT') return null; // 没有 curl：不知道，别据此杀
    if (error?.status === 28) return false;            // curl 自己的超时码 = 协议层没应答
    if (error?.code === 'ETIMEDOUT') return false;     // execFileSync 超时 = 没应答
    return null;
  }
}
// @bridge-function consoleProbeResponsive:end

// @bridge-function terminatePidAndWait:start
function terminatePidAndWait(pid, timeoutMs = 5000) {
  try {
    if (process.platform === 'win32') {
      (0, deps.execFileSync)('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000 });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // 权限不足 / 进程已退出：下面用端口探测判断结果
  }
  const sleep = (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!consolePortInUse()) return true;
    sleep(250);
  }
  return !consolePortInUse();
}
// @bridge-function terminatePidAndWait:end

// @bridge-function acquireLock:start
function acquireLock() {
  deps.fs.mkdirSync(deps.STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      deps.fs.writeFileSync(deps.LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = deps.fs.readFileSync(deps.LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加两道判据：控制台端口 + 日志新鲜度。
          const portInUse = consolePortInUse();
          const lockCfg = (0, deps.readJsonSafe)(deps.path.join(deps.ROOT, 'config.json'), {});
          const consolePort = Number(lockCfg?.consolePort) || 3100;
          const verdict = (0, deps.decideLock)({
            pidAlive: true,
            portInUse,
            logIdleMs: bridgeLogIdleMs(),
            staleLogMs: (0, deps.staleLogMs)(lockCfg?.lock?.staleLogMinutes),
            // 不管 netstat 怎么说都探一次活：它可能把监听套接字报成 CLOSED（实测过）。
            responsive: consoleProbeResponsive(consolePort)
          });
          if (verdict.action === 'takeover') {
            stale = true;
          } else if (verdict.action === 'suspect-hung') {
            // 端口被占、PID 活着，但日志早就停了 —— 就是那次「离线事故」的形态：
            // 进程僵死却仍持有监听套接字，新实例于是永久放弃启动，而 taskkill 又常常没权限。
            const idleMin = Math.round(bridgeLogIdleMs() / 60000);
            const owner = consolePortOwnerPid();
            if (owner === pid) {
              deps.console.error(`[bridge] 锁 PID ${pid} 占着控制台端口但 ${idleMin} 分钟没写日志，判定僵死，尝试接管…`);
              if (terminatePidAndWait(pid)) {
                deps.console.error('[bridge] 僵死实例已终止，接管锁文件。');
                stale = true;
              } else {
                deps.console.error(`[bridge] 终止僵死实例失败。请用管理员权限执行：taskkill /F /PID ${pid}，然后重新启动桥接。`);
                process.exit(2);
              }
            } else {
              deps.console.error(`[bridge] 控制台端口被 PID ${owner ?? '未知'} 占用（不是锁里的 ${pid}），且日志 ${idleMin} 分钟未更新。`);
              deps.console.error('[bridge] 请先确认端口占用：netstat -ano | findstr :3100，处理后重新启动。');
              process.exit(2);
            }
          } else {
            deps.console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${deps.LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              deps.console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            deps.console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            deps.console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${deps.LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    deps.console.error(`[bridge] 无法读取锁文件 ${deps.LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    deps.console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { deps.fs.unlinkSync(deps.LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  deps.console.error(`[bridge] 已有实例在运行（锁文件 ${deps.LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
// @bridge-function acquireLock:end

// @bridge-function releaseLock:start
function releaseLock() {
  try {
    if (deps.fs.existsSync(deps.LOCK_FILE) && Number(deps.fs.readFileSync(deps.LOCK_FILE, 'utf8').trim()) === process.pid) {
      deps.fs.unlinkSync(deps.LOCK_FILE);
    }
  } catch {}
}
// @bridge-function releaseLock:end
  return { consolePortInUse, consolePortOwnerPid, bridgeLogIdleMs, consoleProbeResponsive, terminatePidAndWait, acquireLock, releaseLock };
}
