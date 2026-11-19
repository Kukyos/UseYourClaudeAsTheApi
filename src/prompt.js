// Converts Anthropic Messages and OpenAI Chat Completions requests into one
// normalized shape, then into the single user turn + system prompt that a
// headless Claude Code run takes.
//
// Normalized request:
//   { model, system, messages: [{ role: 'user'|'assistant', content: Block[] }],
//     tools: [{ name, description, input_schema }], toolChoice, jsonSchema, jsonMode, effort, stream }
// Blocks are Anthropic-shaped: text, image, document, tool_use, tool_result.

import { ClaudeError } from './claude.js';
import { toolSystemPrompt, renderToolCall } from './tools.js';

const invalid = (msg) => new ClaudeError(msg, { status: 400, type: 'invalid_request_error' });

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * Pick the --model value for a requested model name. Claude model ids and the
 * aliases opus/sonnet/haiku/fable pass through; anything else (e.g. "gpt-4o"
 * from an OpenAI-shaped app) uses the configured default.
 */
export function resolveModel(requested, config = {}) {
  if (config.forceModel) return config.forceModel;
  const r = String(requested || '').trim().toLowerCase();
  if (!r || r === 'default' || r === 'claude') return config.defaultModel || undefined;
  if (r.startsWith('claude-')) {
    // Generic aliases such as "claude-sonnet" or "claude-opus-latest" map to Claude Code aliases.
    const m = r.match(/^claude-(opus|sonnet|haiku|fable)(-latest)?$/);
    return m ? m[1] : r;
  }
  if (/^(opus|sonnet|haiku|fable)(\[1m\])?$/.test(r)) return r;
  return config.defaultModel || undefined;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function normalizeEffort(e) {
  if (!e) return undefined;
  const v = String(e).toLowerCase();
  if (v === 'minimal' || v === 'none') return 'low';
  return EFFORTS.has(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API -> normalized
// ---------------------------------------------------------------------------

function anthropicContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw invalid('messages[].content must be a string or an array of blocks');
  return content;
}

export function fromAnthropic(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid('messages: field required (a non-empty array)');
  }
  let system = '';
  if (typeof body.system === 'string') system = body.system;
  else if (Array.isArray(body.system)) system = body.system.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');

  const messages = body.messages.map((m) => {
    if (m.role !== 'user' && m.role !== 'assistant') throw invalid(`messages[].role must be "user" or "assistant", got "${m.role}"`);
    return { role: m.role, content: anthropicContent(m.content) };
  });

  let toolChoice = 'auto';
  const tc = body.tool_choice;
  if (tc?.type === 'any') toolChoice = 'required';
  else if (tc?.type === 'none') toolChoice = 'none';
  else if (tc?.type === 'tool' && tc.name) toolChoice = { name: tc.name };

  const tools = (body.tools || [])
    .filter((t) => t && t.name && (t.input_schema || !t.type || t.type === 'custom'))
    .map((t) => ({ name: t.name, description: t.description || '', input_schema: t.input_schema || { type: 'object' } }));

  const format = body.output_config?.format || body.output_format;
  const jsonSchema = format?.type === 'json_schema' ? format.schema : undefined;

  let effort = normalizeEffort(body.output_config?.effort);
  if (!effort && body.thinking?.type === 'enabled') {
    const b = body.thinking.budget_tokens || 0;
    effort = b >= 16000 ? 'high' : b >= 4000 ? 'medium' : 'low';
  }

  return { model: body.model, system, messages, tools, toolChoice, jsonSchema, jsonMode: false, effort, stream: !!body.stream };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API -> normalized
// ---------------------------------------------------------------------------

function openaiContent(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) throw invalid('messages[].content must be a string or an array of parts');
  const out = [];
  for (const part of content) {
    if (part.type === 'text' || part.type === 'input_text') out.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url' || part.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (url) out.push(imageFromUrl(url));
    } else if (part.type === 'file' && part.file?.file_data) {
      out.push(imageFromUrl(part.file.file_data, 'document'));
    }
  }
  return out;
}

function imageFromUrl(url, kind = 'image') {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) {
    const type = m[1] === 'application/pdf' ? 'document' : kind;
    return { type, source: { type: 'base64', media_type: m[1], data: m[2] } };
  }
  return { type: kind, source: { type: 'url', url } };
}

function parseArgs(str) {
  if (str && typeof str === 'object') return str;
  try {
    return JSON.parse(str || '{}');
  } catch {
    return { _raw: String(str) };
  }
}

