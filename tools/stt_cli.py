#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把一段音频转成文字（faster-whisper，默认 CPU int8）。

用法：python stt_cli.py <wav/mp3 路径> [--model medium] [--language zh] [--initial-prompt "..."] [--beam-size 5]
输出：一行 JSON，形如
  {"ok":true,"text":"...","language":"zh","segments":[{"start":0.0,"end":1.2,"text":"...",
   "avg_logprob":-0.31,"no_speech_prob":0.02}]}
失败：{"ok":false,"error":"..."}

设计说明：
- 这是**回退路径**（常驻服务不可用时才用）；每次调用都会加载模型，冷启动 2~6 秒。
- 语言默认锁定 zh：群聊场景别让模型自动猜（猜错会输出繁体/英文/乱码）。
- 置信度字段原样带出，由 src/stt-quality.js 判定「听不清」，不在这里做产品判断。
"""
import json
import sys


def _num(v):
    try:
        return round(float(v), 3)
    except (TypeError, ValueError):
        return None


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少音频路径"}))
        return 2
    path = sys.argv[1]
    model_name = "medium"
    language = "zh"
    initial_prompt = ""
    beam_size = 5
    args = sys.argv[2:]
    for i, a in enumerate(args):
        if a == "--model" and i + 1 < len(args):
            model_name = args[i + 1]
        if a in ("--language", "--lang") and i + 1 < len(args):
            language = args[i + 1]
        if a == "--initial-prompt" and i + 1 < len(args):
            initial_prompt = args[i + 1]
        if a == "--beam-size" and i + 1 < len(args):
            try:
                beam_size = max(1, min(10, int(args[i + 1])))
            except ValueError:
                beam_size = 5

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"faster-whisper 未安装：{exc}"}))
        return 3

    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            path, language=language or None, initial_prompt=initial_prompt or None,
            vad_filter=True, beam_size=beam_size, condition_on_previous_text=False,
        )
        out = []
        for seg in segments:
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
        print(json.dumps({
            "ok": True,
            "model": model_name,
            "device": "cpu",
            "language": language,
            "lang": getattr(info, "language", None),
            "text": "".join(s["text"] for s in out),
            "segments": out,
        }, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 4


if __name__ == "__main__":
    sys.exit(main())
