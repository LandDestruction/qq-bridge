// 缇宝语音规则粗分类（关键词 + 长度），输出 data/voice/tribbie/scene-auto.txt
// 每行：文件名\t标签。规则分不出的兜底 explain，之后人工抽查校正。
import fs from "node:fs";

const refs = fs.readFileSync("data/voice/tribbie/refs.txt", "utf8").split("\n").filter(Boolean).map(l => l.split("\t"));
const out = [];

function classify(text, dur) {
  const t = text.replace(/[，。！？、\s]/g, "");
  // 1. 纯语气词/短反应
  if (/^(哎呀|啊|嗯|哼呃|哦|咦|呃|哈|唉|哇|天啊)+$/.test(t) || t.length <= 2) return "filler";
  if (/^(可以呀|OK|干杯|酸辣辣|你就是就是|我…在做…)$/.test(t)) return "filler";
  // 2. 感谢/客气
  if (/谢谢|抱歉|不客气|辛苦|太好了|哪里哪里|没关系|爱莫能助/.test(t)) return "thanks";
  // 3. 惊讶/疑问
  if (/为什么|什麼|怎么|难道|天啊|慢点|危险|怎么可能|什麼意思|这是|这个名字|我当时怎么/.test(t)) return "surprise";
  // 4. 伤感/怀念
  if (/想念|想她|想他|消失|遥远|妈妈|回忆|难过|悲伤|流泪|陪陪|不舍|梦到|孤单|离开我们|离我们好远|愛莫能助/.test(t)) return "sad";
  // 5. 安慰/温柔
  if (/乖|别怕|没事|休息|服药|别担心|别道歉|抱抱|勉强|量力|站在你背后|站在你身边|别难过|你要保重|这里没有坏人/.test(t)) return "comfort";
  // 6. 庄重/宣言
  if (/三者|律法|誓言|神明|神域|创世|天地|命运|神性|祈祷|黄金|裁决|开辟|编织|引渡|祈求|宣我|诗篇|歌谣|神战|百年/.test(t)) return "solemn";
  // 7. 元气/鼓励
  if (/前进|加油|拼尽全力|全力以赴|盼着|明天|战士|默契|度过难关|越来越好|别留下遗憾|适合|会站在你背后|朝着|振作/.test(t)) return "cheer";
  // 8. 俏皮/玩笑
  if (/猜猜|嘿嘿|玩笑|调皮|逗|啦|嘛|咦|坏蛋|活力|前辈|小孩子|嘿嘿|我们分啦|有空|适合吧|很灵通/.test(t)) return "playful";
  // 9. 问候/重逢（含告别）
  if (/见面|大家好|欢迎|保重|先走了|又见面|到我们|我们就是|真的是我们/.test(t)) return "greet";
  // 兜底
  return "explain";
}

for (const [file, dur, text] of refs) {
  out.push(`${file}\t${classify(text || "", parseFloat(dur))}`);
}
fs.writeFileSync("data/voice/tribbie/scene-auto.txt", out.join("\n") + "\n");

// 统计
const stat = {};
for (const l of out) { const s = l.split("\t")[1]; stat[s] = (stat[s] || 0) + 1; }
console.log("分类统计:", JSON.stringify(stat, null, 0));
console.log("总:", out.length);
