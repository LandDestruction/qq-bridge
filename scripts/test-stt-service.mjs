// 常驻 STT 服务客户端离线测试：假 HTTP 服务 + 假 spawn，不依赖 python / whisper。
//
// 覆盖（对应交接里的测试清单）：
//   · 桥接优先走服务（服务健康时不 spawn、结果来自服务）；
//   · 服务挂/500 → 自动回退 CLI，功能不丢；
//   · enabled=false → 直接走 CLI；
//   · 懒启动只 spawn 一次，参数/环境变量正确；
//   · /api/status 用的 status() 字段（running/model/loadedAt/lastMs）。
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSttService, normalizeSttServiceConfig } from "../src/stt-service.js";

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("✅ " + name);
  } catch (error) {
    failed += 1;
    console.error("❌ " + name + " — " + (error?.stack ?? error?.message ?? error));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stt-service-test-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
const scriptPath = path.join(tmpRoot, "stt_server.py");
fs.writeFileSync(scriptPath, "# fake\n");
const wav = Buffer.alloc(2048, 7);

/** 假转写服务；port=0 时由系统分配。 */
function startFakeService({ route = "ok", latencyMs = 0, port = 0 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const send = (status, body) => {
        const buf = Buffer.from(JSON.stringify(body), "utf8");
        res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
        res.end(buf);
      };
      if (req.method === "GET" && req.url === "/health") {
        send(200, { ok: true, model: "small", loaded: true, loadedAtMs: 1760000000000, lastMs: 7, pid: 4242 });
        return;
      }
      if (req.method === "POST" && req.url === "/transcribe") {
        let body = {};
        try { body = JSON.parse(raw || "{}"); } catch {}
        const entry = {
          path: String(body.path || ""),
          lang: body.lang,
          exists: body.path ? fs.existsSync(body.path) : false,
          bytes: body.path && fs.existsSync(body.path) ? fs.statSync(body.path).size : 0
        };
        seen.push(entry);
        const reply = () => {
          if (route === "error500") { send(500, { ok: false, error: "模型炸了" }); return; }
          send(200, { ok: true, text: `服务转写：收到 ${entry.bytes} 字节`, segments: [{ start: 0, end: 1, text: "x" }], lang: "zh", ms: 12, model: "small" });
        };
        if (latencyMs) setTimeout(reply, latencyMs);
        else reply();
        return;
      }
      send(404, { ok: false, error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

/** 先占一个端口再放开，拿到"当前空闲"的端口号。 */
async function freePort() {
  const probe = await startFakeService();
  const p = probe.port;
  await new Promise((r) => probe.server.close(r));
  return p;
}

await check("配置归一化：非法值落回默认，enabled=false 保留", () => {
  const d = normalizeSttServiceConfig({});
  assert.equal(d.enabled, true);
  assert.equal(d.port, 8791);
  assert.equal(d.model, "small");
  assert.equal(d.idleUnloadMs, 1800000);
  assert.equal(d.python, "python");
  assert.equal(normalizeSttServiceConfig({ python: " C:\\Python310\\python.exe " }).python, "C:\\Python310\\python.exe");
  const bad = normalizeSttServiceConfig({ enabled: false, port: "abc", idleUnloadMs: -5 });
  assert.equal(bad.enabled, false);
  assert.equal(bad.port, 8791);
  assert.equal(bad.idleUnloadMs, 1800000);
});

await check("服务健康 → 优先走服务，不调用 CLI，临时 wav 在服务端可读", async () => {
  const fake = await startFakeService();
  let cliCalls = 0;
  let spawned = 0;
  const svc = createSttService({
    getConfig: () => ({ enabled: true, port: fake.port }),
    scriptPath,
    stateDir,
    cliTranscribe: async () => { cliCalls += 1; return { ok: true, text: "CLI 转写" }; },
    spawnImpl: () => { spawned += 1; throw new Error("不应该 spawn"); }
  });
  try {
    const r = await svc.transcribe(wav, { model: "small", lang: "zh" });
    assert.equal(r.ok, true);
    assert.equal(r.source, "service");
    assert.match(r.text, /服务转写/);
    assert.equal(cliCalls, 0);
    assert.equal(spawned, 0);
    assert.equal(fake.seen.length, 1);
    assert.equal(fake.seen[0].exists, true, "POST 时 wav 必须已经落盘");
    assert.equal(fake.seen[0].bytes, wav.length);
    assert.equal(fake.seen[0].lang, "zh");
    const st = svc.status();
    assert.equal(st.running, true);
    assert.equal(st.model, "small");
    assert.equal(st.loadedAt, 1760000000000);
    assert.equal(st.lastMs, 12);
    assert.equal(st.source, "service");
  } finally {
    svc.stop();
    fake.server.close();
  }
});

await check("服务不可达 → 回退 CLI（不丢功能）", async () => {
  const port = await freePort();
  let cliCalls = 0;
  const svc = createSttService({
    getConfig: () => ({ enabled: true, port, spawnTimeoutMs: 500 }),
    scriptPath,
    stateDir,
    cliTranscribe: async () => { cliCalls += 1; return { ok: true, text: "CLI 兜底", ms: 3 }; },
    // python 不存在：error 事件让 ensureStarted 立刻失败，不用等满 500ms
    spawnImpl: () => ({
      pid: 1,
      on(event, cb) { if (event === "error") setTimeout(() => cb(new Error("spawn ENOENT")), 5); },
      kill() {}
    })
  });
  try {
    const r = await svc.transcribe(wav, { model: "small" });
    assert.equal(r.ok, true);
    assert.equal(r.source, "cli");
    assert.equal(r.text, "CLI 兜底");
    assert.equal(cliCalls, 1);
    assert.ok(r.fallbackReason, "应记录回退原因");
    const st = svc.status();
    assert.equal(st.running, false);
    assert.equal(st.source, "cli");
  } finally {
    svc.stop();
  }
});

await check("服务返回 500 → 回退 CLI，且 status 不再报 running", async () => {
  const fake = await startFakeService({ route: "error500" });
  let cliCalls = 0;
  const svc = createSttService({
    getConfig: () => ({ enabled: true, port: fake.port }),
    scriptPath,
    stateDir,
    cliTranscribe: async () => { cliCalls += 1; return { ok: true, text: "CLI 兜底 2" }; },
    spawnImpl: () => { throw new Error("不应该 spawn"); }
  });
  try {
    const r = await svc.transcribe(wav, {});
    assert.equal(r.ok, true);
    assert.equal(r.source, "cli");
    assert.equal(cliCalls, 1);
    assert.match(String(r.fallbackReason), /模型炸了|HTTP 500/);
    assert.equal(svc.status().running, false);
  } finally {
    svc.stop();
    fake.server.close();
  }
});

await check("enabled=false → 直接 CLI，不 spawn、不探测服务", async () => {
  let cliCalls = 0;
  let spawned = 0;
  const svc = createSttService({
    getConfig: () => ({ enabled: false, port: 8791 }),
    scriptPath,
    stateDir,
    cliTranscribe: async () => { cliCalls += 1; return { ok: true, text: "旧 CLI 路径" }; },
    spawnImpl: () => { spawned += 1; throw new Error("不应该 spawn"); }
  });
  const r = await svc.transcribe(wav, {});
  assert.equal(r.source, "cli");
  assert.equal(cliCalls, 1);
  assert.equal(spawned, 0);
  const st = svc.status();
  assert.equal(st.enabled, false);
  assert.equal(st.running, false);
});

await check("懒启动：首次转写才 spawn，之后复用（只 spawn 一次，参数/环境正确）", async () => {
  const port = await freePort();
  const calls = [];
  let fake = null;
  const svc = createSttService({
    getConfig: () => ({ enabled: true, port, spawnTimeoutMs: 8000 }),
    scriptPath,
    stateDir,
    cliTranscribe: async () => ({ ok: true, text: "不该走这里" }),
    spawnImpl: (cmd, args, opts) => {
      calls.push({ cmd, args, opts, env: opts?.env });
      startFakeService({ port }).then((f) => { fake = f; });
      return { pid: 888, on() {}, kill() { try { fake?.server.close(); } catch {} } };
    }
  });
  try {
    const r = await svc.transcribe(wav, {});
    assert.equal(r.ok, true);
    assert.equal(r.source, "service");
    assert.match(r.text, /服务转写/);
    assert.equal(calls.length, 1, "只应 spawn 一次");
    assert.equal(calls[0].args[calls[0].args.indexOf("--model") + 1], "small");
    assert.equal(calls[0].args[calls[0].args.indexOf("--idle-unload-ms") + 1], "1800000");
    assert.equal(calls[0].args[calls[0].args.indexOf("--port") + 1], String(port));
    assert.ok(calls[0].args.includes("--log-file"));
    assert.equal(calls[0].env.PYTHONIOENCODING, "utf-8");
    const r2 = await svc.transcribe(wav, {});
    assert.equal(r2.ok, true);
    assert.equal(calls.length, 1, "第二次转写应复用同一进程");
  } finally {
    svc.stop();
    try { fake?.server.close(); } catch {}
  }
});

await check("status().lastMs 在 CLI 回退后仍可观测", async () => {
  const svc = createSttService({
    getConfig: () => ({ enabled: false }),
    scriptPath,
    stateDir,
    cliTranscribe: async () => ({ ok: true, text: "x", ms: 42 })
  });
  await svc.transcribe(wav, {});
  assert.equal(svc.status().lastMs, 42);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} 个用例失败`);
  process.exit(1);
}
console.log("\n🎉 常驻转写服务客户端测试通过");
