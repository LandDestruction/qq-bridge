// 生成「默认背景音乐」——一首自己写的、自然欢快轻盈的小调，不引用任何现成旋律，因此没有版权问题。
//
// 为什么用脚本合成而不是找一首免费的曲子：
//   1. CC0 / 免版权曲库的曲子要么需要署名（在控制台里挂一行署名很难看），
//      要么授权条款会变/会下架，过两年就说不清还在不在。
//   2. 自己合成 = 我们自己就是作者，随包分发、随便循环，谁也不用署名。
//   3. 体积可控：近两分钟单声道 80kbps mp3 约 1.1 MB，装进安装包不心疼。
//
// 这一版的目标是「像人弹的、听着舒服、能一直循环」：
//   · 100 BPM、F 大调五声音阶（F G A C D），木琴/马林巴感的拨奏当主旋律，钟琴在高音轻点，
//     暖垫铺和弦，拨弦低音给骨架，沙锤只做 8 分音符的呼吸感（没有鼓，才轻盈）。
//   · 48 小节 ≈ 115 秒；速度/音量/时值都做了微小的人性化抖动，避免「电子味」。
//   · 循环用「尾巴折回开头」而不是淡入淡出：混响尾巴被叠回 0 秒处，
//     循环点听不出接缝，也不会像以前那样在接缝处掉一下音量。
//
// 用法：
//   node scripts/make-bgm.mjs                     # 生成 public/bgm/default-tune.mp3
//   node scripts/make-bgm.mjs --wav-only          # 只出 wav（没装 ffmpeg 时）
//   node scripts/make-bgm.mjs --out=xxx.wav       # 换个输出路径（调试用）
//
// 依赖：node（写 wav 用内置 fs）+ ffmpeg（转 mp3；没有 ffmpeg 时保留 wav，浏览器也能放）。
// 产物一旦生成就提交进仓库，安装包直接带上，构建时不需要再跑一次。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'public', 'bgm');
const BASE_NAME = 'default-tune';

// ── 曲子参数 ──────────────────────────────────────────────────────────
const SR = 44100;
const BPM = 100;
const BEAT = 60 / BPM;                 // 0.6s（一拍）
const BAR = BEAT * 4;                  // 2.4s（一小节）
const BARS = 48;                       // 48 小节 ≈ 115.2 秒
const DURATION = BARS * BAR;
const TAIL = 2.6;                      // 混响尾巴长度，之后折回开头做无缝循环