export function fromOpenAI(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid('messages: field required (a non-empty array)');
  }
  const systemParts = [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };

  for (const m of body.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      const c = openaiContent(m.content);
      systemParts.push(c.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
    } else if (m.role === 'user') {
      push('user', openaiContent(m.content));
    } else if (m.role === 'assistant') {
      const blocks = openaiContent(m.content);
      for (const call of m.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: parseArgs(call.function?.arguments) });
      }
      if (m.function_call) blocks.push({ type: 'tool_use', id: 'legacy', name: m.function_call.name, input: parseArgs(m.function_call.arguments) });
      push('assistant', blocks);
    } else if (m.role === 'tool' || m.role === 'function') {
      const content = typeof m.content === 'string' ? m.content : openaiContent(m.content);
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id || 'legacy', name: m.name, content }]);
    } else {
      throw invalid(`Unsupported message role "${m.role}"`);
    }
  }
  if (!messages.length) throw invalid('messages must contain at least one user message');

  let tools = (body.tools || [])
    .filter((t) => t.type === 'function' && t.function?.name)
    .map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } }));
  if (!tools.length && Array.isArray(body.functions)) {
    tools = body.functions.map((f) => ({ name: f.name, description: f.description || '', input_schema: f.parameters || { type: 'object' } }));
  }

  let toolChoice = 'auto';
  const tc = body.tool_choice ?? body.function_call;
  if (tc === 'none') toolChoice = 'none';
  else if (tc === 'required') toolChoice = 'required';
  else if (tc && typeof tc === 'object') {
    const name = tc.function?.name || tc.name;
    if (name) toolChoice = { name };
  }

  const rf = body.response_format;
  const jsonSchema = rf?.type === 'json_schema' ? rf.json_schema?.schema : undefined;
  const jsonMode = rf?.type === 'json_object';

  return {
    model: body.model,
    system: systemParts.filter(Boolean).join('\n\n'),
    messages,
    tools,
    toolChoice,
    jsonSchema,
    jsonMode,
    effort: normalizeEffort(body.reasoning_effort || body.reasoning?.effort),
    stream: !!body.stream,
    includeUsage: !!body.stream_options?.include_usage,
  };
}

// ---------------------------------------------------------------------------
// Normalized -> Claude Code input
// ---------------------------------------------------------------------------

const MAX_FETCH_BYTES = 25 * 1024 * 1024;

/** Claude Code takes base64 media; download http(s) images and PDFs first. */
async function inlineMedia(block) {
  if (block.source?.type !== 'url') return block;
  let res;
  try {
    res = await fetch(block.source.url, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw invalid(`Could not download ${block.source.url}: ${err.message}`);
  }
  if (!res.ok) throw invalid(`Could not download ${block.source.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FETCH_BYTES) throw invalid(`${block.source.url} is larger than 25MB`);
  let mediaType = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!mediaType || mediaType === 'application/octet-stream') {
    mediaType = block.type === 'document' ? 'application/pdf' : 'image/png';
  }
  const type = mediaType === 'application/pdf' ? 'document' : block.type;
  return { type, source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } };
}

function isMedia(b) {
  return (b.type === 'image' || b.type === 'document') && b.source && b.source.type !== 'text';
}

function toolResultText(content, attach) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((b) => {
    if (b.type === 'text') return b.text;
    if (isMedia(b)) return attach(b);
    return JSON.stringify(b);
  }).join('\n');
}

/**
 * Build the single user turn and the system prompt for Claude Code.
 * Returns { content: Block[], system: string }.
 */
export async function buildClaudeInput(req) {
  const tools = req.toolChoice === 'none' ? [] : req.tools || [];
  const messages = req.messages;
  const last = messages[messages.length - 1];
  const hasToolBlocks = messages.some((m) => m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result'));

  const systemParts = [];
  if (req.system) systemParts.push(req.system);

  let content;
  const simple = messages.length === 1 && last.role === 'user' && !hasToolBlocks;

  if (simple) {
    // A single user message is sent as-is, preserving image/text order.
    content = [];
    for (const b of last.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'document' && b.source?.type === 'text') content.push({ type: 'text', text: b.source.data });
      else if (isMedia(b)) content.push(await inlineMedia(b));
    }
  } else {
    // Multi-turn: replay the conversation as a transcript inside one user turn.
    const attachments = [];
    const attach = (b) => {
      attachments.push(b);
      return `[attachment ${attachments.length}]`;
    };
    const names = new Map();
    const turns = messages.map((m) => {
      const parts = m.content.map((b) => {
        switch (b.type) {
          case 'text': return b.text;
          case 'image':
          case 'document':
            if (b.source?.type === 'text') return b.source.data;
            return attach(b);
          case 'tool_use':
            names.set(b.id, b.name);
            return renderToolCall(b);
          case 'tool_result': {
            const name = b.name || names.get(b.tool_use_id) || 'unknown';
            const err = b.is_error ? ' is_error="true"' : '';
            return `<tool_result name="${name}"${err}>\n${toolResultText(b.content, attach)}\n</tool_result>`;
          }
          default: return '';
        }
      }).filter(Boolean);
      return `<turn role="${m.role}">\n${parts.join('\n\n')}\n</turn>`;
    });

    content = [];
    for (let i = 0; i < attachments.length; i++) {
      content.push({ type: 'text', text: `Attachment ${i + 1}:` });
      content.push(await inlineMedia(attachments[i]));
    }
    content.push({ type: 'text', text: `<conversation>\n${turns.join('\n\n')}\n</conversation>` });

    systemParts.push(
      '# Conversation format\n' +
        'The user turn holds the conversation so far, oldest first, inside <conversation> tags. ' +
        'Each <turn> is one message; [attachment N] refers to the matching attachment shown before the conversation. ' +
        (last.role === 'assistant'
          ? 'The final assistant turn is unfinished: continue it from exactly where it stops, and output only the continuation (do not repeat what is already written).'
          : 'Write the assistant\'s reply to the final user turn.') +
        ' Output only the reply text itself, with no <turn> tags or role labels.',
    );
  }

  if (tools.length) systemParts.push(toolSystemPrompt(tools, req.toolChoice));
  if (req.jsonMode && !req.jsonSchema) {
    systemParts.push('# Output format\nRespond with a single valid JSON object and nothing else: no prose, no code fences.');
  }

  if (!content.length) throw invalid('The last message has no content');
  return { content, system: systemParts.join('\n\n') };
}
