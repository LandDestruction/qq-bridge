// 常驻转写服务客户端：懒启动 tools/stt_server.py，失败自动回退现有 CLI。
//
// 背景（2026-10-25 实测）：`stt_cli.py` 每次调用都要重新 `WhisperModel()` 加载模型，
// 16s 中文视频冷启动约 6s；而转写本身只要 1~2s。做成常驻服务后，冷启动只付一次，
// 之后的视频转写只付转写时间。服务是**可选加速层**，不是新依赖：启不来/挂了/返回
// 异常都回退到 `transcribeWav`（CLI），功能绝不因此丢失。
//
// 本模块不碰 bridge 的全局状态，便于离线测试：spawn / fetch / CLI 都可以注入。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { buildSttRequest, assessTranscript, sttFallbackChain, STT_DEFAULT_LANGUAGE, STT_DEFAULT_INITIAL_PROMPT } from "./stt-quality.js";

export const STT_SERVICE_DEFAULTS = Object.freeze({
  enabled: true,
  port: 8791,
  model: "small",
  fallbackModels: Object.freeze([]),
  device: "auto",
  language: STT_DEFAULT_LANGUAGE,
  initialPrompt: STT_DEFAULT_INITIAL_PROMPT,
  beamSize: 5,
  idleUnloadMs: 1800000,
  spawnTimeoutMs: 15000,
  requestTimeoutMs: 180000
});

