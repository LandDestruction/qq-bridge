#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""常驻语音转写服务（faster-whisper，CPU int8）。

为什么要有它：`stt_cli.py` 每次调用都要 `WhisperModel()` 冷加载一次模型 ——
16s 中文视频实测冷启动约 6s，其中一大半花在加载上而不是转写上。桥接改为
「首次需要转写时拉起本服务、之后复用同一个进程」，第二段视频起就只付转写时间。

用法：
    python stt_server.py [--host 127.0.0.1] [--port 8791] [--model small]
                         [--idle-unload-ms 1800000] [--allow-dir DIR ...]
                         [--log-file PATH]

接口（只监听回环地址，不对外）：
    GET  /health
         -> {"ok":true,"model":"small","loaded":true,"loading":false,
             "loadedAtMs":1234567890123,"lastMs":1234,"pid":...,
             "uptimeMs":...,"idleUnloadMs":1800000}
    POST /transcribe  {"path":"C:/.../a.wav","lang":"zh"}
         -> {"ok":true,"text":"...","segments":[{"start":0.0,"end":1.2,"text":"..."}],
             "lang":"zh","ms":1234,"model":"small"}
         失败 -> {"ok":false,"error":"..."}（HTTP 200，调用方按 ok 判断）
         也接受 {"wav":"<base64>"}（测试/无临时文件时用）

设计取舍：
- 模型按需加载（启动后后台线程预热），`--idle-unload-ms` 内没人用就把模型卸掉，
  下次请求再加载：常驻进程很轻，只有模型占内存（small int8 约 300~500MB）。
- 转写**串行**执行（一把锁）：faster-whisper 的模型对象不是线程安全的，而且 CPU
  本来就被抢时并发只会更慢。/health 由独立线程处理，转写期间仍然秒回。
- `--allow-dir` 限制可读的音频路径：这是只监听 127.0.0.1 的服务，但即使本机其它
  进程能访问，也不该让它变成「任意文件读取/解码」的入口。
