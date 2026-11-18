// seed-slang.mjs —— 把 state/slang.json 里已收集的候选黑话，用联网查证的释义批量填充并确认。
// 用法：node scripts/seed-slang.mjs
// 只改 meaning/usage/example/status/source，不新增 id、不清空 evidence。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLANG_FILE = path.join(ROOT, 'state', 'slang.json');

// 查证过的释义表（key = 黑话内容）。含义力求准确、适合群友理解。
// 拿不准 / 纯群内私语的，不写进这里（保留 candidate，让学习流继续判断）。
const MEANINGS = {
  // —— 公认网络梗 / 黑话 ——
  '哈基米': {
    meaning: '日语「はちみつ」的音译，原意蜂蜜；网络流行语里指一段可爱小猫跳舞的 BGM 及其形象，泛指可爱、软萌的小动物或人',
    usage: '夸某人/某物可爱时说「哈基米」',
    example: '「你好像哈基米」= 你好可爱',
  },
  '夺舍': {
    meaning: '修仙小说用语，原指魂魄强占他人肉身；网络里引申为「顶替/接管别人的身份、账号或形象」，也指某人画风突变像换了个人',
    usage: '「被夺舍了？」= 你怎么像变了个人',
    example: '「这操作不像你啊，被夺舍了？」',
  },
  '人工智障': {
    meaning: '对 AI 不智能、答非所问或犯低级错误的调侃叫法（谐音「人工智能」）',
    usage: 'AI 犯傻时吐槽它「人工智障」',
    example: '「问它天气它回我食谱，真·人工智障」',
  },
  '牢鱼': {
    meaning: '群内对大肥鱼小姐的调侃黑话：谐音梗，把「大肥鱼」与网络梗「牢大」结合，戏称她「牢鱼」（“牢”来自牢大梗，指差点进局子/坐牢的梗）',
    usage: '群友调侃她时叫「牢鱼」',
    example: '「牢鱼今天又摸鱼了」',
  },
  '哈气了': {
    meaning: '「哈气」的网络变体，指张嘴哈气、有口气/喘气的拟声，群内多用于卖萌或调侃呼吸、叹气',
    usage: '卖萌或调侃时用',
    example: '「太累了，哈气了」',
  },
  '点单式服务': {
    meaning: '像餐厅点单一样提要求、让对方照做；调侃 AI 或客服按条目一一满足需求',
    usage: '形容对方要求多、一项项提',
    example: '「你这是点单式服务啊，一条一条来」',
  },
  '挂到你退休': {
    meaning: '网络梗，指某件事/某段关系会持续很久，「挂」到对方退休，带夸张调侃意味',
    usage: '调侃长期绑定、甩不掉',
    example: '「这号我挂到你退休」',
  },
  '并非139': {
    meaning: '群内梗（来源不详，疑为某数字谐音或事件代号），含义不确定，保留候选待群内进一步确认',
    usage: '',
    example: '',
  },
  '何意味': {
    meaning: '「什么意思」的文言化/玩梗说法，故意用书面语问「何意」，带调侃',
    usage: '用文绉绉的方式问「什么意思」',
    example: '「汝此言何意味？」',
  },
  '艾草': {
    meaning: '网络黑话，谐音「爱草」/「爱操」，含粗俗性暗示，属低俗表达，不宜主动使用',
    usage: '',
    example: '',
  },
  'saob': {
    meaning: '低俗缩写（英文粗口的拼音/缩写变体），含性暗示，属不雅表达，不宜主动使用',
    usage: '',
    example: '',
  },
  'sao': {
    meaning: '「骚」的拼音，网络里形容风骚/性感或行为张扬，含轻微调侃或贬义，注意语境',
    usage: '',
    example: '',
  },
  'csn': {
    meaning: '群内缩写（来源不详，疑为拼音首字母），含义不确定，保留候选待确认',
    usage: '',
    example: '',
  },
  'gsm': {
    meaning: '群内缩写（来源不详，疑为拼音首字母），含义不确定，保留候选待确认',
    usage: '',
    example: '',
  },
};

function main() {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(SLANG_FILE, 'utf8'));
  } catch (e) {
    console.error('读取 slang.json 失败:', e.message);
    process.exit(1);
  }
  if (!Array.isArray(entries)) {
    console.error('slang.json 顶层不是数组，中止');
    process.exit(1);
  }

  let confirmed = 0;
  let skipped = 0;
  for (const e of entries) {
    const key = String(e.content ?? '').trim();
    const seed = MEANINGS[key];
    if (!seed) {
      skipped += 1;
      continue;
    }
    e.meaning = seed.meaning ?? e.meaning ?? '';
    e.usage = seed.usage ?? e.usage ?? '';
    e.example = seed.example ?? e.example ?? '';
    // 只有给出真实含义的才确认；「不确定」的保留 candidate 让学习流继续判断
    if (seed.meaning && !/不确定|保留候选|来源不详/.test(seed.meaning)) {
      e.status = 'confirmed';
      e.source = 'manual';
      confirmed += 1;
    }
    e.updatedAt = new Date().toISOString();
  }

  fs.writeFileSync(SLANG_FILE, JSON.stringify(entries, null, 2), 'utf8');
  console.log(`✅ 已填充释义并落盘 state/slang.json`);
  console.log(`   确认 confirmed: ${confirmed} 条，跳过/保留候选: ${skipped} 条`);
  // 打印最终 confirmed 表，便于核对
  const table = entries.filter((e) => e.status === 'confirmed');
  console.log('\n当前已确认黑话表：');
  for (const e of table) console.log(`  - ${e.content}：${e.meaning}`);
}

main();
