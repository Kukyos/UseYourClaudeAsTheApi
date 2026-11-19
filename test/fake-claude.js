#!/usr/bin/env node
// A stand-in for the `claude` CLI that speaks the same stream-json protocol.
// What it does depends on keywords in the prompt (see below). Each run's argv
// and stdin are appended to $FAKE_CLAUDE_LOG when set.

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log(`Options:
  --tools <tools...>  Built-in tools
  --safe-mode
  --no-session-persistence
  --include-partial-messages
  --input-format <format>  "text" (default), or "stream-json"
  --json-schema <schema>
  --effort <level>
  --strict-mcp-config`);
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const msg = JSON.parse(input.trim().split('\n')[0]);
  const content = msg.message.content;
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = content.filter((b) => b.type === 'image').length;
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, content, cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null }) + '\n');
  }

  const model = flag('--model') === 'haiku' ? 'claude-haiku-test' : 'claude-sonnet-test';
  const out = (o) => process.stdout.write(JSON.stringify({ session_id: 's', parent_tool_use_id: null, ...o }) + '\n');
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 7 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  out({ type: 'system', subtype: 'init', model });

  if (text.includes('NOLOGIN')) {
    process.stderr.write('Invalid API key · Please run /login\n');
    process.exit(1);
  }
  if (text.includes('RATELIMIT')) {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 120 } });
    out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 5pm", usage });
    process.exit(1);
  }
  if (text.includes('SLOW')) await sleep(5000);

  let chunks;
  if (flag('--json-schema')) {
    out({ type: 'assistant', message: { model, content: [{ type: 'tool_use', name: 'StructuredOutput', input: { name: 'Ada', age: 36 } }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { name: 'Ada', age: 36 }, stop_reason: 'end_turn', usage });
    return;
  } else if (text.includes('TOOL')) {
    chunks = ['Let me check the weather.\n<tool', '_call>{"name": "get_weather", ', '"input": {"city": "Paris"}}</tool_call>'];
  } else if (text.includes('ANGLE')) {
    chunks = ['a < b and <tool', 'box> is fine'];
  } else {
    chunks = ['Echo', `: ${text.split('\n').pop()}`];
    if (images) chunks.push(` [${images} image(s)]`);
  }

  out({ type: 'stream_event', event: { type: 'message_start', message: { model, usage } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const c of chunks) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } } });
    await sleep(5);
  }
  out({ type: 'assistant', message: { model, content: [{ type: 'text', text: chunks.join('') }] } });
  out({ type: 'stream_event', event: { type: 'message_stop' } });
  out({ type: 'result', subtype: 'success', is_error: false, result: chunks.join(''), stop_reason: 'end_turn', usage, total_cost_usd: 0.001 });
});
