// 缇宝 TTS 参考音频选择 + GPT-SoVITS 零样本合成每场景样本。
// 用法：node scripts/synth-tribbie.mjs
// 输出：data/voice/tribbie/refs/（参考音频）+ data/voice/tribbie/scenes/（合成样本）
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SRC = "C:/Users/PC/Downloads/崩坏星穹铁道语音包3.8（中）/崩坏星穹铁道语音包3.8（中）/缇宝";
const TRIBBIE = path.join(ROOT, "data", "voice", "tribbie");
const REFS_DIR = path.join(TRIBBIE, "refs");
const SCENES_DIR = path.join(TRIBBIE, "scenes");
const GSV = "http://127.0.0.1:9880/tts";

// 8 个场景：参考音频文件名 + prompt_text（参考音频的 ASR 转写）+ 合成测试文本
const SCENES = [
  { id: "cheer",    ref: "0427aebfb59842eb.wav", prompt: "只要又多了一个盼着明天的理由呢", text: "一起加油吧，明天一定会更好！" },
  { id: "comfort",  ref: "0177429d7a53b273.wav", prompt: "服药服药，交给我们，你先休息会，很快的我们准备好了就来叫你", text: "别难过，有我们在你身边呢。" },
  { id: "playful",  ref: "114e3508e7fab739.wav", prompt: "我们最喜欢和大家玩猜猜我们是谁啦，我是迪宁，我是迪阿，我是迪宝，你猜对了几个", text: "嘿嘿，猜猜我们今天带了什么好东西？" },
  { id: "explain",  ref: "0584a6f61afe1f27.wav", prompt: "那边的卷轴是阿雅托夫给我们的留言，他祝福我们在特别的时候将他转交给你", text: "这个故事，要从很久很久以前说起。" },
  { id: "solemn",   ref: "187ed945c899bb22.wav", prompt: "三者开辟天地，三者编织命运，三者捏塑生命，三者引渡灾祸。", text: "以命运之名，我们在此立下誓言。" },
  { id: "surprise", ref: "0022baea2bdae46c.wav", prompt: "难道这是我们丢失的记忆", text: "咦？这是怎么回事？" },
  { id: "sad",      ref: "1f428a89b047a354.wav", prompt: "布尼斯…消失了", text: "我们……真的不想和你分开。" },
  { id: "thanks",   ref: "0bd59ce55b644720.wav", prompt: "不客气，我们还得去传递信息，先走了，你要保重哦，大家好", text: "谢谢你，真的帮了大忙啦！" },
];

async function synth({ refPath, prompt, text, outPath }) {
  const res = await fetch(GSV, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text, text_lang: "zh",
      ref_audio_path: refPath, prompt_text: prompt, prompt_lang: "zh",
      text_split_method: "cut5", media_type: "wav", speed_factor: 1, top_k: 10, temperature: 0.6,
    }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200 || !buf.length || buf.slice(0, 4).toString("ascii") !== "RIFF") {
    return { ok: false, status: res.status, err: buf.slice(0, 200).toString("utf8") };
  }
  fs.writeFileSync(outPath, buf);
  return { ok: true, size: buf.length };
}

async function main() {
  fs.mkdirSync(REFS_DIR, { recursive: true });
  fs.mkdirSync(SCENES_DIR, { recursive: true });
  for (const s of SCENES) {
    const srcWav = path.join(SRC, s.ref);
    if (!fs.existsSync(srcWav)) { console.log(`✗ ${s.id}: 参考音频缺失 ${s.ref}`); continue; }
    const refOut = path.join(REFS_DIR, `${s.id}.wav`);
    if (!fs.existsSync(refOut)) fs.copyFileSync(srcWav, refOut);
    const r = await synth({ refPath: srcWav, prompt: s.prompt, text: s.text, outPath: path.join(SCENES_DIR, `${s.id}.wav`) });
    console.log(r.ok ? `✓ ${s.id}  合成 ${r.size}B  ← "${s.text}"` : `✗ ${s.id}  失败 ${r.status}: ${r.err}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
