import type { ToolCall, ToolDef } from '../providers/types';
import { parseJsonLoose, uid } from '../util';

/** Text-protocol fallback for models without native tool calling (Qwen3-Coder style XML). */
export function toolsAsText(tools: ToolDef[]): string {
  const lines: string[] = [];
  lines.push('# Tool use');
  lines.push('You can call tools. To call a tool, write EXACTLY this format and then STOP your message (one tool call per message). The result will be sent back to you in the next message.');
  lines.push('');
  lines.push('<tool_call>');
  lines.push('<function=TOOL_NAME>');
  lines.push('<parameter=PARAM_NAME>');
  lines.push('value (raw text, no escaping, can span many lines)');
  lines.push('</parameter>');
  lines.push('</function>');
  lines.push('</tool_call>');
  lines.push('');
  lines.push('Never invent tool results. When the task is complete, answer normally without any tool call.');
  lines.push('');
  lines.push('## Available tools');
  for (const t of tools) {
    lines.push(`### ${t.name}`);
    lines.push(t.description);
    const props = t.parameters?.properties || {};
    const req: string[] = t.parameters?.required || [];
    const keys = Object.keys(props);
    if (keys.length) {
      lines.push('Parameters:');
      for (const k of keys) {
        const p = props[k];
        const type = p.type || (p.enum ? 'string' : 'any');
        const en = p.enum ? ` one of: ${p.enum.join(', ')}` : '';
        lines.push(`- ${k} (${type}${req.includes(k) ? ', required' : ''})${en}: ${p.description || ''}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function typesFor(tools: ToolDef[]) {
  const map = new Map<string, Record<string, string>>();
  for (const t of tools) {
    const props = t.parameters?.properties || {};
    const m: Record<string, string> = {};
    for (const k of Object.keys(props)) m[k] = props[k].type || 'string';
    map.set(t.name, m);
  }
  return map;
}

function trimNl(v: string) {
  return v.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

function coerce(value: string, type: string | undefined) {
  if (!type || type === 'string') return value;
  const t = value.trim();
  if (type === 'number' || type === 'integer') {
    const n = Number(t);
    return isNaN(n) ? t : n;
  }
  if (type === 'boolean') return /^(true|1|yes|tak)$/i.test(t);
  const parsed = parseJsonLoose(t);
  return parsed === undefined ? t : parsed;
}

const LONG_PARAMS = new Set(['content', 'new_text', 'old_text', 'command', 'code', 'text', 'script', 'todos', 'edits']);

/** Extracts tool calls written as text by the model. Returns the calls and the text with calls removed. */
export function parseTextToolCalls(text: string, tools: ToolDef[]): { calls: ToolCall[]; cleaned: string } {
  const names = new Set(tools.map((t) => t.name));
  const types = typesFor(tools);
  const calls: ToolCall[] = [];
  let cleaned = text;

  // 1) <tool_call> ... </tool_call> (JSON or <function=...>)
  const tcRe = /<tool_call>([\s\S]*?)(<\/tool_call>|$)/g;
  let m: RegExpExecArray | null;
  const removeRanges: [number, number][] = [];
  while ((m = tcRe.exec(text))) {
    const inner = m[1];
    const parsed = parseFunctionBlocks(inner, names, types);
    if (parsed.length) {
      calls.push(...parsed);
      removeRanges.push([m.index, m.index + m[0].length]);
      continue;
    }
    const json = parseJsonLoose(inner.trim());
    if (json && typeof json === 'object' && json.name && names.has(json.name)) {
      let args = json.arguments ?? json.parameters ?? json.input ?? {};
      if (typeof args === 'string') args = parseJsonLoose(args) ?? {};
      calls.push({ id: uid('call_'), name: json.name, input: args });
      removeRanges.push([m.index, m.index + m[0].length]);
    }
  }
  if (!calls.length) {
    // 2) bare <function=...> blocks
    const fnRe = /<function=([\w.-]+)>([\s\S]*?)(<\/function>|$)/g;
    while ((m = fnRe.exec(text))) {
      const parsed = parseFunctionBlocks(m[0], names, types);
      if (parsed.length) {
        calls.push(...parsed);
        removeRanges.push([m.index, m.index + m[0].length]);
      }
    }
  }
  if (!calls.length) {
    // 3) Cline style <tool_name><param>..</param></tool_name>
    for (const name of names) {
      const open = `<${name}>`;
      let from = 0;
      for (;;) {
        const s = text.indexOf(open, from);
        if (s < 0) break;
        const close = `</${name}>`;
        let e = text.indexOf(close, s);
        const end = e < 0 ? text.length : e + close.length;
        const block = text.slice(s + open.length, e < 0 ? text.length : e);
        const input = parseChildTags(block, types.get(name) || {});
        calls.push({ id: uid('call_'), name, input });
        removeRanges.push([s, end]);
        from = end;
      }
    }
  }
  if (removeRanges.length) {
    removeRanges.sort((a, b) => b[0] - a[0]);
    for (const [s, e] of removeRanges) cleaned = cleaned.slice(0, s) + cleaned.slice(e);
  }
  return { calls, cleaned: cleaned.trim() };
}

function parseFunctionBlocks(src: string, names: Set<string>, types: Map<string, Record<string, string>>): ToolCall[] {
  const out: ToolCall[] = [];
  const re = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (!names.has(name)) continue;
    const body = m[2];
    const input: Record<string, any> = {};
    const t = types.get(name) || {};
    const pre = /<parameter=([\w.-]+)>/g;
    const starts: { key: string; start: number; tagEnd: number }[] = [];
    let p: RegExpExecArray | null;
    while ((p = pre.exec(body))) starts.push({ key: p[1], start: p.index, tagEnd: p.index + p[0].length });
    for (let i = 0; i < starts.length; i++) {
      const { key, tagEnd } = starts[i];
      const nextStart = i + 1 < starts.length ? starts[i + 1].start : body.length;
      let seg = body.slice(tagEnd, nextStart);
      const closeIdx = seg.lastIndexOf('</parameter>');
      if (closeIdx >= 0) seg = seg.slice(0, closeIdx);
      input[key] = coerce(trimNl(seg), t[key]);
    }
    out.push({ id: uid('call_'), name, input });
  }
  return out;
}

function parseChildTags(block: string, types: Record<string, string>): Record<string, any> {
  const input: Record<string, any> = {};
  let pos = 0;
  for (;;) {
    const open = /<([a-z_][\w-]*)>/i.exec(block.slice(pos));
    if (!open) break;
    const key = open[1];
    const valStart = pos + open.index + open[0].length;
    const close = `</${key}>`;
    const end = LONG_PARAMS.has(key) ? block.lastIndexOf(close) : block.indexOf(close, valStart);
    if (end < valStart) {
      input[key] = coerce(trimNl(block.slice(valStart)), types[key]);
      break;
    }
    input[key] = coerce(trimNl(block.slice(valStart, end)), types[key]);
    pos = end + close.length;
  }
  return input;
}

export function looksLikeTextToolCall(text: string) {
  return /<tool_call>|<function=[\w.-]+>/.test(text);
}
