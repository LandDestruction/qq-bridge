import path from "node:path";
import { extractAudioWav, transcribeWav } from "../src/video-analyze.js";
const file = process.argv[2];
const t0 = Date.now();
const wav = await extractAudioWav(file, { ffmpegPath: process.env.FFMPEG || "ffmpeg", maxSeconds: 120 });
const t1 = Date.now();
console.log("audio:", wav ? `${wav.bytes} bytes / ${wav.seconds?.toFixed?.(1) ?? "?"}s` : "null", `(${t1 - t0}ms)`);
let stt = null;
if (wav) {
  stt = await transcribeWav(wav.file ?? wav, { script: path.join("tools", "stt_cli.py"), model: "small", lang: "zh" });
  console.log("stt:", JSON.stringify(stt).slice(0, 300), `(${Date.now() - t1}ms)`);
}
console.log("VERDICT:", wav && stt?.ok && String(stt.text || "").length > 0 ? "有声音且有转写" : "转写为空/失败");
