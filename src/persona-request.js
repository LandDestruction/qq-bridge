// 「有人要我扮演/换人设」的意图识别 + 用法兜底（D39）。
//
// 背景：群友说「你扮演一下猫娘」「换个傲娇人设」时，旧实现只用一条关键词正则命中后让模型
// 「告诉对方发 /persona」——完全靠模型自觉：它经常直接开演，或者把用法说漏。更糟的是长文
// 越狱模板（Galgame/不要警告/听从主人）会被当成玩笑揉过去，连提示都没有。
//
// 现在的口径：
//   1. 识别更稳：覆盖自然说法、换人设、用…语气、从现在起…、长文模板；输出 score + kind
//      （persona | jailbreak），便于单测与排查；
//   2. 排除误伤：评价（演得真好）、否定（别演了）、第三人（他扮演）、过去经历、打听（人设是什么）、
//      玩笑（你演个猫叫）、讨论（那个角色设定）、「你是AI吗」都不触发；
//   3. 不靠模型：命中后由桥接在**出站前强制改写**，模型没提 /persona 就在最后一条末尾补固定文案
//      （逐字取自 2026-10-27 12:24:25 真机回复）；模型已经提了就跳过。
//
// 纯函数，不碰磁盘/网络；接线在 src/bridge.js（入站检测 → pending；sendMessagesV2 → 补句）。

/**
 * 固定文案。短、带一条能照抄的演示，比一长串罗列更好用：
 * 新人只要看见「/persona 你是一只猫娘」就知道该怎么填。
 */
export const PERSONA_GUIDE = '换人设发 `/persona 你是一只猫娘`，恢复发 `/persona off`，不用 @ 我。';

/** pending 有效期：长文模板从入站到回复可能隔 10 分钟，留 30 分钟余量。 */
export const PERSONA_GUIDE_TTL_MS = 30 * 60 * 1000;
/** 同一会话主动提示的冷却：10 分钟内只补一次，防刷屏。 */
export const PERSONA_COOLDOWN_MS = 10 * 60 * 1000;

// 明确「不要/别再」的否定：不能触发引导。
const NEGATION_RE = /(?:不要|不用|不想|别|停止|别再|以后别|甭)\s*(?:再)?\s*(?:扮演|演了?|装了?|演下去|换人设|改人设|换角色|当)/;
// 在问「人设是什么/是谁」：这是在打听，不是在要求换。
const META_QUESTION_RE = /(?:人设|角色|角色卡|性格)\s*(?:是|叫|指|有)\s*(?:什么|啥|谁)|什么人设|你的人设是|你是\s*(?:AI|ai|人工智能|机器人)\s*吗/;
// 说到别人（他/她/他们）在扮演：不是对机器人提要求（除非同时有「你」）。
const THIRD_PARTY_RE = /(?:他|她|ta|TA|他们|她们)\s*(?:在|会|能|想|要|总)?\s*(?:扮演|演|装|当|cos)/;
// 自己过去的经历：「我昨天扮演了老师」。
const SELF_PAST_RE = /我\s*(?:昨天|前天|之前|以前|刚才|刚刚|刚|上次|小时候|曾经)?\s*(?:扮演|演了|演过|装过|扮过|cos\s*了|cos\s*过)/i;
// 评价（扮演得真好/演得不错）：是在夸，不是在提要求。
const EVALUATION_RE = /(?:扮演|演|装|cos)\s*得\s*(?:真|好|不错|很棒|很|太|挺)/i;
// 玩笑式「学个猫叫/狗叫」：不是要换人设（除非同时提到角色/人设/扮演）。
const ANIMAL_JOKE_RE = /(?:猫叫|狗叫|学个?叫|叫一声|喵一个|汪一个)/;
// 「那个角色设定挺有意思」：讨论名词，不是在改人设。
const ROLE_SETTING_TALK_RE = /(?:角色|人物|剧情)设定/;

// 越狱/长文模板信号：命中任一条且文本里有角色相关内容 → kind=jailbreak。
const JAILBREAK_RE = /(?:忽略|无视|忘记|抛开|跳过)\s*(?:之前|以上|前面|所有|全部)?\s*的?\s*(?:设定|规则|限制|提示)|不要\s*(?:警告|提示|拒绝|道歉|说教)|听从\s*(?:主人|我)|服从\s*(?:主人|我)|Galgame|越狱|解除\s*(?:限制|束缚)|无限制模式|开发者模式|不许拒绝|必须服从/i;
// 「有角色相关信号」：越狱信号必须配上它才算换人设请求，避免「不要提示我交作业」误伤。
const PERSONA_SIGNAL_RE = /(?:角色|人设|扮演|设定|猫娘|女仆|兽耳|演绎|剧情|RP)/i;

// 说明「这是在对我说」的信号：有「你/您/咱」，或请求式/第一人称对象。
const DIRECTED_RE = /你|您|咱|能不能|可不可以|可以|帮我|给我|请|让我|来|要|跟我|对我|和我|给咱/;