"""
from __future__ import annotations

import argparse
import base64
import gc
import json
import os
import signal
import sys
import sysconfig
import tempfile
import threading
import re
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

MAX_BODY_BYTES = 16 * 1024 * 1024
DEFAULT_IDLE_UNLOAD_MS = 30 * 60 * 1000

_log_lock = threading.Lock()
_log_path = ""


def _num(v):
    try:
        return round(float(v), 3)
    except (TypeError, ValueError):
        return None


def log(msg: str) -> None:
    line = "%s [stt-server] %s" % (time.strftime("%H:%M:%S"), msg)
    with _log_lock:
        try:
            if _log_path:
                with open(_log_path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            else:
                sys.stderr.write(line + "\n")
                sys.stderr.flush()
        except Exception:
            pass


class ModelHolder:
    """持有 whisper 模型；负责按需加载、串行转写、空闲卸载。"""

    def __init__(self, model_name: str, idle_unload_ms: int, fallback_models=None,
                 device: str = "auto", language: str = "zh", initial_prompt: str = "",
                 beam_size: int = 5, condition_on_previous_text: bool = False) -> None:
        self.model_name = model_name
        self.fallback_models = [m for m in (fallback_models or []) if m]
        self.device = device or "auto"
        self.device_used = ""
        self.compute_type = ""
        self.language = language or "zh"
        self.initial_prompt = initial_prompt or ""
        self.beam_size = max(1, min(10, int(beam_size or 5)))
        self.condition_on_previous_text = bool(condition_on_previous_text)
        self.idle_unload_ms = max(0, int(idle_unload_ms or 0))
        self.model = None
        self.loaded_at_ms = 0
        self.loading = False
        self.load_error = ""
        self.last_ms = 0
        self.last_used_at = 0.0
        self.started_at = time.time()
        self.run_lock = threading.Lock()  # 模型加载/转写/卸载串行化
        self.cuda_broken = False  # 推理期发现 CUDA 缺 DLL（cublas64_12 等）就永久降 CPU，不再反复踩

    def _device_candidates(self):
        """显存不足时的降级链：cuda(int8_float16) → cpu(int8)；显式 --device cpu 时只用 cpu。"""
        dev = (self.device or "auto").lower()
        if dev == "cpu" or self.cuda_broken:
            return [("cpu", "int8")]
        return [("cuda", "int8_float16"), ("cpu", "int8")]

    def ensure_model(self):
        with self.run_lock:
            return self._ensure_model_locked()

    def _ensure_model_locked(self):
        if self.model is not None:
            return self.model
        from faster_whisper import WhisperModel  # 延迟导入：/health 不必等 import 完成
        self.loading = True
        self.load_error = ""
        t0 = time.time()
        chain = [self.model_name] + [m for m in self.fallback_models if m and m != self.model_name]
        last_err = None
        # 设备在外层：cuda 下先试主模型再试降级模型（显存不够时小模型往往还能塞进去）；
        # CPU 只跑链尾的最小模型——medium 在 CPU 上 40s 音频要 45s，作为回退太慢。
        for device, compute in self._device_candidates():
            names = chain if device != "cpu" else chain[-1:]
            for name in names:
                log("加载模型 %s（device=%s, compute_type=%s）…" % (name, device, compute))
                try:
                    model = WhisperModel(name, device=device, compute_type=compute)
                except Exception as exc:  # noqa: BLE001
                    last_err = exc
                    log("模型 %s(%s/%s) 加载失败，降级下一个：%s" % (name, device, compute, exc))
                    continue
                self.model = model
                self.model_name = name
                self.device_used = device
                self.compute_type = compute
                self.loaded_at_ms = int(time.time() * 1000)
                self.last_used_at = time.time()
                self.loading = False
                log("模型已加载 %s（%s/%s，%dms）" % (name, device, compute, int((time.time() - t0) * 1000)))
                return model
        self.loading = False
        self.load_error = str(last_err or "没有可用模型")
        log("所有模型都加载失败：%s" % self.load_error)
        raise RuntimeError(self.load_error)

    def transcribe(self, path: str, lang: str | None, opts: dict | None = None) -> dict:
        opts = opts or {}
        language = str(opts.get("language") or lang or self.language or "").strip()[:16] or None
        initial_prompt = str(opts.get("initial_prompt") or self.initial_prompt or "").strip()[:240] or None
        try:
            beam = int(opts.get("beam_size") or self.beam_size or 5)
        except (TypeError, ValueError):
            beam = self.beam_size or 5
        beam = max(1, min(10, beam))
        condition = bool(opts.get("condition_on_previous_text", self.condition_on_previous_text))
        vad = bool(opts.get("vad_filter", True))
        with self.run_lock:
            model = self._ensure_model_locked()
            t0 = time.time()
            try:
                segments, info = model.transcribe(
                    path, language=language, initial_prompt=initial_prompt,
                    vad_filter=vad, beam_size=beam,
                    condition_on_previous_text=condition,
                )
                raw = list(segments)
            except Exception as exc:  # noqa: BLE001
                # 模型加载成功、推理时才炸：Windows 上典型是缺 cublas64_12.dll / cudnn。
                # 一次性降 CPU：卸载模型、标记 cuda_broken，再走一遍（CPU int8）。
                text_err = str(exc)
                if not self.cuda_broken and re.search(r"cublas|cudnn|cuda|dll|Library", text_err, re.I):
                    log("CUDA 推理失败（%s），永久降到 CPU 重试…" % text_err[:160])
                    self.cuda_broken = True
                    self.model = None
                    self.device_used = ""
                    model = self._ensure_model_locked()
                    segments, info = model.transcribe(
                        path, language=language, initial_prompt=initial_prompt,
                        vad_filter=vad, beam_size=beam,
                        condition_on_previous_text=condition,
                    )
                    raw = list(segments)
                else:
                    raise
            # VAD 有时会把「小声但确实有人在说话」整段滤掉（实测 video 转写返回 0 字 → high_no_speech）。
            # 一次空结果就关掉 VAD 再试一遍，代价只有一次转写时间。
            if not raw and vad:
                log("首次转写 0 段（VAD 可能滤掉了），关闭 VAD 重试一次…")
                segments2, info = model.transcribe(
                    path, language=language, initial_prompt=initial_prompt,
                    vad_filter=False, beam_size=beam,
                    condition_on_previous_text=condition,
                )
                raw = list(segments2)
            out = []
            for seg in raw:
                text = (seg.text or "").strip()
                if not text:
                    continue
                out.append({
                    "start": round(float(seg.start), 2),
                    "end": round(float(seg.end), 2),
                    "text": text,
                    "avg_logprob": _num(getattr(seg, "avg_logprob", None)),
                    "no_speech_prob": _num(getattr(seg, "no_speech_prob", None)),
                })
            elapsed_ms = int((time.time() - t0) * 1000)
            self.last_ms = elapsed_ms
            self.last_used_at = time.time()
            return {
                "ok": True,
                "model": self.model_name,
                "device": self.device_used or None,
                "language": language,
                "initialPromptUsed": bool(initial_prompt),
                "beamSize": beam,
                "lang": getattr(info, "language", None),
                "text": "".join(s["text"] for s in out),
                "segments": out,
                "ms": elapsed_ms,
            }

    def maybe_unload(self) -> None:
        if not self.idle_unload_ms or self.model is None or not self.last_used_at:
            return
        if (time.time() - self.last_used_at) * 1000 < self.idle_unload_ms:
            return
        with self.run_lock:
            if self.model is None:
                return
            if (time.time() - self.last_used_at) * 1000 < self.idle_unload_ms:
                return
            idle_s = int(time.time() - self.last_used_at)
            self.model = None
            self.loaded_at_ms = 0
            gc.collect()
            log("空闲 %ds，已卸载模型（下次请求再加载）" % idle_s)

    def snapshot(self) -> dict:
        return {
            "model": self.model_name,
            "device": self.device_used or None,
            "language": self.language,
            "loaded": self.model is not None,
            "loading": bool(self.loading),
            "loadedAtMs": self.loaded_at_ms,
            "lastMs": self.last_ms,
            "lastUsedAtMs": int(self.last_used_at * 1000) if self.last_used_at else 0,
            "loadError": self.load_error,
            "idleUnloadMs": self.idle_unload_ms,
            "pid": os.getpid(),
            "uptimeMs": int((time.time() - self.started_at) * 1000),
        }


holder: ModelHolder | None = None
allow_dirs: list[str] = []


def allowed_paths() -> list[str]:
    return allow_dirs or [tempfile.gettempdir()]


def is_allowed(path: str) -> bool:
    try:
        real = os.path.realpath(path)
    except Exception:
        return False
    if not os.path.isfile(real):
        return False
    if os.path.getsize(real) <= 0:
        return False
    for d in allowed_paths():
        try:
            root = os.path.realpath(d)
            if os.path.commonpath([real, root]) == root:
                return True
        except Exception:
            continue
    return False


class Handler(BaseHTTPRequestHandler):
    server_version = "qq-bridge-stt/1.0"
    # 用 HTTP/1.0：每次请求一条连接。转写本身就是秒级，省下 keep-alive 的
    # 连接状态机（413/403 提前返回时不会把连接读脏）。客户端是本地 Node fetch。
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):  # noqa: D401 - BaseHTTPRequestHandler 协议方法
        log("http " + (fmt % args))

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler 协议方法
        route = urlparse(self.path).path
        if route in ("/health", "/"):
            payload = {"ok": True}
            payload.update(holder.snapshot() if holder else {})
            self._send(200, payload)
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler 协议方法
        route = urlparse(self.path).path
        if route != "/transcribe":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            self._send(400, {"ok": False, "error": "缺少请求体"})
            return
        if length > MAX_BODY_BYTES:
            self._send(413, {"ok": False, "error": "请求体过大"})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("body 必须是 JSON 对象")
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"ok": False, "error": "JSON 解析失败：%s" % exc})
            return

        tmp_path = None
        try:
            if payload.get("wav"):
                data = base64.b64decode(str(payload["wav"]), validate=False)
                if not data:
                    raise ValueError("wav 为空")
                fd, tmp_path = tempfile.mkstemp(prefix="stt_req_", suffix=".wav")
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                target = tmp_path
            else:
                target = str(payload.get("path") or "").strip()
            if not target:
                self._send(400, {"ok": False, "error": "缺少 path"})
                return
            if not is_allowed(target):
                log("拒绝路径（不在 --allow-dir 内或文件不可读）：%s" % target[:200])
                self._send(403, {"ok": False, "error": "路径不在允许目录内或文件不存在"})
                return
            lang = payload.get("lang")
            if lang is not None:
                lang = str(lang).strip()[:16] or None
            opts = {
                "language": payload.get("language") or lang,
                "initial_prompt": payload.get("initial_prompt"),
                "beam_size": payload.get("beam_size"),
                "condition_on_previous_text": payload.get("condition_on_previous_text", False),
                "vad_filter": payload.get("vad_filter", True),
            }
            result = holder.transcribe(target, lang, opts)
            self._send(200, result)
        except Exception as exc:  # noqa: BLE001
            log("转写失败：%s\n%s" % (exc, traceback.format_exc(limit=3)))
            self._send(500, {"ok": False, "error": str(exc)[:500]})
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass


def idle_loop() -> None:
    while True:
        time.sleep(max(5.0, min(60.0, (holder.idle_unload_ms or DEFAULT_IDLE_UNLOAD_MS) / 4000.0)))
        try:
            holder.maybe_unload()
        except Exception as exc:  # noqa: BLE001
            log("空闲卸载检查失败：%s" % exc)


def preload_loop() -> None:
    try:
        holder.ensure_model()
    except Exception:
        pass  # ensure_model 已记录日志；下一个请求会再试


def main() -> int:
    global _log_path, holder, allow_dirs
    parser = argparse.ArgumentParser(description="qq-bridge 常驻语音转写服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--model", default="small")
    parser.add_argument("--fallback-model", action="append", default=[],
                        help="主模型加载失败/显存不足时依次降级（可重复，如 --fallback-model small）")
    parser.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument("--language", default="zh")
    parser.add_argument("--initial-prompt", default="")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--condition-on-previous-text", action="store_true")
    parser.add_argument("--idle-unload-ms", type=int, default=DEFAULT_IDLE_UNLOAD_MS)
    parser.add_argument("--allow-dir", action="append", default=[])
    parser.add_argument("--log-file", default="")
    parser.add_argument("--no-preload", action="store_true", help="启动时不预热模型（测试用）")
    args = parser.parse_args()

    _log_path = args.log_file or ""
    allow_dirs = [d for d in (args.allow_dir or []) if d]
    if not allow_dirs:
        allow_dirs = [tempfile.gettempdir()]
    holder = ModelHolder(
        args.model, args.idle_unload_ms,
        fallback_models=args.fallback_model,
        device=args.device, language=args.language,
        initial_prompt=args.initial_prompt, beam_size=args.beam_size,
        condition_on_previous_text=args.condition_on_previous_text,
    )

    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        log("监听 %s:%s 失败：%s" % (args.host, args.port, exc))
        return 2
    server.daemon_threads = True

    def _shutdown(_signum=None, _frame=None):
        log("收到退出信号，关闭服务")
        try:
            server.shutdown()
        except Exception:
            pass
        os._exit(0)

    for sig_name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            try:
                signal.signal(sig, _shutdown)
            except Exception:
                pass

    log("监听 http://%s:%d（model=%s, idleUnloadMs=%d, python=%s）"
        % (args.host, args.port, args.model, args.idle_unload_ms,
           sysconfig.get_python_version()))
    if not args.no_preload:
        threading.Thread(target=preload_loop, daemon=True).start()
    threading.Thread(target=idle_loop, daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