/** 配置归一化：非法端口/数值一律落回默认值，避免一个手滑把功能关死。 */
export function normalizeSttServiceConfig(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const portNum = Number(src.port);
  const idleNum = Number(src.idleUnloadMs);
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const fallbackRaw = Array.isArray(src.fallbackModels) ? src.fallbackModels : STT_SERVICE_DEFAULTS.fallbackModels;
  return {
    enabled: src.enabled !== false,
    port: Number.isInteger(portNum) && portNum > 0 && portNum < 65536 ? portNum : STT_SERVICE_DEFAULTS.port,
    model: String(src.model || STT_SERVICE_DEFAULTS.model).trim().slice(0, 32) || STT_SERVICE_DEFAULTS.model,
    fallbackModels: sttFallbackChain({ model: src.model || STT_SERVICE_DEFAULTS.model, fallbacks: fallbackRaw }).slice(1, 4),
    device: ["auto", "cuda", "cpu"].includes(String(src.device || "").trim()) ? String(src.device).trim() : "auto",
    language: String(src.language || STT_DEFAULT_LANGUAGE).trim().slice(0, 16) || STT_DEFAULT_LANGUAGE,
    initialPrompt: String(src.initialPrompt ?? STT_DEFAULT_INITIAL_PROMPT).slice(0, 240),
    beamSize: clamp(src.beamSize, 1, 10, STT_SERVICE_DEFAULTS.beamSize),
    idleUnloadMs: Number.isFinite(idleNum) && idleNum >= 0 ? Math.round(idleNum) : STT_SERVICE_DEFAULTS.idleUnloadMs,
    python: String(src.python || "python").trim().slice(0, 260) || "python",
    spawnTimeoutMs: clamp(src.spawnTimeoutMs, 500, 60000, STT_SERVICE_DEFAULTS.spawnTimeoutMs),
    requestTimeoutMs: clamp(src.requestTimeoutMs, 1000, 600000, STT_SERVICE_DEFAULTS.requestTimeoutMs)
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig   读 socialV2.stt.service（每次调用都重读，支持热更新）
 * @param {string} deps.scriptPath         tools/stt_server.py 的绝对路径
 * @param {string} deps.stateDir           临时 wav 与服务日志放这里
 * @param {(msg: string) => void} [deps.log]
 * @param {(wav: Buffer, opts: object) => Promise<object>} deps.cliTranscribe  现有 CLI 路径
 * @param {(cmd: string, args: string[], opts: object) => object} [deps.spawnImpl]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 */
export function createSttService({
  getConfig = () => ({}),
  scriptPath,
  stateDir,
  log = () => {},
  cliTranscribe,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  now = Date.now
} = {}) {
  if (!scriptPath) throw new Error("createSttService 需要 scriptPath");
  if (typeof cliTranscribe !== "function") throw new Error("createSttService 需要 cliTranscribe（回退路径）");

  const tmpDir = path.join(stateDir || os.tmpdir(), "stt-tmp");
  const logFile = path.join(stateDir || os.tmpdir(), "stt-service.log");
  let child = null;
  let childExited = false;
  let starting = null;
  let startFailedAt = 0;
  let lastHealth = null;
  let lastHealthAt = 0;
  let lastSource = "";
  let lastMs = 0;
  let lastError = "";
  let stopped = false;

  const cfgNow = () => normalizeSttServiceConfig(getConfig());
  const baseUrl = (cfg) => `http://127.0.0.1:${cfg.port}`;

  function ensureTmpDir() {
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
    return tmpDir;
  }

  async function health(timeoutMs = 1200) {
    const cfg = cfgNow();
    try {
      const res = await fetchImpl(`${baseUrl(cfg)}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(Math.max(200, timeoutMs))
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      if (!body || body.ok !== true) return null;
      lastHealth = body;
      lastHealthAt = now();
      return body;
    } catch {
      return null;
    }
  }

  async function waitHealthy(deadlineAt) {
    while (!stopped && now() < deadlineAt) {
      const body = await health(1000);
      if (body) return body;
      if (childExited) return null;
      await sleep(200);
    }
    return null;
  }

  async function startOnce() {
    const cfg = cfgNow();
    if (!cfg.enabled) return false;
    if (stopped) return false;
    if (child && !childExited) {
      const body = await health(800);
      return body ? true : false;
    }
    if (childExited) {
      child = null;
      childExited = false;
    }
    // 端口上已经有一个健康服务（上一次桥接留下的）就直接复用，不重复拉起。
    const existing = await health(800);
    if (existing) return true;
    // 刚失败过就退避 60s，避免每条视频都白 spawn 一次 python。
    if (startFailedAt && now() - startFailedAt < 60000) return false;

    ensureTmpDir();
    try {
      fs.mkdirSync(stateDir, { recursive: true });
    } catch {}
    const args = [
      scriptPath,
      "--port", String(cfg.port),
      "--model", cfg.model,
      "--device", cfg.device,
      "--language", cfg.language,
      "--initial-prompt", cfg.initialPrompt,
      "--beam-size", String(cfg.beamSize),
      ...cfg.fallbackModels.flatMap((m) => ["--fallback-model", m]),
      "--idle-unload-ms", String(cfg.idleUnloadMs),
      "--allow-dir", tmpDir,
      "--allow-dir", os.tmpdir(),
      "--log-file", logFile
    ];
    const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
    log(`[stt] 启动常驻转写服务：${cfg.model} @ 127.0.0.1:${cfg.port}`);
    try {
      child = spawnImpl(cfg.python || "python", args, { windowsHide: true, stdio: "ignore", env });
    } catch (error) {
      startFailedAt = now();
      lastError = `spawn 失败：${error?.message ?? error}`;
      log(`[stt] 启动失败（回退 CLI）：${lastError}`);
      return false;
    }
    childExited = false;
    try {
      child.on("error", (error) => {
        childExited = true;
        lastError = `服务进程错误：${error?.message ?? error}`;
        log(`[stt] 服务进程错误：${lastError}`);
      });
      child.on("exit", (code, signal) => {
        childExited = true;
        lastHealth = null;
        log(`[stt] 服务退出 code=${code ?? "-"} signal=${signal ?? "-"}（下次转写会尝试重启或回退 CLI）`);
      });
    } catch {}
    const ok = await waitHealthy(now() + cfg.spawnTimeoutMs);
    if (!ok) {
      startFailedAt = now();
      lastError = lastError || "服务未在限定时间内就绪";
      log(`[stt] 服务 ${cfg.spawnTimeoutMs}ms 内未就绪（回退 CLI）`);
      return false;
    }
    log(`[stt] 常驻转写服务就绪（pid=${child?.pid ?? "?"}）`);
    return true;
  }

  function ensureStarted() {
    if (stopped) return Promise.resolve(false);
    if (!starting) {
      starting = startOnce()
        .catch((error) => {
          lastError = `启动异常：${error?.message ?? error}`;
          log(`[stt] 启动异常（回退 CLI）：${lastError}`);
          return false;
        })
        .finally(() => { starting = null; });
    }
    return starting;
  }

  async function runCli(wavBuf, { model, lang, timeoutMs, fallbackReason = "" } = {}) {
    const t0 = now();
    try {
      const r = await cliTranscribe(wavBuf, { model, lang, timeoutMs });
      const ms = Number.isFinite(Number(r?.ms)) ? Number(r.ms) : now() - t0;
      lastSource = "cli";
      lastMs = ms;
      if (r?.ok) {
        lastError = fallbackReason;
        const quality = r.quality || assessTranscript({ segments: r.segments, text: r.text });
        return { ...r, ...quality, source: "cli", ms, fallbackReason };
      }
      lastError = r?.error || fallbackReason || "CLI 转写失败";
      return { ok: false, error: lastError, source: "cli", ms, fallbackReason };
    } catch (error) {
      lastError = error?.message ?? String(error);
      return { ok: false, error: lastError, source: "cli", ms: now() - t0, fallbackReason };
    }
  }

  /**
   * 转写一段 wav。
   * @returns {Promise<{ok:boolean,text?:string,segments?:Array,lang?:string,source:'service'|'cli',ms:number,model?:string,error?:string,fallbackReason?:string}>}
   */
  async function transcribe(wavBuf, { model, lang, timeoutMs } = {}) {
    const cfg = cfgNow();
    const useModel = String(model || cfg.model).slice(0, 32);
    if (!wavBuf || !Buffer.isBuffer(wavBuf) || !wavBuf.length) {
      return { ok: false, error: "缺少音频数据", source: "none", ms: 0 };
    }
    if (!cfg.enabled) {
      return runCli(wavBuf, { model: useModel, lang, timeoutMs });
    }
    const t0 = now();
    let fallbackReason = "";
    try {
      const started = await ensureStarted();
      if (!started) throw new Error(lastError || "常驻服务不可用");
      ensureTmpDir();
      const file = path.join(tmpDir, `stt_${process.pid}_${crypto.randomBytes(4).toString("hex")}.wav`);
      fs.writeFileSync(file, wavBuf);
      try {
        const res = await fetchImpl(`${baseUrl(cfg)}/transcribe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildSttRequest({
            path: file, language: lang || cfg.language,
            initialPrompt: cfg.initialPrompt, beamSize: cfg.beamSize
          })),
          signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || cfg.requestTimeoutMs))
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body?.ok) {
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const ms = Number.isFinite(Number(body.ms)) ? Number(body.ms) : now() - t0;
        lastSource = "service";
        lastMs = ms;
        lastError = "";
        if (body.loadedAtMs) {
          lastHealth = { ...(lastHealth || {}), ...body, loadedAtMs: body.loadedAtMs, ok: true };
          lastHealthAt = now();
        }
        const segments = Array.isArray(body.segments) ? body.segments : [];
        const quality = assessTranscript({ segments, text: String(body.text ?? "") });
        return {
          ok: true,
          text: String(body.text ?? ""),
          segments,
          lang: body.lang ?? lang ?? null,
          model: body.model || useModel,
          device: body.device || null,
          language: body.language || cfg.language,
          source: "service",
          ms,
          ...quality
        };
      } finally {
        try { fs.unlinkSync(file); } catch {}
      }
    } catch (error) {
      fallbackReason = error?.message ?? String(error);
      lastError = fallbackReason;
      lastHealth = null; // 服务已经不可用，别再让 /api/status 报 running=true
      log(`[stt] 常驻服务转写失败（回退 CLI）：${fallbackReason}`);
      return runCli(wavBuf, { model: useModel, lang, timeoutMs, fallbackReason });
    }
  }

  /** 供 /api/status 使用的同步快照（不发起网络请求）。 */
  function status() {
    const cfg = cfgNow();
    const healthInfo = lastHealth || null;
    return {
      enabled: cfg.enabled,
      running: cfg.enabled && (!!(child && !childExited) || !!healthInfo),
      model: String(healthInfo?.model || cfg.model),
      loadedAt: Number(healthInfo?.loadedAtMs) || 0,
      lastMs: Number(lastMs) || Number(healthInfo?.lastMs) || 0,
      loaded: healthInfo ? healthInfo.loaded !== false : false,
      port: cfg.port,
      source: lastSource || null,
      lastError: lastError || null,
      lastCheckedAt: lastHealthAt || 0
    };
  }

  /** 只 ping 一次 /health 更新快照；供控制台/状态查询按需调用。 */
  async function refresh() {
    const cfg = cfgNow();
    if (!cfg.enabled) return status();
    const body = await health(800);
    if (!body) lastHealth = null;
    return status();
  }

  async function stop() {
    stopped = true;
    if (!child || childExited) return;
    try { child.kill(); } catch {}
  }

  return { transcribe, status, refresh, stop, ensureStarted, _internals: { tmpDir, logFile } };
}
