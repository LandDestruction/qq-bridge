// 本地/第三方 OpenAI 兼容端点常见问题：模型把工具调用写成**正文里的 XML**，例如
//   <tool_call>\n<function=qq_get_unread_messages>\n<parameter=key>group:1</parameter>\n</tool_call>
// 这类端点只在 tool_calls 字段里回结构化调用，正文里的标记不会被识别 → 原样发进 QQ，
// 用户看到一堆协议文本。这里在发送前把标记剥掉；剥完为空就当这轮没话说，不发。

const FENCED_TOOL_CALL = /```(?:tool_call|tool-calls|json)?\s*<tool_call>[\s\S]*?<\/tool_call>\s*```/gi;
const TOOL_CALL_BLOCK = /<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi;
const FUNCTION_LINE = /^\s*<function=[^>\n]*>.*$/gim;
const PARAM_LINE = /^\s*<parameter=[^>\n]*>[\s\S]*?<\/parameter>\s*$/gim;
const ORPHAN_TAG = /<\/?(?:tool_call|function|parameter)(?:=[^>\n]*)?>/gi;

export function stripToolCallMarkup(input) {
  if (typeof input !== 'string' || !input) return '';
  let text = input;
  text = text.replace(FENCED_TOOL_CALL, '\n');
  text = text.replace(TOOL_CALL_BLOCK, '\n');
  text = text.replace(FUNCTION_LINE, '');
  text = text.replace(PARAM_LINE, '');
  text = text.replace(ORPHAN_TAG, '');
  // 模型常常只写到一半就停（<tool_call> 没有闭合），剩下的半截标签也要清干净。
  text = text.replace(/<tool_call[\s\S]*$/i, '');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

export function looksLikeToolCallOnly(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return false;
  return /<tool_call>|<function=|<parameter=/i.test(raw) && stripToolCallMarkup(raw) === '';
}
