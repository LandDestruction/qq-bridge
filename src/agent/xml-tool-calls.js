// 有些 OpenAI 兼容端点（本地 Qwen 等）不按接口回 tool_calls，而是把调用写进正文：
//   <tool_call>
//   <function=qq_get_unread_messages>
//   <parameter=key>group:100000001</parameter>
//   </function>
//   </tool_call>
// 这种正文以前会原样发进 QQ（用户看到一堆协议文本），或者被当成「没调工具」直接结束。
// 这里把这种文本解析成结构化调用，交给 transport 的 host 循环去真正执行。

const FUNCTION_TAG = /<function\s*=\s*([A-Za-z0-9_.:-]+)\s*>/gi;
const PARAM_TAG = /<parameter\s*=\s*([A-Za-z0-9_.:-]+)\s*>([\s\S]*?)<\/parameter>/gi;

function coerce(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^(true|false)$/i.test(text)) return /^true$/i.test(text);
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

/** 从正文里解析出 [{name, args}]（可能多条）。没有就叫空数组，绝不抛。 */
export function parseXmlToolCalls(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const matches = [];
  FUNCTION_TAG.lastIndex = 0;
  let m;
  while ((m = FUNCTION_TAG.exec(text))) matches.push({ name: m[1], index: m.index, end: m.index + m[0].length });
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const stop = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const block = text.slice(matches[i].end, stop);
    const args = {};
    PARAM_TAG.lastIndex = 0;
    let p;
    while ((p = PARAM_TAG.exec(block))) args[p[1]] = coerce(p[2]);
    out.push({ name: matches[i].name, args });
    void start;
  }
  return out;
}

/** 只保留非工具调用部分（发送前兜底用；正常路径应该已经执行掉调用）。 */
export function textWithoutXmlToolCalls(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = text.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, ' ');
  out = out.replace(/<function\s*=[A-Za-z0-9_.:-]+\s*>[\s\S]*?(?=<function\s*=|$)/gi, ' ');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