const NOTE_BASE = { C: -9, 'C#': -8, D: -7, 'D#': -6, E: -5, F: -4, 'F#': -3, G: -2, 'G#': -1, A: 0, 'A#': 1, B: 2 };
const A4 = 440;
function freq(name) {
  const m = /^([A-G]#?)(\d)$/.exec(name);
  if (!m) throw new Error('音名写错了：' + name);
  const semis = NOTE_BASE[m[1]] + (Number(m[2]) - 4) * 12;
  return A4 * Math.pow(2, semis / 12);
}

// 和弦表：每小节一个和弦（16 小节一个循环，重复 3 次 = 48 小节）
// F - C/E - Dm - Bb | F - C - Dm - Bb | Bb - C - Am - Dm | Bb - C - F - C
const CHORDS = [
  'F', 'C/E', 'Dm', 'Bb', 'F', 'C', 'Dm', 'Bb',
  'Bb', 'C', 'Am', 'Dm', 'Bb', 'C', 'F', 'C'
];
const CHORD_NOTES = {
  F: ['F3', 'A3', 'C4'], 'C/E': ['E3', 'G3', 'C4'], C: ['C3', 'E3', 'G3'],
  Dm: ['D3', 'F3', 'A3'], Bb: ['A#2', 'D3', 'F3'], Am: ['A2', 'C3', 'E3']
};
const CHORD_ROOT = { F: 'F2', 'C/E': 'E2', C: 'C2', Dm: 'D2', Bb: 'A#1', Am: 'A1' };
const CHORD_FIFTH = { F: 'C3', 'C/E': 'G2', C: 'G2', Dm: 'A2', Bb: 'F2', Am: 'E2' };

// 主旋律（五声音阶 F G A C D；'-' 延音、'.' 休止），每小节 8 个 8 分音符。
// A 段：明亮、向上走的开场句；B 段：换成更密的下行小句，第三段（A2）把 A 抬高八度再做钟琴点缀。
const MEL_A = [
  'A4 . C5 . F5 - C5 .', 'G4 . C5 . E5 - C5 .',
  'A4 . D5 . F5 - D5 .', 'A#4 . D5 . F5 - D5 .',
  'A4 . C5 . F5 - A5 .', 'G4 . C5 . E5 - G5 .',
  'F5 . D5 . A4 - D5 .', 'C5 - A4 . G4 - - .',
  'F5 . A5 . C6 - A5 .', 'G5 . E5 . C5 - E5 .',
  'A5 . F5 . D5 - F5 .', 'G5 . E5 . C5 - - .',
  'D5 . F5 . A5 - F5 .', 'E5 . G5 . C6 - G5 .',
  'F5 - A5 . G5 - E5 .', 'C5 - - . . - - .'
];
const MEL_B = [
  'C5 . F5 . A5 - F5 .', 'E5 . G5 . C6 - G5 .',
  'D5 . F5 . A5 - D6 .', 'D5 . F5 . A#5 - F5 .',
  'A4 . C5 . F5 - C5 .', 'G4 . C5 . E5 - C5 .',
  'D5 . F5 . A5 - F5 .', 'C5 . E5 . G5 - E5 .',
  'D6 . A5 . F5 - A5 .', 'C6 . G5 . E5 - G5 .',
  'A5 . E5 . C5 - E5 .', 'F5 . A5 . D6 - A5 .',
  'F5 . A5 . C6 - A5 .', 'G5 . C6 . E6 - C6 .',
  'A5 - F5 . D5 - F5 .', 'E5 - C5 . G4 - - .'
];

// ── 随机（固定种子：每次生成同一个文件，提交进仓库不会抖） ──────────────
let seed = 0x9e3779b9;
function rand() {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}
const human = (amount) => (rand() * 2 - 1) * amount;

// ── 合成器 ────────────────────────────────────────────────────────────
const total = Math.ceil((DURATION + TAIL) * SR);
const buf = new Float64Array(total);

// 马林巴/木琴感拨奏：基音 + 快衰减的二次泛音，起音 3ms（不用 20ms 那种糊的慢起）
function pluck(t, f, dur, gain) {
  const start = Math.round(t * SR);
  const n = Math.round((dur + 0.35) * SR);
  for (let i = 0; i < n; i += 1) {
    const idx = start + i;
    if (idx < 0 || idx >= total) continue;
    const sec = i / SR;
    const env = Math.exp(-sec * 4.2) * (1 - Math.exp(-sec * 420));
    const ph = 2 * Math.PI * f * sec;
    buf[idx] += gain * env * (
      Math.sin(ph)
      + 0.30 * Math.sin(2 * ph) * Math.exp(-sec * 7)
      + 0.10 * Math.sin(3 * ph) * Math.exp(-sec * 12)
      + 0.04 * Math.sin(4.2 * ph) * Math.exp(-sec * 18)
    );
  }
}

// 钟琴：更亮、更长一点，只在高音区轻点，给「闪一下」的亮度
function bell(t, f, gain) {
  const start = Math.round(t * SR);
  const n = Math.round(1.6 * SR);
  for (let i = 0; i < n; i += 1) {
    const idx = start + i;
    if (idx < 0 || idx >= total) continue;
    const sec = i / SR;
    const env = Math.exp(-sec * 2.6) * (1 - Math.exp(-sec * 320));
    const ph = 2 * Math.PI * f * sec;
    buf[idx] += gain * env * (Math.sin(ph) + 0.22 * Math.sin(2.01 * ph) + 0.08 * Math.sin(3.02 * ph));
  }
}

// 暖垫：三个音叠在一起慢起慢收，音量很低，只负责「不空」
function pad(t, f, dur, gain) {
  const start = Math.round(t * SR);
  const n = Math.round((dur + 1.1) * SR);
  const atk = 0.55;
  for (let i = 0; i < n; i += 1) {
    const idx = start + i;
    if (idx < 0 || idx >= total) continue;
    const sec = i / SR;
    const rel = Math.min(1, sec / atk) * Math.max(0, 1 - Math.max(0, sec - dur) / 1.1);
    const ph = 2 * Math.PI * f * sec;
    buf[idx] += gain * rel * (Math.sin(ph) + 0.18 * Math.sin(2 * ph) + 0.06 * Math.sin(3 * ph));
  }
}

// 拨弦低音：短、圆、不糊
function bass(t, f, dur, gain) {
  const start = Math.round(t * SR);
  const n = Math.round((dur + 0.3) * SR);
  for (let i = 0; i < n; i += 1) {
    const idx = start + i;
    if (idx < 0 || idx >= total) continue;
    const sec = i / SR;
    const env = Math.exp(-sec * 3.0) * (1 - Math.exp(-sec * 240));
    const ph = 2 * Math.PI * f * sec;
    buf[idx] += gain * env * (Math.sin(ph) + 0.20 * Math.sin(2 * ph));
  }
}

// 沙锤：8 分音符的高通噪声（一阶差分当高通），交替强弱；只在背景，不抢旋律
let noiseState = 0x2545f491;
function noise() {
  noiseState ^= noiseState << 13; noiseState ^= noiseState >>> 17; noiseState ^= noiseState << 5;
  return ((noiseState >>> 0) / 4294967296) * 2 - 1;
}
function shaker(t, gain) {
  const start = Math.round(t * SR);
  const n = Math.round(0.06 * SR);
  let prev = 0;
  let prev2 = 0;
  for (let i = 0; i < n; i += 1) {
    const idx = start + i;
    if (idx < 0 || idx >= total) continue;
    const sec = i / SR;
    const env = Math.exp(-sec * 64);
    const white = noise();
    const hp = white - 2 * prev + prev2;   // 二阶差分：高频更干净，也不在低频糊一层
    prev2 = prev;
    prev = white;
    buf[idx] += gain * env * hp * 0.6;
  }
}

// ── 铺谱 ──────────────────────────────────────────────────────────────
function melodyBar(line, barIndex, { octaveUp = false, gain = 0.19 } = {}) {
  const tokens = String(line).trim().split(/\s+/);      // 乐谱写成一行 8 个 8 分音符，这里切回数组
  tokens.forEach((note, slot) => {
    if (note === '-' || note === '.') return;
    let len = 1;
    for (let k = slot + 1; k < tokens.length && tokens[k] === '-'; k += 1) len += 1;
    const f = freq(note) * (octaveUp ? 2 : 1);
    const t = barIndex * BAR + slot * BEAT * 0.5 + human(0.006);
    pluck(t, f, Math.max(BEAT * 0.5, len * BEAT * 0.5) * 1.05, gain * (1 + human(0.09)));
    if (slot === 0 || slot === 4) bell(t, f * 2, 0.026 * (1 + human(0.15)));
  });
}

function chordBar(chord, barIndex) {
  const t0 = barIndex * BAR;
  // 暖垫：整小节一个和弦，音量低
  CHORD_NOTES[chord].forEach((note) => pad(t0 + human(0.004), freq(note), BAR * 0.94, 0.026));
  // 低音：第 1 拍根音、第 3 拍五度（轻一点），偶尔在第 4 拍后半加一个八度跳
  bass(t0, freq(CHORD_ROOT[chord]), BEAT * 1.5, 0.105);
  bass(t0 + BEAT * 2, freq(CHORD_FIFTH[chord]), BEAT * 1.2, 0.070);
  if (barIndex % 4 === 3) bass(t0 + BEAT * 3.5, freq(CHORD_ROOT[chord]) * 2, BEAT * 0.8, 0.050);
  // 琶音：8 分音符从和弦音里走一圈，音量很小，负责「bling」的轻盈感。
  // 只在 B 段与 A2 段出现：A 段留白，听起来才像有人在弹而不是循环机。
  const section = Math.floor(barIndex / 16);
  if (section > 0) {
    const tones = CHORD_NOTES[chord];
    const pattern = [tones[0], tones[1], tones[2], tones[1]];
    for (let slot = 0; slot < 8; slot += 1) {
      const note = pattern[slot % pattern.length];
      const up = slot >= 4 ? 2 : 1;
      pluck(t0 + slot * BEAT * 0.5 + human(0.005), freq(note) * up, BEAT * 0.42, 0.018 * (slot % 2 ? 1 : 1.18));
    }
  }
  // 沙锤：8 分音符，交替强弱
  for (let slot = 0; slot < 8; slot += 1) {
    shaker(t0 + slot * BEAT * 0.5 + human(0.004), slot % 2 === 0 ? 0.009 : 0.0055);
  }
}

// 每段最后一句加一个 4 分音符的「引进音」（D→E），把下一段的 F 接上去。
// 没有它，循环点会从「安静的收句」直接砸回「热闹的第一小节」，听感上像被掐了一下。
function pickups(barIndex) {
  const t0 = barIndex * BAR;
  pluck(t0 + BEAT * 3 + human(0.005), freq('D5'), BEAT * 0.9, 0.115);
  pluck(t0 + BEAT * 3.5 + human(0.005), freq('E5'), BEAT * 0.9, 0.105);
}

// 48 小节 = 3 段相同的和声循环：A（bars 0-15）→ B（16-31）→ A2（32-47，抬高八度 + 钟琴更亮）
for (let bar = 0; bar < BARS; bar += 1) {
  const chord = CHORDS[bar % CHORDS.length];
  chordBar(chord, bar);
  const section = Math.floor(bar / 16);
  const tokens = section === 1 ? MEL_B[bar % 16] : MEL_A[bar % 16];
  if (section === 2) melodyBar(tokens, bar, { octaveUp: true, gain: 0.135 });
  else melodyBar(tokens, bar, { gain: section === 1 ? 0.175 : 0.195 });
  if (bar % 16 === 15) pickups(bar);
}

// ── 混响：几束短延迟（房间感），步长故意不整除，避免金属味 ──────────────
{
  const taps = [[0.053, 0.17], [0.089, 0.12], [0.131, 0.085], [0.197, 0.055]];
  const src = Float64Array.from(buf);
  taps.forEach(([delaySec, wet]) => {
    const d = Math.round(delaySec * SR);
    for (let i = d; i < total; i += 1) buf[i] += src[i - d] * wet;
  });
}

// ── 轻微低通：把高频的「毛刺」磨圆一点，长时间当背景听不刺耳 ──────────────
{
  const fc = 11000;
  const a = 1 - Math.exp(-2 * Math.PI * fc / SR);
  let y = 0;
  for (let i = 0; i < total; i += 1) { y += a * (buf[i] - y); buf[i] = y; }
}

// ── 无缝循环：把 DURATION 之后的尾巴折回开头 ────────────────────────────
// 这样循环点刚好接上混响的余温，不需要淡入淡出（淡入淡出会在接缝处掉一下音量）。
const loopN = Math.round(DURATION * SR);
const tailN = Math.min(total - loopN, Math.round(TAIL * SR));
// 只折回一半多一点的能量：全量折回会让开头的混响比曲子中段明显更「满」
for (let i = 0; i < tailN; i += 1) buf[i] += buf[loopN + i] * 0.45 * (1 - i / tailN);
// 再把结尾最后 8ms 朝开头的第一个采样拉过去，让首尾波形接得上（否则循环点会「咔」一下）
{
  const fixN = Math.round(0.008 * SR);
  const delta = buf[0] - buf[loopN - 1];
  for (let k = 0; k < fixN; k += 1) buf[loopN - 1 - k] += delta * (1 - k / fixN);
}

// ── 归一化 + 写 wav ───────────────────────────────────────────────────
let peak = 0;
for (let i = 0; i < loopN; i += 1) peak = Math.max(peak, Math.abs(buf[i]));
const target = 0.86;              // 留一点余量防削顶，但别太小声
const scale = peak > 0 ? target / peak : 1;

const dataBytes = loopN * 2;
const wav = Buffer.alloc(44 + dataBytes);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);            // PCM
wav.writeUInt16LE(1, 22);            // 单声道
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 2, 28);       // byteRate
wav.writeUInt16LE(2, 32);            // blockAlign
wav.writeUInt16LE(16, 34);           // bits
wav.write('data', 36);
wav.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < loopN; i += 1) {
  const v = Math.max(-1, Math.min(1, buf[i] * scale));
  wav.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
}

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const wavOnly = args.includes('--wav-only');
const bitrateArg = args.find((a) => a.startsWith('--bitrate='));
const bitrate = bitrateArg ? bitrateArg.slice(10) : '80k';
const wavPath = outArg ? path.resolve(ROOT, outArg.slice(6)) : path.join(OUT_DIR, BASE_NAME + '.wav');
fs.mkdirSync(path.dirname(wavPath), { recursive: true });
fs.writeFileSync(wavPath, wav);
console.log('已写 ' + path.relative(ROOT, wavPath) + '：' + (wav.length / 1024).toFixed(1) + ' KB / ' + DURATION.toFixed(2) + 's');

if (wavOnly) process.exit(0);

// 转 mp3：80kbps 单声道对背景音乐够用（再高听不出来，只是把包撑大）
const mp3Path = wavPath.replace(/\.wav$/, '.mp3');
try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', bitrate, '-ac', '1', mp3Path], { stdio: 'inherit' });
  const size = fs.statSync(mp3Path).size;
  console.log('已写 ' + path.relative(ROOT, mp3Path) + '：' + (size / 1024).toFixed(1) + ' KB（' + bitrate + ' 单声道）');
  if (!outArg) fs.unlinkSync(wavPath);
} catch (error) {
  console.log('没转成 mp3（ffmpeg 不可用？）：' + String(error && error.message ? error.message.split('\n')[0] : error));
  console.log('浏览器也能直接放 wav，先留着 ' + path.relative(ROOT, wavPath));
}
