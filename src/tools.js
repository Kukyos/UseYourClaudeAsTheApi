// Tool (function) calling, emulated on top of plain text.
//
// The tools a client sends are described to Claude in the system prompt, and it
// asks for a call by writing <tool_call>{"name": ..., "input": {...}}</tool_call>.
// The bridge parses those tags back into real tool_use / tool_calls objects, so
// SDK tool loops work as they would against the API.

import { randomBytes } from 'node:crypto';

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

export function newId(prefix) {
  return prefix + randomBytes(12).toString('hex');
}

export function renderToolCall(block) {
  return `${OPEN}${JSON.stringify({ name: block.name, input: block.input ?? {} })}${CLOSE}`;
}

export function toolSystemPrompt(tools, toolChoice) {
  const defs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  let rule = 'Call a tool only when it helps answer; otherwise reply normally.';
  if (toolChoice === 'required') rule = 'You must call at least one tool in this reply.';
  else if (toolChoice && typeof toolChoice === 'object') rule = `You must call the tool "${toolChoice.name}" in this reply.`;
  return [
    '# Tools',
    'You can call the tools below. Each is given as a name, a description and a JSON schema for its input.',
    `<tools>\n${JSON.stringify(defs, null, 2)}\n</tools>`,
    'To call a tool, write exactly:',
    `${OPEN}{"name": "<tool name>", "input": { ...arguments matching its input_schema... }}${CLOSE}`,
    'You may write a short sentence before your tool calls, and may make several calls in a row. ' +
      'After your last tool call, stop writing: end your reply there. ' +
      'The results come back in a later turn inside <tool_result> tags. Never write <tool_result> yourself and never guess a result.',
    rule,
  ].join('\n\n');
}

function parseCallJson(raw) {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1];
  try {
    const obj = JSON.parse(s);
    if (!obj || typeof obj.name !== 'string') return null;
    let input = obj.input ?? obj.arguments ?? obj.parameters ?? {};
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        input = { value: input };
      }
    }
    return { name: obj.name, input };
  } catch {
    return null;
  }
}

/**
 * Split model output into leading text and tool calls.
 * Returns { text, calls: [{ name, input }] }. Text after the calls is dropped.
 */
export function parseToolCalls(output) {
  const first = output.indexOf(OPEN);
  if (first === -1) return { text: output, calls: [] };
  const calls = [];
  let i = first;
  while (i !== -1) {
    const start = i + OPEN.length;
    let end = output.indexOf(CLOSE, start);
    const next = output.indexOf(OPEN, start);
    if (end === -1 || (next !== -1 && next < end)) end = next === -1 ? output.length : next;
    const call = parseCallJson(output.slice(start, end));
    if (call) calls.push(call);
    i = output.indexOf(OPEN, end);
  }
  if (!calls.length) return { text: output, calls: [] };
  return { text: output.slice(0, first).trimEnd(), calls };
}

/**
 * Streaming helper: passes text through until a <tool_call> tag starts, holding
 * back any partial tag so it never reaches the client.
 */
export class ToolCallFilter {
  constructor() {
    this.pending = '';
    this.stopped = false;
  }

  /** Returns the text that is safe to emit now. */
  push(chunk) {
    if (this.stopped) return '';
    this.pending += chunk;
    const idx = this.pending.indexOf(OPEN);
    if (idx !== -1) {
      this.stopped = true;
      const out = this.pending.slice(0, idx).trimEnd();
      this.pending = '';
      return out;
    }
    // Hold back the longest suffix that could be the start of "<tool_call>".
    let hold = 0;
    for (let k = Math.min(OPEN.length - 1, this.pending.length); k > 0; k--) {
      if (OPEN.startsWith(this.pending.slice(-k))) {
        hold = k;
        break;
      }
    }
    // Also hold trailing whitespace, which is dropped if a tool call follows.
    while (hold < this.pending.length && /\s/.test(this.pending[this.pending.length - hold - 1])) hold++;
    const out = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return out;
  }

  /** Call at the end of the stream to release text that turned out not to be a tag. */
  flush() {
    if (this.stopped) return '';
    const out = this.pending;
    this.pending = '';
    return out;
  }
}
