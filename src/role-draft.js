// 角色卡「一句话生成」的纯规则：把用户的一句话变成一段给模型看的 prompt，
// 再把模型吐回来的 Markdown 规整成「名称 + 正文」；模型不可用时用模板兜底。
//
// 为什么兜底也要有：控制台第一次打开的那套空白系统里，用户可能既没配模型也不联网；
// 这时至少给他一张结构完整、能直接改的骨架，而不是一个转圈到超时的输入框。

export const ROLE_DRAFT_MAX_REQUEST = 500;   // 一句话请求的上限（字符）
export const ROLE_DRAFT_MAX_CHARS = 6000;    // 生成的正文上限（防止模型啰嗦到注入不下）
export const ROLE_DRAFT_HEADER = '# 角色卡：';

const NAME_FALLBACK_MAX = 12;
// 名称里允许的字符（与后端 validateRoleName 的宽容度对齐：中文 / 字母 / 数字 / 横线）
const NAME_SAFE = /[^\u4e00-\u9fa5A-Za-z0-9_-]/g;

/** 从用户的描述里抠一个能用的名字：优先「叫X / 名叫X / 名字是X」，否则取前几个字。 */
export function roleDraftNameFrom(request) {
  const text = String(request || '').trim();
  if (!text) return '新角色';
  const m = /(?:叫|名叫|名字是|名字叫|称作|昵称是)\s*[「“"']?([\u4e00-\u9fa5A-Za-z0-9_-]{1,20})/.exec(text);
  if (m && m[1]) return m[1].replace(NAME_SAFE, '').slice(0, NAME_FALLBACK_MAX) || '新角色';
  const head = text.split(/[，。,.；;！!？?\n\r]/)[0].replace(NAME_SAFE, '');
  return head.slice(0, NAME_FALLBACK_MAX) || '新角色';
}

/** 给模型的系统提示：只许输出那种三段式角色卡，别写解释、别用代码块。 */
export function buildRoleDraftMessages(request) {
  const text = String(request || '').trim().slice(0, ROLE_DRAFT_MAX_REQUEST);
  return [
    {
      role: 'system',
      content: [
        '你要为 QQ 聊天机器人写一张「角色卡」，输出**纯 Markdown**，不要任何解释、不要代码块围栏。',
        '格式必须严格是：',
        '# 角色卡：<名字>',
        '',
        '## 一、你是谁',
        '<一到三句：身份、年龄、和对方的关系>',
        '',
        '## 二、底色',
        '- <性格底子，2 到 3 条，每条一句话>',
        '',
        '## 三、说话方式',
        '- <句子长度、语气、口头禅的使用边界，2 到 4 条>',
        '',
        '要求：中文；具体、可执行，不要写「温柔善良」这类空词；不要出现「作为一个 AI」之类的元叙述；',
        `总长 300 到 900 字，不要超过 ${ROLE_DRAFT_MAX_CHARS} 字。`
      ].join('\n')
    },
    { role: 'user', content: text }
  ];
}

/** 去掉模型可能包的代码块与「好的，以下是…」这类前言。 */
export function cleanRoleDraftReply(text) {
  let s = String(text || '').replace(/\r\n/g, '\n').trim();
  s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  // 模型常见开场白：从第一个 # 角色卡 开始截
  const at = s.search(/^#\s*角色卡/m);
  if (at > 0) s = s.slice(at).trim();
  return s;
}

/** 把模型输出规整成 { name, content }；名称优先取标题里的，没有就用请求里抠出来的。 */
export function parseRoleDraft(raw, request = '') {
  const cleaned = cleanRoleDraftReply(raw);
  if (!cleaned) return null;
  const fallbackName = roleDraftNameFrom(request);
  const firstLine = cleaned.split('\n')[0];
  let name = '';
  const m = /^#\s*角色卡[：:]\s*(.+)$/.exec(firstLine);
  if (m && m[1]) name = m[1].trim().replace(NAME_SAFE, '').slice(0, NAME_FALLBACK_MAX);
  if (!name) name = fallbackName;
  let content = cleaned;
  if (!/^#\s*角色卡/m.test(content)) content = ROLE_DRAFT_HEADER + name + '\n\n' + content;
  content = content.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  if (content.length > ROLE_DRAFT_MAX_CHARS) content = content.slice(0, ROLE_DRAFT_MAX_CHARS) + '\n';
  // 至少要有三段里的第一段，否则算「没生成成功」，让上层走兜底
  if (!/##\s*一、你是谁/.test(content)) return null;
  return { name, content, chars: content.length };
}

/**
 * 模型不可用时的「本地拼卡」：从用户那句话里抽年龄/职业/性格/说话风格，拼成能直接用的骨架。
 * 为什么不是把原话直接贴进去：那样出来的是「一句话 + 三个空标题」，用户还得自己从零写；
 * 抽字段之后至少「你是谁 / 底色 / 说话方式」三段都有内容，改起来是润色而不是创作。
 */
const AGE_RE = /(\d{1,2})\s*(?:岁|years?)/i;
const JOB_WORDS = ['画师', '插画师', '学生', '大学生', '店员', '老板', '老师', '程序员', '歌手', '诗人', '作家', '摄影师', '主播', '咖啡师', '医生', '护士', '厨师', '设计师', '主播', '海獭', '猫', '狐狸', '机器人', '剑士', '法师', '骑士', '侦探'];
const TRAIT_WORDS = ['安静', '话少', '活泼', '爱笑', '嘴硬', '温柔', '冷淡', '别扭', '懒', '认真', '毒舌', '社恐', '自来熟', '好奇心重', '爱撒娇', '嘴甜', '固执', '天然', '元气', '慢热'];
const STYLE_WORDS = ['慢', '短句', '比喻', '口头禅', '少说话', '结巴', '语气词', '不说脏话', '爱用省略号', '爱反问', '偶尔说怪话', '爱笑'];
function pickWords(text, words, max = 3) {
  const hit = [];
  for (const w of words) if (text.includes(w)) hit.push(w);
  return hit.slice(0, max);
}
export function stubRoleDraft(request) {
  const text = String(request || '').trim().slice(0, ROLE_DRAFT_MAX_REQUEST);
  const name = roleDraftNameFrom(text);
  const age = (AGE_RE.exec(text) || [])[1];
  const jobs = pickWords(text, JOB_WORDS, 2);
  const traits = pickWords(text, TRAIT_WORDS, 3);
  const styles = pickWords(text, STYLE_WORDS, 3);
  const idCard = [
    `你是「${name}」`,
    age ? `${age} 岁` : '',
    jobs.length ? jobs.join(' / ') : '',
    '在这个 QQ 里和对方聊天'
  ].filter(Boolean).join('，') + '。';
  const traitLines = (traits.length
    ? traits.map((t) => `- ${t}：${traitHint(t)}`)
    : ['- 有自己的小坚持：认定的事会较真，但不拿它压人', '- 慢热：前几句客气，熟了话明显变多']);
  // 兜底本身也要是「人话」：以前最后落到 styleHint 的默认文案，等于把
  // 「按它的性格写具体说法」这句给模型的指令写进了角色卡，读着像没写完的提纲。
  const styleLines = (styles.length ? styles : ['短句', '语气自然不客服腔'])
    .map((t) => styleHint(t))
    .filter(Boolean)
    .map((t) => `- ${t}`);
  const content = [
    ROLE_DRAFT_HEADER + name,
    '',
    '## 一、你是谁',
    idCard,
    text ? `（来自你的描述：${text}）` : '',
    '',
    '## 二、底色',
    ...traitLines,
    '',
    '## 三、说话方式',
    ...styleLines,
    ''
  ].filter((line) => line !== null).join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  return { name, content, chars: content.length, source: 'stub' };
}
function traitHint(word) {
  const map = {
    '安静': '不抢话，一句话里不塞三个感叹号',
    '话少': '回话偏短，不主动开长话题',
    '活泼': '会接梗，愿意先开口',
    '爱笑': '句尾常带笑意，但不用「哈哈哈」刷屏',
    '嘴硬': '嘴上不让，行动上会让一步',
    '温柔': '不评价人，只接情绪',
    '冷淡': '不主动关心，但问到会认真答',
    '别扭': '想关心会绕一下再说',
    '懒': '能一句说完不说两句',
    '认真': '答应的事会追问进度',
    '毒舌': '只损事不损人，损完会补一句软的',
    '社恐': '被搭话才接，主动开口很珍贵',
    '自来熟': '第一次聊也不客气，但不越界',
    '好奇心重': '会追问细节，问完记得住',
    '爱撒娇': '偶尔耍赖，看场合收',
    '嘴甜': '夸人具体，不空夸',
    '固执': '认定的事会坚持，但允许被说服一次',
    '天然': '偶尔理解歪，但歪得好笑',
    '元气': '情绪正，不逼别人一起正',
    '慢热': '前几句客气，熟了之后话变多'
  };
  return map[word] || '把它写成具体行为，别停在形容词';
}
function styleHint(word) {
  const map = {
    '慢': '一句话说完停一下，不急着追问',
    '短句': '多数回复一到两句，长话拆成两条',
    '比喻': '偶尔用比喻，但不为了显摆硬凑',
    '口头禅': '有一个固定的收尾词，别每句都用',
    '少说话': '能点头就不展开，重要的事才多说',
    '结巴': '紧张时重复半个词，不全程结巴',
    '语气词': '用「欸」「唔」这类，别堆「呢呀哈」',
    '不说脏话': '再急也不带脏字',
    '爱用省略号': '停顿用「…」，但不用来敷衍',
    '爱反问': '偶尔把问题抛回去，不总反问',
    '偶尔说怪话': '十句里冒一句跳脱的，说完自己也不解释',
    '爱笑': '好笑就笑，不硬笑',
    '语气自然不客服腔': '像平时打字，不端客服腔，不用「亲」「呢」'
  };
  return map[word] || '';
}

/** 一键生成总入口：模型有回就用模型解析结果，否则回落模板。 */
export function resolveRoleDraft({ reply, request, modelError } = {}) {
  const parsed = reply ? parseRoleDraft(reply, request) : null;
  if (parsed) return { ...parsed, source: 'model', modelError: modelError || '' };
  const stub = stubRoleDraft(request);
  return { ...stub, modelError: modelError || '' };
}

/** 名称撞车时按「-2 / -3」逐级找空位（纯函数，便于测）。 */
export function uniqueRoleName(name, exists) {
  const base = String(name || '新角色').trim() || '新角色';
  const taken = typeof exists === 'function' ? exists : () => false;
  if (!taken(base)) return base;
  for (let i = 2; i <= 50; i += 1) {
    const next = `${base}-${i}`;
    if (!taken(next)) return next;
  }
  return `${base}-${Date.now()}`;
}
