#!/usr/bin/env node
// 编码护栏测试：请求体按 GBK 发进来时不能再变成一串 U+FFFD 发进 QQ（真出过一次乱码）。
// 两处护栏：① console-server 严格 UTF-8 → 失败退 GB18030 重解；
// ② outbound-policy 发送前拦下含 U+FFFD 的正文。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(path.join(ROOT, 'src/bridge/console-server.js'), 'utf8');
const outbound = fs.readFileSync(path.join(ROOT, 'src/bridge/outbound-policy.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(ok, name, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`); }
}

// ── ① 请求体解码 ────────────────────────────────────────────────────────────
check(/new TextDecoder\('utf-8', \{ fatal: true \}\)\.decode\(raw\)/.test(server),
  '请求体先按严格 UTF-8 解码（非法字节不会被悄悄替换成 U+FFFD）');
check(/new TextDecoder\('gb18030', \{ fatal: true \}\)\.decode\(raw\)/.test(server),
  'UTF-8 解不开时退回 GB18030（GBK 超集）重解');
check(/请求体不是 UTF-8（也不是 GBK）/.test(server),
  '两种编码都解不开时回 400 并说明原因');
check(!/Buffer\.concat\(chunks\)\.toString\('utf8'\)/.test(server),
  '不再用 toString("utf8") 直接吞请求体（那正是乱码来源）');
check(/按 GB18030 重新解码/.test(server),
  '退回解码时写一行日志，排查时能看到是哪条请求');
check(/const raw = Buffer\.concat\(chunks\);/.test(server),
  '保留原始 Buffer 供两种解码复用');

// ── ② 发送侧乱码闸 ──────────────────────────────────────────────────────────
check(/String\.fromCharCode\(0xfffd\)/.test(outbound) && /includes\(REPLACEMENT_CHAR\)/.test(outbound),
  '发送前检查正文是否含 U+FFFD 替换字符（用 fromCharCode(0xfffd) 判定，源码里不出现乱码字形）');
check(/const garbled = \(Array\.isArray\(messages\)/.test(outbound),
  '逐条检查要发的消息');
check(/已拦下不发送/.test(outbound),
  '命中就抛错拦下，不往 QQ 发');
const guardAt = outbound.indexOf('const garbled =');
const applyAt = outbound.indexOf('messages = applyPersonaGuideToMessages(key, messages);', guardAt);
check(guardAt > 0 && applyAt > guardAt,
  '乱码闸在真正拼装/发送之前执行');

// ── ③ 解码逻辑本身（Node 自带 GB18030） ─────────────────────────────────────
const gbk = (text) => Buffer.from(new TextEncoder().encode(text).length ? iconvLike(text) : []);
// 手工构造 GBK 字节：Node 没有内置 GBK 编码器，这里用固定字节表覆盖几个常用字。
const GBK_BYTES = {
  测: [0xb2, 0xe2], 试: [0xca, 0xd4],
  编: [0xb1, 0xe0], 码: [0xc2, 0xeb],
  中: [0xd6, 0xd0], 文: [0xce, 0xc4],
  私: [0xcb, 0xbd], 聊: [0xc1, 0xc4]
};
function iconvLike(text) {
  const out = [];
  for (const ch of text) {
    const bytes = GBK_BYTES[ch];
    if (!bytes) throw new Error('缺少 GBK 字节表：' + ch);
    out.push(...bytes);
  }
  return Buffer.from(out);
}
function decodeLikeServer(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('gb18030', { fatal: true }).decode(buf); }
}
const sample = iconvLike('编码测试');
check(decodeLikeServer(sample) === '编码测试',
  'GBK 字节按服务端同一套逻辑能还原成正确中文', [...sample]);
check(sample.toString('utf8').includes('\uFFFD'),
  '同一份字节若直接按 UTF-8 解就会出替换字符（正是线上那串乱码的成因）');
check(decodeLikeServer(Buffer.from('聊天', 'utf8')) === '聊天',
  '正常的 UTF-8 请求体不受影响');
let threw = false;
try { new TextDecoder('gb18030', { fatal: true }).decode(Buffer.from([0xff, 0xff, 0xff])); }
catch { threw = true; }
check(threw, 'GB18030 也解不开的字节会抛错（不会静默产出垃圾）');

console.log(`\n========== 通过 ${pass} / 失败 ${fail} ==========`);
process.exit(fail ? 1 : 0);
