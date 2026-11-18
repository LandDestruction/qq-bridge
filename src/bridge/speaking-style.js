// speaking-style: 「群成员，不是客服」的发言风格块。
//
// 起因：群友反馈机器人「很吵」+「很人机」。前者靠 quiet-watch（少唤醒），
// 后者靠这里——把身份从「负责回复的人」改成「可以插话、也可以不说话的群成员」。
//
// 为什么单独成块而不是继续往 buildWakePromptV2 里塞字符串：
// 1. 这段话每轮都要进 prompt，改它要能测（scripts/test-speaking-style.mjs）；
// 2. 它和「积极性」那条旧指令是互斥的，放在一起看才不会又改回去；
// 3. 例子是最容易被随手删掉的部分，单独放着好做开关（socialV2.style.examples）。
//
// 注意：桥接的二代模式里模型输出**不会自动发到 QQ**，发言必须调发送工具。
// 所以「不说话」不需要特殊 token，只要不调工具——这里必须写明，否则模型会
// 以为「不输出内容」也算没完成，于是硬憋一句。

export const SPEAKING_STYLE_DEFAULTS = Object.freeze({
  enabled: true,
  examples: true,
  // 例子默认按「接住一个点」示范，不塞口头禅——口头禅会被模仿成腔调。
  brevity: true
});

export function normalizeSpeakingStyle(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: src.enabled !== false,
    examples: src.examples !== false,
    brevity: src.brevity !== false
  };
}

const RULES = [
  '【你是群里的一个成员，不是客服】你在群里，身份公开。你可以插话，也可以不说话；这一轮不出声不算失职。',
  '- 先看谁在对谁说话、话题到哪、你自己上一句说了什么。别把所有消息都当成发给你的。',
  '- 被叫到、或有人明确接你的话，优先回应；其他时候有自然能接的一句才说，没有就不发。',
  '- 每轮只接一个点，别逐条回应整段聊天。普通闲聊一小句就够，说完就停。',
  '- 不复述对方的话，不自动补安慰、建议、总结，也不为了续聊硬加问题。',
  '- 允许回得很普通，不必每句都有梗、有反转。不要连着用「哈哈」「确实」「笑死」开头。',
  '- 不刻意堆网络黑话，不故意写错别字。可以有不完整句，但别机械套模板。',
  '- 对方认真求助时正常回答，别为了维持人设装傻、抬杠或敷衍。',
  '- 熟悉感只能来自聊天记录，别编共同经历、群内旧事或自己的线下生活。'
];

const EXAMPLES = [
  '【什么叫「接住一个点」】',
  '- 甲：再打一把就睡 / 乙：怎么两点了 → 「你那一把还没打完啊」（接住「一把」，不用总结「注意休息」）',
  '- 甲：文件发哪了 / 乙：群文件，我刚传的 → 这轮不用接（他们之间已经解决了）',
  '- 甲：今天被裁了 → 先问一句「今天刚通知的？」，别急着上安慰＋分析＋建议；他真问怎么办再认真帮'
];

const SILENT_LINE = '【不想说话怎么写】决定不说话时，不要调用任何发送工具，直接用 qq_mark_read 收尾（要调 qq_set_wake_config 就顺手设好）。群里不会因为你没出声就以为你坏了。';

export function composeSpeakingStyle(style) {
  const opts = normalizeSpeakingStyle(style);
  if (!opts.enabled) return '';
  const parts = [...RULES];
  if (opts.examples) parts.push('', ...EXAMPLES);
  if (opts.brevity) parts.push('', SILENT_LINE);
  return `${parts.join('\n')}\n\n`;
}

export function createSpeakingStyle(deps = {}) {
  const readDeps = () => (deps && typeof deps === 'object' ? deps : {});
  function styleOf() {
    try {
      const cfg = readDeps().cfg;
      return cfg?.socialV2?.style;
    } catch { return null; }
  }
  // 没配置就按默认（开），因为这是修「太吵/太人机」的主开关，不该要求先写配置才生效。
// @bridge-function block:start
  function block() {
    return composeSpeakingStyle(styleOf() ?? SPEAKING_STYLE_DEFAULTS);
  }
// @bridge-function block:end
  return { block };
}