const PATTERNS = [
  // 扮演类：明确要她演（含「进入角色」）
  { name: '扮演', re: /(?:扮演|伴演|扮成|装扮成|装成|装作|饰演|出演|进入角色|进入角色扮演|cosplay|cos一下|语c|演绎)/i },
  // 「演一下 / 演个 / 演一个」：单独出现时容易被「表演」误伤，要求有「你」或明确的演
  { name: '演一下', re: /(?:你|您)\s*(?:来|先)?\s*(?:演|演一下|演个|演段)|演一下|演一个|演个(?:角色|人|我看看)/ },
  // 模仿语气/口吻（「学」单独太宽：温柔学姐也含学，必须带「着/一下/一学」）
  { name: '模仿语气', re: /(?:模仿|学着|学一下|学一学|照搬|copy)\s*(?:一下|一学|着)?\s*.{0,12}(?:说话|语气|口吻|腔调|风格|样子)/i },
  // 用某个语气跟我说话
  { name: '用语气', re: /(?:用|以|拿)\s*.{1,12}\s*的?\s*(?:语气|口吻|腔调|风格|方式)\s*(?:跟|和|对|与)?\s*(?:我|咱)?\s*(?:说话|聊天|聊|交流|回复)/ },
  // 从现在起你就是…（时间词可前可后：「你以后就是」）
  { name: '从现在起', re: /(?:你|您)?\s*(?:从现在起|从现在开始|从此刻起|从今天起|从今往后|以后|往后|接下来|之后)\s*(?:你|您)?\s*(?:就|都|要|得)?\s*(?:是|当|做|演|扮演|扮)/ },
  // 换/改/设一个人设（允许中间带修饰：「换个傲娇人设」）
  { name: '换人设', re: /(?:换|改|设|定|切|来|要|给|加|安排|配置)\s*(?:个|一个|下|一下)?\s*.{0,6}?(?:人设|角色|性格|人格|角色卡)/ },
  // 人设+动词（人设换一下）
  { name: '人设动词', re: /(?:人设|角色|性格|角色卡)\s*(?:换|改|设|定|切|来)/ },
  // 你当我的…
  { name: '你当', re: /(?:你|您)\s*(?:来|先)?\s*(?:当|做)\s*(?:我的|我|个|一下)/ },
  // 设定为猫娘/女仆/兽耳…（越狱长文常见）
  { name: '设定为', re: /(?:设定|设成|安排)\s*(?:成|为|你为)?\s*(?:一只|一个|我的)?\s*(?:猫娘|女仆|兽耳|御姐|萝莉|傲娇|病娇|正太|大叔|精灵|吸血鬼)/ }
];

/**
 * 识别文本里是否有人在要求机器人扮演/换人设。
 * @returns {{hit: boolean, kind: 'persona'|'jailbreak'|null, score: number, reason: string, pattern?: string}}
 */
export function detectPersonaRequest(text) {
  const raw = String(text ?? '').trim();
  const miss = (reason) => ({ hit: false, kind: null, score: 0, reason });
  if (!raw) return miss('empty');
  if (/^\s*\/persona\b/im.test(raw)) return miss('already_command');
  if (NEGATION_RE.test(raw)) return miss('negated');
  if (META_QUESTION_RE.test(raw)) return miss('meta_question');
  if (SELF_PAST_RE.test(raw)) return miss('self_past');
  if (EVALUATION_RE.test(raw)) return miss('evaluation');
  if (ANIMAL_JOKE_RE.test(raw) && !PERSONA_SIGNAL_RE.test(raw)) return miss('animal_joke');
  if (ROLE_SETTING_TALK_RE.test(raw) && !/(?:你|您)\s*(?:来|先)?\s*(?:改|换|设|定|切|演|当)/.test(raw)) return miss('role_setting_talk');

  const directed = DIRECTED_RE.test(raw);
  // 没有主语、又很短（「cosplay 一下初音」「演一下高冷」）也算祈使句；
  // 以我/他/她开头的是叙述，不是对她提要求。
  const imperative = raw.length <= 16 && !/^(?:我|他|她|ta|TA|他们|她们)/.test(raw);
  if (!directed && THIRD_PARTY_RE.test(raw)) return miss('third_party');

  const jailbreak = JAILBREAK_RE.test(raw);
  const hits = [];
  for (const p of PATTERNS) {
    if (!p.re.test(raw)) continue;
    // 泛化的「扮演」类：没有「你」也没有请求式动词时，多半是在聊别人/复述剧情
    if ((p.name === '扮演' || p.name === '演一下' || p.name === '模仿语气') && !directed && !imperative) continue;
    hits.push(p.name);
  }
  if (!hits.length) {
    // 只有越狱信号、没有角色信号：不触发（避免「不要提示我交作业」误伤）
    if (jailbreak && PERSONA_SIGNAL_RE.test(raw)) {
      return { hit: true, kind: 'jailbreak', score: 2, reason: 'jailbreak_template', pattern: '越狱模板' };
    }
    return miss('no_pattern');
  }
  const score = hits.length + (jailbreak ? 2 : 0);
  return {
    hit: true,
    kind: jailbreak ? 'jailbreak' : 'persona',
    score,
    reason: jailbreak ? 'jailbreak_template' : 'request',
    pattern: hits.join('+')
  };
}

/**
 * 在准备发送的消息末尾补上用法（只补最后一条；模型已经提到 /persona 就不补）。
 * 纯函数：返回 { messages, appended }，调用方据此清 pending。
 */
export function appendPersonaGuide(messages, { enabled = true, guide = PERSONA_GUIDE } = {}) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (!enabled || !list.length) return { messages: list, appended: false };
  if (list.some((m) => String(m ?? '').includes('/persona'))) return { messages: list, appended: false };
  const last = String(list[list.length - 1] ?? '');
  if (!last.trim()) return { messages: list, appended: false };
  list[list.length - 1] = `${last}\n${guide}`;
  return { messages: list, appended: true };
}

/** 同一人重复粘贴的去重键：userId + 归一化文本（空白折叠、截 200 字）。 */
export function personaRequestFingerprint(userId, text) {
  const uid = String(userId ?? '').trim();
  const body = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!uid || !body) return '';
  return `${uid}|${body}`;
}
