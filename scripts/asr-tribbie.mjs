// ASR 批量转写缇宝语音（用常驻 STT 服务 tools/stt_server.py 8791）。
// 用法：node scripts/asr-tribbie.mjs [缇宝目录]
// 输出：data/voice/tribbie/refs.txt（文件名.wav\t时长\t文本）+ asr.log（进度）
// 断点续传：跳过 refs.txt 里已有的文件名。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SRC_DIR = process.argv[2] || "C:/Users/PC/Downloads/崩坏星穹铁道语音包3.8（中）/崩坏星穹铁道语音包3.8（中）/缇宝";
const OUT_DIR = path.join(ROOT, "data", "voice", "tribbie");
const REFS = path.join(OUT_DIR, "refs.txt");
const LOG = path.join(OUT_DIR, "asr.log");
const STT = "http://127.0.0.1:8791/transcribe";

function log(line) {
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
}

function wavDuration(file) {
  // 读 RIFF/WAVE 头，data chunk size / byte rate
  const fd = fs.openSync(file, "r");
  try {
    const hdr = Buffer.alloc(12);
    fs.readSync(fd, hdr, 0, 12, 0);
    if (hdr.toString("ascii", 0, 4) !== "RIFF" || hdr.toString("ascii", 8, 12) !== "WAVE") return null;
    let off = 12;
    const buf = Buffer.alloc(8);
    let byteRate = 0, dataSize = 0;
    while (off < 12 + 2000) {
      fs.readSync(fd, buf, 0, 8, off);
      const id = buf.toString("ascii", 0, 4);
      const size = buf.readUInt32LE(4);
      if (id === "fmt ") {
        const fmt = Buffer.alloc(16);
        fs.readSync(fd, fmt, 0, 16, off + 8);
        byteRate = fmt.readUInt32LE(8); // avg bytes/sec
      } else if (id === "data") {
        dataSize = size;
      }
      off += 8 + size + (size % 2);
      if (byteRate && dataSize) break;
    }
    return byteRate ? +(dataSize / byteRate).toFixed(2) : null;
  } finally {
    fs.closeSync(fd);
  }
}

async function transcribe(file, lang = "zh") {
  const res = await fetch(STT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: file, lang }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: "非 JSON：" + text.slice(0, 200) }; }
}

function loadDone() {
  if (!fs.existsSync(REFS)) return new Set();
  return new Set(fs.readFileSync(REFS, "utf8").split("\n").filter(Boolean).map(l => l.split("\t")[0]));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = fs.readdirSync(SRC_DIR).filter(f => f.toLowerCase().endsWith(".wav")).sort();
  const done = loadDone();
  const todo = files.filter(f => !done.has(f));
  log(`todo ${files.length} / done ${done.size}`);
  let t0 = Date.now();
  let ok = 0, fail = 0;
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    const full = path.join(SRC_DIR, f);
    let r = null;
    for (let attempt = 0; attempt < 3 && !r?.ok; attempt++) {
      r = await transcribe(full);
      if (!r?.ok && attempt < 2) await new Promise(s => setTimeout(s, 800));
    }
    if (r?.ok && r.text && r.text.trim()) {
      const dur = wavDuration(full) ?? r.segments?.at(-1)?.end?.toFixed(2) ?? "";
      const text = r.text.replace(/[\r\n\t]+/g, " ").trim();
      fs.appendFileSync(REFS, `${f}\t${dur}\t${text}\n`);
      ok++;
    } else {
      fail++;
      const err = r?.error || r?.text || "（听不清/空）";
      log(`FAIL ${f}: ${err}`);
    }
    if ((i + 1) % 25 === 0 || i === todo.length - 1) {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      log(`${done.size + i + 1}/${files.length} ${el}s ok=${ok} fail=${fail}`);
    }
  }
  log(`DONE ${files.length} ok=${ok} fail=${fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
