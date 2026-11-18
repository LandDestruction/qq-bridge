// 「@我 + /persona」命令识别（纯函数）。
//
// 为什么单独成模块：QQ 网关给的是一次性事件，段数组（at/text 分开）和纯文本字符串
// 两种形态都会出现；桥接只该关心「这轮是不是在改人设、参数是什么」，不该自己写正则。
// 规则很窄：必须 at 到「我自己」，且 at 之后第一个 token 就是 /persona——
// 正文里提到「你可以发 /persona 试试」不算命令，否则用户随口一提就被改了人设。

const CQ_AT_PREFIX_RE = /^\s*\[CQ:at,qq=(-?\d+)(?:,[^\]]*)?\]/i;
const AT_PREFIX_RE = /^\s*@([^\s@]+)\s*/;
const PERSONA_RE = /^\/(persona)(?=$|\s)/i;
const PERSONA = '/persona';

function asStringList(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item ?? '')).filter(Boolean);
}

function segmentAtQq(segment) {
  if (!segment || segment.type !== 'at') return '';
  const qq = segment.qq ?? segment.user_id ?? segment.userId ?? segment.data?.qq ?? '';
  return String(qq ?? '');
}

function segmentsText(segments, from = 0) {
  const parts = [];
  for (let i = from; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment) continue;
    if (segment.type === 'text') parts.push(String(segment.text ?? segment.data?.text ?? ''));
    else if (segment.type === 'at') {
      // 段数组里如果还有别的 at，按文本还原出来，避免把「@别人」当成前缀吃掉。
      parts.push(`@${segment.name ?? segment.qq ?? ''}`);
    }
  }
  return parts.join('');
}

// 返回「去掉 at 前缀后的正文」与「是否 at 到我自己」。
function splitMentionText(raw, selfIds, selfNames) {
  let text = String(raw ?? '');
  const cq = CQ_AT_PREFIX_RE.exec(text);
  if (cq) {
    const qq = cq[1];
    // selfIds 没配时无法证明「at 的不是我」：按「可能是我」处理，让上层再做一次比对。
    const atSelf = selfIds.length === 0 ? true : selfIds.includes(qq);
    return { atSelf, rest: text.slice(cq[0].length) };
  }
  const at = AT_PREFIX_RE.exec(text);
  if (!at) return { atSelf: false, rest: text };
  const name = at[1];
  const atSelf = selfNames.includes(name) || selfNames.length === 0;
  if (!atSelf) return { atSelf: false, rest: text };
  // 连续 @（@a @b /persona）只吞自己那些，遇到别人的 @ 就停，保证命令判定仍在开头。
  let rest = text.slice(at[0].length);
  for (let guard = 0; guard < 4; guard += 1) {
    const next = AT_PREFIX_RE.exec(rest);
    if (!next) break;
    if (!(selfNames.includes(next[1]) || selfNames.length === 0)) break;
    rest = rest.slice(next[0].length);
  }
  return { atSelf: true, rest };
}

export function parseMentionCommand(message, { selfIds = [], selfNames = [] } = {}) {
  const ids = asStringList(selfIds);
  const names = asStringList(selfNames);
  let atSelf = false;
  let body = '';

  if (Array.isArray(message)) {
    const segments = message;
    const atIndex = segments.findIndex((segment) => {
      const qq = segmentAtQq(segment);
      if (!qq) return false;
      return ids.length === 0 ? true : ids.includes(qq);
    });
    if (atIndex >= 0) {
      atSelf = true;
      // at 之后所有文本段拼起来；at 之前的寒暄不算命令正文。
      body = segmentsText(segments, atIndex + 1);
    } else {
      body = segmentsText(segments, 0);
    }
  } else {
    const split = splitMentionText(message, ids, names);
    atSelf = split.atSelf;
    body = split.rest;
  }

  const text = String(body ?? '').replace(/^\s+/, '');
  const cmd = atSelf ? PERSONA_RE.exec(text) : null;
  if (!cmd) return { found: false, command: '', arg: '', strippedText: '', atSelf };
  const strippedText = text.trimEnd();
  const arg = text.slice(cmd[0].length).trim();
  return { found: true, command: PERSONA, arg, strippedText, atSelf };
}

export function personaUsageHint() {
  return '换人设直接发 `/persona 你是一只猫娘`（不用 @ 我）；恢复发 `/persona off`。';
}
